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
        self.output = contextlib.redirect_stdout(io.StringIO())
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
        with patch.object(classifier.time, "monotonic", side_effect=[0, 0, 601]), \
                patch.object(classifier, "candidate_page", return_value=[paper(501)]) as read, \
                patch.object(classifier, "save_classifications", return_value={"updated": 1, "stale": 0}):
            result = classifier.run_classification(after_id=500, reclassify_all=True)
        read.assert_called_once_with(500, True)
        self.assertFalse(result["complete"])
        self.assertEqual(result["cursor"], 501)
        self.assertEqual(result["updated"], 1)

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


if __name__ == "__main__":
    unittest.main()
