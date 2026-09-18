"""Durable classification batches must progress without re-reading the catalog."""
import contextlib
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import classify_papers as classifier


def paper(identifier=1, **changes):
    return {"id": identifier, "pmid": str(identifier), "title": "Clinical observations",
            "abstract": "", "mesh_terms": [], "pub_types": ["Journal Article"],
            "classification_source_hash": "a" * 64, **changes}


class ClassificationBatchTests(unittest.TestCase):
    def setUp(self):
        self.log = io.StringIO()
        self.output = contextlib.redirect_stdout(self.log)
        self.output.__enter__()

    def tearDown(self):
        self.output.__exit__(None, None, None)

    def test_every_page_commits_before_next_read_and_other_is_saved(self):
        events = []
        pages = [[paper(2), paper(400, mesh_terms=["Retrospective Studies"])], []]

        def read(cursor, all_records):
            events.append(("read", cursor, all_records))
            return pages.pop(0)

        def save(results):
            events.append(("save", results))
            return {"updated": len(results), "stale": 0}

        with patch.object(classifier, "candidate_page", side_effect=read), \
                patch.object(classifier, "save_classifications", side_effect=save):
            result = classifier.run_classification()
        self.assertEqual([event[0] for event in events], ["read", "save", "read"])
        self.assertEqual(events[1][1], [
            {"id": 2, "source_hash": "a" * 64, "study_type": "other"},
            {"id": 400, "source_hash": "a" * 64, "study_type": "retrospective"},
        ])
        self.assertEqual(events[2], ("read", 400, False))
        self.assertEqual(result["updated"], 2)
        self.assertTrue(result["complete"])

    def test_failed_commit_stops_before_cursor_advance_or_next_read(self):
        with patch.object(classifier, "candidate_page", return_value=[paper()]) as read, \
                patch.object(classifier, "save_classifications", side_effect=RuntimeError("save unavailable")):
            with self.assertRaisesRegex(RuntimeError, "save unavailable"):
                classifier.run_classification()
        read.assert_called_once_with(0, False)

    def test_budget_preserves_saved_progress_and_explicit_resume_cursor(self):
        with patch.object(classifier.time, "monotonic", side_effect=[0, 0, 0, 601]), \
                patch.object(classifier, "candidate_page", return_value=[paper(501)]) as read, \
                patch.object(classifier, "save_classifications", return_value={"updated": 1, "stale": 0}):
            result = classifier.run_classification(after_id=500, reclassify_all=True)
        read.assert_called_once_with(500, True)
        self.assertFalse(result["complete"])
        self.assertEqual(result["cursor"], 501)
        self.assertEqual(result["updated"], 1)

    def test_hundred_row_read_is_acknowledged_in_at_most_25_row_writes(self):
        events = []

        def read(cursor, all_records):
            events.append(("read", cursor))
            return [paper(i) for i in range(1, 101)] if cursor == 0 else []

        def save(results):
            events.append(("save", [row["id"] for row in results]))
            return {"updated": len(results), "stale": 0}

        with patch.object(classifier, "candidate_page", side_effect=read), \
                patch.object(classifier, "save_classifications", side_effect=save):
            result = classifier.run_classification()
        self.assertEqual(events, [("read", 0), ("save", list(range(1, 26))),
                                  ("save", list(range(26, 51))), ("save", list(range(51, 76))),
                                  ("save", list(range(76, 101))), ("read", 100)])
        self.assertEqual(result["processed"], 100)
        self.assertEqual(result["cursor"], 100)
        self.assertTrue(result["complete"])

    def test_budget_mid_page_keeps_unwritten_rows_pending_for_next_run(self):
        now = [0]
        saved = []

        def read(cursor, all_records):
            return [paper(i) for i in range(cursor + 1, 61) if i not in saved]

        def save(results):
            saved.extend(row["id"] for row in results)
            now[0] = 601
            return {"updated": len(results), "stale": 0}

        with patch.object(classifier.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(classifier, "candidate_page", side_effect=read) as get, \
                patch.object(classifier, "save_classifications", side_effect=save):
            result = classifier.run_classification()
            self.assertFalse(result["complete"])
            self.assertEqual((result["processed"], result["cursor"]), (25, 25))
            get.assert_called_once_with(0, False)
            # A normal run starts at zero and sees only records still pending.
            now[0] = 0
            resumed = classifier.run_classification(max_seconds=1200)
        self.assertTrue(resumed["complete"])
        self.assertEqual(resumed["updated"], 35)
        self.assertEqual(saved, list(range(1, 61)))

    def test_later_subbatch_failure_preserves_acknowledged_cursor(self):
        with patch.object(classifier, "candidate_page", return_value=[paper(i) for i in range(1, 61)]) as read, \
                patch.object(classifier, "save_classifications", side_effect=[
                    {"updated": 25, "stale": 0}, RuntimeError("save unavailable"),
                ]) as save:
            with self.assertRaisesRegex(RuntimeError, "save unavailable"):
                classifier.run_classification()
        read.assert_called_once_with(0, False)
        self.assertEqual([[row["id"] for row in call.args[0]] for call in save.call_args_list],
                         [list(range(1, 26)), list(range(26, 51))])
        self.assertIn("25 processed, cursor 25", self.log.getvalue())
        self.assertIn("stopped after 25 acknowledged records; cursor 25", self.log.getvalue())

    @patch("classify_papers.time.sleep")
    def test_confirmed_transaction_error_splits_and_keeps_smaller_cap(self, sleep):
        for code in ("57014", "40P01"):
            with self.subTest(code=code):
                committed = []

                def post(url, *, headers, json, timeout):
                    rows = json["p_results"]
                    if len(rows) > 13:
                        return Mock(status_code=500, json=Mock(return_value={"code": code, "message": "private SQL"}))
                    committed.extend(row["id"] for row in rows)
                    return Mock(status_code=200, json=Mock(return_value={"updated": len(rows), "stale": 0}))

                with patch.object(classifier, "candidate_page", side_effect=[
                    [paper(i) for i in range(1, 101)], [paper(i) for i in range(101, 127)], [],
                ]) as read, patch.object(classifier.requests, "post", side_effect=post) as write:
                    result = classifier.run_classification()
                sizes = [len(call.kwargs["json"]["p_results"]) for call in write.call_args_list]
                self.assertEqual(sizes[:4], [25, 25, 12, 13])
                self.assertTrue(all(size <= 13 for size in sizes[2:]))
                self.assertEqual(write.call_args_list[0].kwargs["json"], write.call_args_list[1].kwargs["json"])
                self.assertEqual(committed, list(range(1, 127)))
                self.assertEqual([call.args for call in read.call_args_list], [(0, False), (100, False), (126, False)])
                self.assertEqual((result["updated"], result["cursor"]), (126, 126))
                self.assertTrue(result["complete"])
                self.assertNotIn("private", self.log.getvalue())

    @patch("classify_papers.time.sleep")
    def test_known_error_on_single_record_is_terminal_and_bounded(self, sleep):
        error = Mock(status_code=500, json=Mock(return_value={"code": "57014"}))
        with patch.object(classifier, "candidate_page", return_value=[paper(i) for i in range(1, 5)]) as read, \
                patch.object(classifier.requests, "post", return_value=error) as write:
            with self.assertRaisesRegex(classifier.ClassificationSaveError, "2 attempts .*code 57014"):
                classifier.run_classification()
        self.assertEqual([len(call.kwargs["json"]["p_results"]) for call in write.call_args_list],
                         [4, 4, 2, 2, 1, 1])
        read.assert_called_once_with(0, False)
        self.assertIn("stopped after 0 acknowledged records; cursor 0", self.log.getvalue())

    @patch("classify_papers.time.sleep")
    def test_later_split_child_failure_keeps_only_prior_child_acknowledged(self, sleep):
        responses = [
            Mock(status_code=500, json=Mock(return_value={"code": "57014"})),
            Mock(status_code=500, json=Mock(return_value={"code": "57014"})),
            Mock(status_code=200, json=Mock(return_value={"updated": 2, "stale": 0})),
            *[Mock(status_code=500, json=Mock(return_value={"code": "XX000"})) for _ in range(4)],
        ]
        with patch.object(classifier, "candidate_page", return_value=[paper(i) for i in range(1, 5)]) as read, \
                patch.object(classifier.requests, "post", side_effect=responses) as write:
            with self.assertRaisesRegex(classifier.ClassificationSaveError, "code XX000"):
                classifier.run_classification()
        payloads = [[row["id"] for row in call.kwargs["json"]["p_results"]] for call in write.call_args_list]
        self.assertEqual(payloads, [[1, 2, 3, 4], [1, 2, 3, 4], [1, 2], *[[3, 4]] * 4])
        read.assert_called_once_with(0, False)
        self.assertIn("2 processed, cursor 2", self.log.getvalue())
        self.assertIn("stopped after 2 acknowledged records; cursor 2", self.log.getvalue())

    @patch("classify_papers.time.sleep")
    def test_budget_is_checked_before_retrying_split_children(self, sleep):
        now = [0]

        def post(*args, **kwargs):
            now[0] = 601
            return Mock(status_code=500, json=Mock(return_value={"code": "57014"}))

        with patch.object(classifier.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(classifier, "candidate_page", return_value=[paper(i) for i in range(1, 26)]) as read, \
                patch.object(classifier.requests, "post", side_effect=post) as write:
            result = classifier.run_classification()
        self.assertEqual(write.call_count, 2)
        read.assert_called_once_with(0, False)
        self.assertFalse(result["complete"])
        self.assertEqual((result["updated"], result["processed"], result["cursor"]), (0, 0, 0))

    @patch("classify_papers.time.sleep")
    def test_unknown_error_codes_never_trigger_splitting(self, sleep):
        for code in ("XX000", "PGRST003", "57014\n", None):
            with self.subTest(code=code):
                error = Mock(status_code=500, json=Mock(return_value={"code": code, "message": "private SQL"}))
                with patch.object(classifier, "candidate_page", return_value=[paper(i) for i in range(1, 26)]) as read, \
                        patch.object(classifier.requests, "post", return_value=error) as write:
                    with self.assertRaisesRegex(classifier.ClassificationSaveError, "4 attempts") as caught:
                        classifier.run_classification()
                self.assertEqual([len(call.kwargs["json"]["p_results"]) for call in write.call_args_list], [25] * 4)
                read.assert_called_once_with(0, False)
                self.assertNotIn("private", str(caught.exception))

    def test_source_changed_during_processing_is_deferred_not_counted_saved(self):
        with patch.object(classifier, "candidate_page", side_effect=[[paper()], []]), \
                patch.object(classifier, "save_classifications", return_value={"updated": 0, "stale": 1}):
            result = classifier.run_classification()
        self.assertEqual((result["processed"], result["updated"], result["stale"]), (1, 0, 1))

    def test_candidate_rpc_is_bounded_and_snapshot_ids_advance(self):
        with patch.object(classifier, "sb_get", return_value=[paper(55)]) as get:
            self.assertEqual(classifier.candidate_page(50, True), [paper(55)])
        self.assertEqual(get.call_args.args, ("rpc/classification_candidates", {
            "p_after_id": "50", "p_limit": "100", "p_reclassify_all": "true"}))
        for invalid in ({}, [paper(0)], [paper(True)], [paper("1")],
                        [paper(2), paper(1)], [paper(), paper()],
                        [paper(classification_source_hash="invalid")], [None],
                        [paper(i) for i in range(1, 102)]):
            with self.subTest(invalid=invalid), patch.object(classifier, "sb_get", return_value=invalid):
                with self.assertRaises(ValueError):
                    classifier.candidate_page(0)

    def test_normal_mode_cannot_skip_pending_records_using_manual_cursor(self):
        with patch.dict(os.environ, {"CLASSIFICATION_AFTER_ID": "500", "RECLASSIFY_ALL": "false"}), \
                patch.multiple(classifier, SUPABASE_URL="https://example.test", SUPABASE_KEY="fixture"), \
                patch.object(classifier, "run_classification") as run:
            with self.assertRaisesRegex(SystemExit, "only for an explicit"):
                classifier.main()
        run.assert_not_called()


class ClassificationSaveTests(unittest.TestCase):
    def response(self, status, outcome=None):
        return Mock(status_code=status, json=Mock(return_value=outcome))

    @patch("classify_papers.time.sleep")
    def test_uncertain_commit_retries_identical_snapshot_assignments(self, sleep):
        first = self.response(504)
        second = self.response(200, {"updated": 1, "stale": 0})
        results = [{"id": 5, "source_hash": "a" * 64, "study_type": "other"}]
        with patch.object(classifier.requests, "post", side_effect=[first, second]) as post:
            self.assertEqual(classifier.save_classifications(results), {"updated": 1, "stale": 0})
        self.assertEqual(post.call_count, 2)
        self.assertTrue(all(call.kwargs["json"] == {"p_results": results} for call in post.call_args_list))
        first.close.assert_called_once()
        second.close.assert_called_once()

    @patch("classify_papers.time.sleep")
    def test_rejection_is_not_retried_and_transport_failure_is_redacted(self, sleep):
        with patch.object(classifier.requests, "post", return_value=self.response(403)) as post:
            with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                classifier.save_classifications([])
        post.assert_called_once()
        sleep.assert_not_called()
        with patch.object(classifier.requests, "post", side_effect=requests.Timeout("private token url")) as post:
            with self.assertRaisesRegex(RuntimeError, "4 attempts \\(timeout\\)") as caught:
                classifier.save_classifications([])
        self.assertEqual(post.call_count, 4)
        self.assertNotIn("private", str(caught.exception))

    def test_invalid_acknowledgement_never_marks_batch_saved(self):
        for outcome in ({}, {"updated": True, "stale": 0}, {"updated": 0, "stale": 0},
                        {"updated": -1, "stale": 2}, {"updated": 2, "stale": 0}):
            with self.subTest(outcome=outcome), \
                    patch.object(classifier.requests, "post", return_value=self.response(200, outcome)):
                with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                    classifier.save_classifications([{"id": 1}])

    @patch("classify_papers.time.sleep")
    def test_save_reports_only_allowlisted_codes_and_ignores_private_json(self, sleep):
        for code, expected, attempts in (("57014", "57014", 2), ("40P01", "40P01", 2),
                                         ("PGRST003", "PGRST003", 4), ("57014 private-key", None, 4),
                                         (57014, None, 4), (["57014"], None, 4)):
            with self.subTest(code=code):
                response = self.response(500, {"code": code, "message": "private message", "details": "private SQL"})
                with patch.object(classifier.requests, "post", return_value=response) as post:
                    with self.assertRaises(classifier.ClassificationSaveError) as caught:
                        classifier.save_classifications([{"id": 1}])
                self.assertEqual(caught.exception.code, expected)
                detail = "HTTP 500" + (f" code {expected}" if expected else "")
                self.assertEqual(str(caught.exception), f"Classification save failed after {attempts} attempts ({detail})")
                self.assertEqual(post.call_count, attempts)

    @patch("classify_papers.time.sleep")
    def test_non_json_error_keeps_http_status_and_never_gets_split_code(self, sleep):
        response = self.response(500)
        response.json.side_effect = ValueError("private body")
        with patch.object(classifier.requests, "post", return_value=response):
            with self.assertRaises(classifier.ClassificationSaveError) as caught:
                classifier.save_classifications([{"id": 1}])
        self.assertIsNone(caught.exception.code)
        self.assertEqual(str(caught.exception), "Classification save failed after 4 attempts (HTTP 500)")

    @patch("classify_papers.time.sleep")
    def test_timeout_does_not_reuse_previous_transaction_code(self, sleep):
        with patch.object(classifier.requests, "post", side_effect=[
            self.response(500, {"code": "57014"}), requests.Timeout("private"),
            requests.Timeout("private"), requests.Timeout("private"),
        ]):
            with self.assertRaises(classifier.ClassificationSaveError) as caught:
                classifier.save_classifications([{"id": 1}])
        self.assertIsNone(caught.exception.code)
        self.assertEqual(str(caught.exception), "Classification save failed after 4 attempts (timeout)")


if __name__ == "__main__":
    unittest.main()
