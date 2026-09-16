"""Synthetic summary scheduling: no publisher, cloud, credentials or model requests."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import runpy
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import institution_worker as worker
from summary_queue import prepare_summary_attempts, record_summary_attempt, run_summary_queue


class SummaryQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        (self.directory / "documents").mkdir()
        (self.directory / "cloud-archive").mkdir()
        self.db_path = self.directory / "queue.sqlite3"
        self.db = sqlite3.connect(self.db_path)
        prepare_summary_attempts(self.db)
        self.monotonic = 1000
        self.now = 100000
        self.generated, self.published, self.statuses = [], [], []
        self.publish_errors = {}
        self.model_errors = {}
        self.body = "This synthetic article describes the study methods and results. " * 50
        self.document = {**worker.parse_document(("<article><h2>Methods</h2><p>" + self.body +
                         "</p><h2>Results</h2><p>Study results were reported.</p></article>").encode()),
                         "source_url": "https://example.test/article"}
        outer = self

        class Service:
            summary_deadline = None

            def rpc(self, name, **values):
                outer.assertEqual(name, "publish_institution_summary")
                pmid = values["p_pmid"]
                if pmid in outer.publish_errors:
                    raise outer.publish_errors[pmid]
                outer.published.append(values)

            def status(self, *args):
                outer.statuses.append(args)

        self.service = Service()
        self.dependencies = {"clock": lambda: self.monotonic, "wall_clock": lambda: self.now,
                             "generate_summary": self.generate,
                             "validate_cached_summary": self.validate,
                             "literature_inference_scope": lambda directory: contextlib.nullcontext()}

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def paper(self, number, pub_date="2020-01-01", ready=False, archive=False):
        paper = {"pmid": str(number), "title": "Synthetic study " + str(number),
                 "doi": "10.1000/study-" + str(number), "pub_date": pub_date,
                 "fulltext_available": ready}
        if ready:
            paper.update(summary_basis="fulltext", summary_source_hash=self.source_hash(paper),
                         summarized_at="2026-09-01T00:00:00Z", summary_model="prior-model",
                         summary_ko="첫 줄.\n두 번째 줄.\n세 번째 줄.")
        destination = "cloud-archive" if archive else "documents"
        saved = {"paper": paper, "document": self.document} if archive else {**paper, "document": self.document}
        worker.save_json(self.directory / destination / (str(number) + ".json"), saved)
        return paper

    def source_hash(self, paper, document=None):
        document = document or self.document
        return hashlib.sha256(("fulltext\n" + paper["title"] + "\n" + document["content_text"]).encode()).hexdigest()

    def summary(self, paper, document=None):
        return {"summary_ko": "첫 줄.\n두 번째 줄.\n세 번째 줄.",
                "structured_data": dict.fromkeys(("study_design", "sample_size", "key_finding", "population"), "Not reported"),
                "qa_data": [{"q": "연구의 한계는?", "a": "Not reported"}], "clinical_relevance": 3,
                "summary_model": worker.MODEL_LABEL, "summary_source_hash": self.source_hash(paper, document)}

    def validate(self, summary, paper, document):
        # The real publication/evidence validator has its own tests. This seam checks
        # that scheduling always calls it and actually publishes its normalized output.
        if (summary.get("invalid") or summary.get("summary_model") != worker.MODEL_LABEL
                or summary.get("summary_source_hash") != self.source_hash(paper, document)):
            raise ValueError("Synthetic cache validation failure")
        return {**summary, "summary_ko": summary["summary_ko"].strip()}

    def generate(self, paper, document, *, deadline, cache_path):
        self.generated.append((paper["pmid"], deadline, cache_path))
        if paper["pmid"] in self.model_errors:
            raise self.model_errors[paper["pmid"]]
        return self.summary(paper, document)

    def run_queue(self, papers, seconds=2000, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            counts = run_summary_queue(self.directory, self.monotonic + seconds, self.service, self.db,
                                       papers, dependencies=self.dependencies, **kwargs)
        self.output = output.getvalue()
        return counts

    def cache(self, paper, summary=None):
        path = self.directory / "documents" / (paper["pmid"] + ".summary.json")
        worker.save_json(path, summary or self.summary(paper))
        return path

    def test_old_state_upgrade_preserves_collection_and_summary_queues(self):
        self.db.execute("INSERT INTO attempts VALUES('1','retryable_error',109000)")
        self.db.execute("CREATE TABLE collection_attempts(pmid TEXT PRIMARY KEY,status TEXT,next_retry REAL)")
        self.db.execute("INSERT INTO collection_attempts VALUES('1','access_required',700000)")
        self.db.execute("DROP TABLE summary_retry_metadata")
        self.db.commit()
        prepare_summary_attempts(self.db)
        prepare_summary_attempts(self.db)
        self.assertEqual(self.db.execute("SELECT * FROM attempts").fetchall(), [("1", "retryable_error", 109000)])
        self.assertEqual(self.db.execute("SELECT * FROM collection_attempts").fetchall(), [("1", "access_required", 700000)])
        self.assertEqual(self.db.execute("SELECT count(*) FROM summary_retry_metadata").fetchone()[0], 0)
        self.assertEqual([r[1] for r in self.db.execute("PRAGMA table_info(attempts)")], ["pmid", "status", "next_retry"])

    def test_progressive_backoff_persists_caps_and_resets_without_touching_collection(self):
        self.db.execute("CREATE TABLE collection_attempts(pmid TEXT PRIMARY KEY,status TEXT,next_retry REAL)")
        self.db.execute("INSERT INTO collection_attempts VALUES('1','access_required',700000)")
        self.db.commit()
        for delay in (900, 3600, 21600, 86400, 86400):
            retry = record_summary_attempt(self.db, "1", "a" * 64, "summary_validation", self.now)
            self.assertEqual(retry, self.now + delay)
            self.db.close()
            self.db = sqlite3.connect(self.db_path)
            prepare_summary_attempts(self.db)
            self.now = retry
        self.assertEqual(record_summary_attempt(self.db, "1", "b" * 64, "summary_validation", self.now), self.now + 900)
        self.assertEqual(record_summary_attempt(self.db, "1", "b" * 64, "publication_unavailable", self.now), self.now + 900)
        self.assertEqual(record_summary_attempt(self.db, "1", "b" * 64, "ready", self.now), 0)
        self.assertEqual(record_summary_attempt(self.db, "1", "b" * 64, "summary_validation", self.now), self.now + 900)
        self.assertEqual(self.db.execute("SELECT * FROM collection_attempts").fetchall(), [("1", "access_required", 700000)])

    def test_first_summaries_precede_newer_refresh_and_untried_precede_failed(self):
        refresh = self.paper(1, "2026-09-15", ready=True)
        failed = self.paper(2, "2026-09-14")
        first = self.paper(3, "2001-01-01")
        newer_first = self.paper(4, "2020-01-01")
        record_summary_attempt(self.db, "2", self.source_hash(failed), "summary_validation", self.now - 2000)
        counts = self.run_queue([refresh, failed, first, newer_first, first])
        self.assertEqual([row[0] for row in self.generated], ["4", "3", "2", "1"])
        self.assertEqual((counts["completed"], counts["first_completed"], counts["updated"]), (4, 3, 1))
        self.assertIn("first summary published", self.output)
        self.assertIn("existing summary refreshed", self.output)

    def test_legacy_retry_is_honored_and_changed_source_bypasses_only_its_own_backoff(self):
        legacy = self.paper(1)
        revised = self.paper(2)
        self.db.execute("INSERT INTO attempts VALUES('1','retryable_error',109000)")
        self.db.commit()
        record_summary_attempt(self.db, "2", "b" * 64, "summary_validation", self.now)
        counts = self.run_queue([legacy, revised])
        self.assertEqual([row[0] for row in self.generated], ["2"])
        self.assertEqual(counts["deferred"], 1)
        self.assertEqual(self.db.execute("SELECT consecutive_failures FROM summary_retry_metadata WHERE pmid='2'").fetchone()[0], 0)

    def test_due_failure_rotates_behind_a_paper_yielded_in_an_earlier_turn(self):
        recent = self.paper(1)
        older = self.paper(2)
        record_summary_attempt(self.db, "1", self.source_hash(recent), "summary_validation", self.now - 1000)
        record_summary_attempt(self.db, "2", self.source_hash(older), "budget_yield", self.now - 2000)
        self.run_queue([recent, older])
        self.assertEqual([row[0] for row in self.generated], ["2", "1"])

    def test_stale_cloud_source_counts_as_first_ready_for_the_current_original(self):
        paper = self.paper(1, ready=True)
        paper["summary_source_hash"] = "b" * 64
        counts = self.run_queue([paper])
        self.assertEqual((counts["first_completed"], counts["updated"]), (1, 0))

    def test_validation_log_contains_only_claim_names_not_original_or_error_body(self):
        paper = self.paper(1)
        private = "SYNTHETIC-PRIVATE-CONTENT"
        self.model_errors["1"] = ValueError("Number absent from cited source for sample_size " + private)
        counts = self.run_queue([paper])
        self.assertEqual(counts["failed"], 1)
        self.assertIn("claims sample_size", self.output)
        self.assertNotIn(private, self.output)

    def test_per_paper_budget_yields_then_continues_and_preserves_notes_and_original(self):
        first, second = self.paper(1), self.paper(2)
        notes = self.directory / "documents/1.notes.json"
        worker.save_json(notes, {"notes": ["synthetic evidence checkpoint"]})
        original = (self.directory / "documents/1.json").read_bytes()

        def generate(paper, document, **kwargs):
            self.assertLessEqual(kwargs["deadline"], self.monotonic + 405)
            if paper["pmid"] == "1":
                self.generated.append(("1", kwargs["deadline"], kwargs["cache_path"]))
                self.monotonic = kwargs["deadline"]
                raise worker.SummaryBudgetExpired()
            return self.generate(paper, document, **kwargs)

        self.dependencies["generate_summary"] = generate
        counts = self.run_queue([first, second], seconds=1000)
        self.assertEqual((counts["yielded"], counts["completed"]), (1, 1))
        self.assertEqual([row["p_pmid"] for row in self.published], ["2"])
        self.assertEqual((self.directory / "documents/1.json").read_bytes(), original)
        self.assertEqual(json.loads(notes.read_text())["notes"], ["synthetic evidence checkpoint"])
        self.assertEqual(self.db.execute("SELECT reason,consecutive_failures FROM summary_retry_metadata WHERE pmid='1'").fetchone(), ("budget_yield", 0))
        self.assertEqual(self.db.execute("SELECT next_retry FROM attempts WHERE pmid='1'").fetchone()[0], self.now + 60)

    def test_global_budget_yield_does_not_start_another_paper(self):
        first, second = self.paper(1), self.paper(2)

        def generate(paper, document, **kwargs):
            self.generated.append((paper["pmid"], kwargs["deadline"], kwargs["cache_path"]))
            self.monotonic = kwargs["deadline"]
            raise worker.SummaryBudgetExpired()

        self.dependencies["generate_summary"] = generate
        counts = self.run_queue([first, second], seconds=100)
        self.assertEqual([row[0] for row in self.generated], ["1"])
        self.assertEqual(counts["yielded"], 1)
        self.assertIsNone(self.db.execute("SELECT * FROM attempts WHERE pmid='2'").fetchone())
        self.assertIsNone(self.service.summary_deadline)

    def test_runtime_failure_and_status_outage_do_not_abort_following_paper(self):
        first, second = self.paper(1), self.paper(2)
        self.model_errors["1"] = RuntimeError("Synthetic inference outage")
        self.service.status = Mock(side_effect=RuntimeError("Synthetic status outage"))
        counts = self.run_queue([first, second])
        self.assertEqual((counts["failed"], counts["completed"]), (1, 1))
        self.assertEqual([row["p_pmid"] for row in self.published], ["2"])
        self.assertEqual(self.db.execute("SELECT reason FROM summary_retry_metadata WHERE pmid='1'").fetchone()[0], "summary_unavailable")

    def test_valid_cached_summary_is_normalized_and_published_without_inference(self):
        paper = self.paper(1, archive=True)
        self.cache(paper, {**self.summary(paper), "summary_ko": "  첫 줄.\n두 번째 줄.\n세 번째 줄.  "})
        counts = self.run_queue([paper])
        self.assertEqual(counts["completed"], 1)
        self.assertEqual(self.generated, [])
        self.assertEqual(self.published[0]["p_summary"]["summary_ko"], "첫 줄.\n두 번째 줄.\n세 번째 줄.")
        self.assertNotIn("content_text", json.dumps(self.published))

    def test_invalid_cached_summary_and_draft_are_quarantined_before_regeneration(self):
        paper = self.paper(1)
        final = self.cache(paper, {**self.summary(paper), "invalid": True})
        draft = self.directory / "documents/1.notes.draft.json"
        worker.save_json(draft, {"invalid": True})

        def generate(paper, document, **kwargs):
            self.assertFalse(final.exists())
            self.assertFalse(draft.exists())
            return self.generate(paper, document, **kwargs)

        self.dependencies["generate_summary"] = generate
        self.assertEqual(self.run_queue([paper])["completed"], 1)
        self.assertEqual(len(list(final.parent.glob("1.summary.json.rejected-*"))), 1)
        self.assertEqual(len(list(final.parent.glob("1.notes.draft.json.rejected-*"))), 1)
        self.assertTrue(final.exists())

    def test_publication_reject_invalidates_final_and_draft_but_preserves_notes_and_body(self):
        paper = self.paper(1)
        final = self.cache(paper)
        notes = self.directory / "documents/1.notes.json"
        draft = notes.with_suffix(".draft.json")
        worker.save_json(notes, {"notes": ["preserve"]})
        worker.save_json(draft, {"draft": "regenerate"})
        original = (self.directory / "documents/1.json").read_bytes()
        self.publish_errors["1"] = worker.SummaryPublicationRejected()
        self.assertEqual(self.run_queue([paper])["failed"], 1)
        self.assertFalse(final.exists())
        self.assertFalse(draft.exists())
        self.assertEqual(json.loads(notes.read_text()), {"notes": ["preserve"]})
        self.assertEqual((self.directory / "documents/1.json").read_bytes(), original)
        self.assertEqual(self.db.execute("SELECT reason FROM summary_retry_metadata WHERE pmid='1'").fetchone()[0], "publication_rejected")
        self.now += 900
        self.publish_errors.clear()
        self.assertEqual(self.run_queue([paper])["completed"], 1)
        self.assertEqual(len(self.generated), 1)

    def test_locked_rejected_cache_cannot_replay_or_abort_later_papers(self):
        first, second = self.paper(1), self.paper(2)
        final = self.cache(first)
        self.publish_errors["1"] = worker.SummaryPublicationRejected()
        self.dependencies["atomic_replace"] = Mock(side_effect=PermissionError("Synthetic sharing lock"))
        counts = self.run_queue([first, second])
        self.assertEqual((counts["failed"], counts["completed"]), (1, 1))
        self.assertTrue(final.exists())
        self.now += 900
        self.publish_errors.clear()
        del self.dependencies["atomic_replace"]
        self.assertEqual(self.run_queue([first])["completed"], 1)
        self.assertIn("1", [row[0] for row in self.generated])

    def test_transient_publication_failure_keeps_cache_for_retry_without_regeneration(self):
        paper = self.paper(1)
        final = self.cache(paper)
        self.publish_errors["1"] = RuntimeError("Synthetic cloud outage")
        self.assertEqual(self.run_queue([paper])["failed"], 1)
        self.assertTrue(final.exists())
        self.now += 900
        self.publish_errors.clear()
        self.assertEqual(self.run_queue([paper])["completed"], 1)
        self.assertEqual(self.generated, [])

    def test_invalid_original_respects_retry_without_opening_or_rewriting_it(self):
        paper = self.paper(1)
        original = self.directory / "documents/1.json"
        original.write_text("not valid json", encoding="utf-8")
        self.assertEqual(self.run_queue([paper])["failed"], 1)
        self.assertEqual(self.run_queue([paper])["deferred"], 1)
        self.assertEqual(original.read_text(), "not valid json")
        self.assertEqual(self.generated, [])

    def test_metadata_and_attempt_deadline_commit_together(self):
        record_summary_attempt(self.db, "1", "a" * 64, "summary_validation", self.now)
        self.db.execute("CREATE TRIGGER fail_summary_retry BEFORE INSERT ON summary_retry_metadata BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            record_summary_attempt(self.db, "1", "a" * 64, "summary_validation", self.now + 1000)
        self.assertEqual(self.db.execute("SELECT next_retry FROM attempts WHERE pmid='1'").fetchone()[0], self.now + 900)
        self.assertEqual(self.db.execute("SELECT consecutive_failures FROM summary_retry_metadata WHERE pmid='1'").fetchone()[0], 1)

    def test_candidate_metadata_only_requested_for_summary_and_publication_budget_is_bounded(self):
        service = object.__new__(worker.Service)
        service.request = Mock(return_value=[])
        service.candidates()
        self.assertNotIn("summary_ko", service.request.call_args.kwargs["params"]["select"])
        self.assertNotIn("fulltext_available", service.request.call_args.kwargs["params"])
        service.candidates(include_summary=True)
        self.assertEqual(service.request.call_args.kwargs["params"]["fulltext_available"], "eq.true")
        selected = service.request.call_args.kwargs["params"]["select"]
        for field in ("summary_basis", "summary_source_hash", "summary_model", "summarized_at", "summary_ko"):
            self.assertIn(field, selected.split(","))
        service.candidates("1", include_summary=True)
        self.assertNotIn("fulltext_available", service.request.call_args.kwargs["params"])
        self.assertNotIn("pub_date", service.request.call_args.kwargs["params"])
        service = object.__new__(worker.Service)
        service.config = {"url": "https://example.invalid", "public_key": "synthetic"}
        service.summary_deadline = 1010
        service.opener = Mock()
        service.opener.open.side_effect = worker.URLError("Synthetic publication outage")
        with patch.object(worker.time, "monotonic", return_value=1008), patch.object(worker.time, "sleep") as sleep:
            with self.assertRaises(TimeoutError):
                service.request("rpc/publish_institution_summary", {})
        self.assertEqual(service.opener.open.call_args.kwargs["timeout"], 2)
        sleep.assert_not_called()

    def test_only_definitive_publication_rejections_invalidate_cache(self):
        service = object.__new__(worker.Service)
        service.config = {"url": "https://example.invalid", "public_key": "synthetic"}
        service.opener = Mock()
        for status in (400, 409, 422):
            service.opener.open.side_effect = worker.HTTPError("https://example.invalid", status, "Synthetic rejection", {}, None)
            with self.assertRaises(worker.SummaryPublicationRejected):
                service.request("rpc/publish_institution_summary", {})
        service.opener.open.side_effect = worker.HTTPError("https://example.invalid", 403, "Synthetic authorization error", {}, None)
        with self.assertRaises(RuntimeError):
            service.request("rpc/publish_institution_summary", {})

    def test_script_entrypoint_and_imported_worker_share_publication_exception(self):
        # The installed controller executes the file, while the queue lazily imports
        # institution_worker for dependencies. Both must catch the same exception.
        entrypoint = runpy.run_path(worker.__file__, run_name="synthetic_worker_entry")
        self.assertIs(entrypoint["SummaryPublicationRejected"], worker.SummaryPublicationRejected)

    def test_summary_phase_uses_local_queue_without_legacy_cloud_archive_or_browser(self):
        service = Mock()
        service.candidates.return_value = []
        counts = dict(first_completed=0, updated=0, failed=0, yielded=0, deferred=0)
        with patch.dict(sys.modules, {"msvcrt": SimpleNamespace(locking=lambda *a: None, LK_NBLCK=1)}), \
                patch.object(worker, "Service", return_value=service), \
                patch.object(worker, "ensure_server") as readiness, \
                patch.object(worker, "archive_legacy_bodies") as archive, \
                patch.object(worker, "Browser") as browser, \
                patch("summary_queue.run_summary_queue", return_value=counts) as run_queue, \
                contextlib.redirect_stdout(io.StringIO()):
            worker.run(self.directory, Path("synthetic-node"), 60, phase="summarize")
        readiness.assert_called_once_with(self.directory)
        service.candidates.assert_called_once_with(None, include_summary=True)
        archive.assert_not_called()
        browser.assert_not_called()
        run_queue.assert_called_once()


if __name__ == "__main__":
    unittest.main()
