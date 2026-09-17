"""Synchronization failures must not lose local revisions or publication work."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from local_catalog import LocalCatalog
import catalog_sync
from catalog_sync import import_cloud_page, sync_citations, sync_events, run_sync
from institution_worker import ServiceRequestError


PAPER = {"pmid": "123", "title": "Synthetic local study", "pub_date": "2025-01-01", "doi": "10.1000/local"}
ORIGINAL = {"p_pmid": "123", "p_title": PAPER["title"], "p_doi": PAPER["doi"],
    "p_source": {"content_hash": "a" * 64, "summary_source_hash": "b" * 64,
                 "characters": 5000, "section_count": 3, "source_url": "https://example.org/paper"}}


class CatalogSyncTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.catalog = LocalCatalog(self.directory.name)
        self.service = Mock()
        self.service.config = {"id": "fixture-worker"}
        self.service.token = "fixture-token"

    def tearDown(self):
        self.catalog.close()
        self.directory.cleanup()

    def test_capacity_pause_keeps_local_citation_and_receipt(self):
        self.catalog.upsert_papers([PAPER])
        self.catalog.enqueue("original", ORIGINAL)
        self.service.request.return_value = {"accepted": [], "capacity_blocked": True}
        result = sync_citations(self.catalog, self.service)
        self.assertTrue(result["capacity_blocked"])
        self.assertEqual(self.catalog.stats()["local_papers"], 1)
        self.assertEqual(self.catalog.stats()["citation_pending"], 1)
        sync_events(self.directory.name, self.catalog, self.service, time.monotonic() + 30)
        self.service.rpc.assert_not_called()
        self.assertEqual(self.catalog.stats()["pending_originals"], 1)

    def test_unknown_acknowledgement_does_not_mark_anything_synced(self):
        self.catalog.upsert_papers([PAPER])
        self.service.request.return_value = {"accepted": [{"pmid": "123", "id": 7},
            {"pmid": "999", "id": 8}], "capacity_blocked": False}
        with self.assertRaises(ValueError):
            sync_citations(self.catalog, self.service)
        self.assertFalse(self.catalog.citation_is_synced("123"))

    def test_ack_of_inflight_revision_preserves_newer_citation(self):
        self.catalog.upsert_papers([PAPER])
        def response(*args, **kwargs):
            self.catalog.upsert_papers([{**PAPER, "title": "Corrected study title"}])
            return {"accepted": [{"pmid": "123", "id": 7}], "capacity_blocked": False}
        self.service.request.side_effect = response
        sync_citations(self.catalog, self.service)
        self.assertFalse(self.catalog.citation_is_synced("123"))
        self.assertEqual(self.catalog.pending_citations()[0]["paper"]["title"], "Corrected study title")

    def test_receipt_network_failure_is_replayable_after_reopen(self):
        self.catalog.upsert_papers([{**PAPER, "id": 7}], synced=True)
        self.catalog.enqueue("original", ORIGINAL)
        self.service.rpc.side_effect = RuntimeError("Service temporarily unavailable")
        with self.assertRaises(RuntimeError):
            sync_events(self.directory.name, self.catalog, self.service, time.monotonic() + 30)
        self.catalog.close()
        self.catalog = LocalCatalog(self.directory.name)
        self.assertEqual(self.catalog.stats()["pending_originals"], 1)
        self.service.rpc.side_effect = None
        self.assertEqual(sync_events(self.directory.name, self.catalog, self.service, time.monotonic() + 30), 1)
        self.assertEqual(self.catalog.stats()["pending_originals"], 0)

    def test_bad_mirror_cursor_is_rejected_before_local_commit(self):
        self.service.request.return_value = [{**PAPER, "id": 8}, {**PAPER, "pmid": "124", "id": 7}]
        with self.assertRaises(ValueError):
            import_cloud_page(self.catalog, self.service)
        self.assertEqual(self.catalog.stats()["local_papers"], 0)
        self.assertEqual(self.catalog.get_meta("cloud_import_cursor", 0), 0)

    def test_old_remote_snapshot_cannot_replace_new_pending_citation(self):
        self.catalog.upsert_papers([{**PAPER, "title": "Updated local citation"}])
        self.service.request.return_value = [{**PAPER, "id": 7}]
        self.assertEqual(import_cloud_page(self.catalog, self.service), 1)
        self.assertEqual(self.catalog.pending_citations()[0]["paper"]["title"], "Updated local citation")
        self.assertFalse(self.catalog.citation_is_synced("123"))

    def test_rejected_citation_does_not_block_valid_citation(self):
        self.catalog.upsert_papers([PAPER, {**PAPER, "pmid": "124", "title": "Valid second record"}])
        def response(path, values):
            if any(p["pmid"] == "123" for p in values["p_papers"]):
                raise RuntimeError("Service HTTP 400")
            return {"accepted": [{"pmid": "124", "id": 8}], "capacity_blocked": False}
        self.service.request.side_effect = response
        self.assertEqual(sync_citations(self.catalog, self.service)["accepted"], 1)
        self.assertTrue(self.catalog.citation_is_synced("124"))
        self.assertEqual(self.catalog.stats()["citation_pending"], 1)
        self.assertEqual(self.catalog.pending_citations(), [])

    def test_stale_original_identity_is_not_published_after_citation_correction(self):
        self.catalog.upsert_papers([{**PAPER, "id": 7}], synced=True)
        self.catalog.enqueue("original", ORIGINAL)
        self.catalog.upsert_papers([{**PAPER, "title": "New title", "id": 7}], synced=True)
        sync_events(self.directory.name, self.catalog, self.service, time.monotonic() + 30)
        self.service.rpc.assert_not_called()
        self.assertEqual(self.catalog.stats()["pending_originals"], 1)

    def run_bounded(self, seconds):
        elapsed = [0]
        output = io.StringIO()
        def sleep(duration):
            elapsed[0] += duration
        with patch.object(catalog_sync.time, "monotonic", side_effect=lambda: elapsed[0]), \
                contextlib.redirect_stdout(output):
            completed = run_sync(self.directory.name, seconds, service=self.service,
                catalog=self.catalog, sleep=sleep)
        return completed, output.getvalue()

    def test_all_failed_cycles_retain_work_and_report_a_failed_phase(self):
        self.catalog.upsert_papers([PAPER])
        self.catalog.enqueue("original", ORIGINAL)
        self.catalog.set_meta("last_sync_at", "2026-09-17T01:00:00+00:00")
        self.service.request.side_effect = ServiceRequestError("Service temporarily unavailable",
            category="http", http_status=503)
        completed, output = self.run_bounded(120)
        self.assertEqual(completed, 0)
        self.assertEqual(self.service.request.call_count, 2)
        self.assertEqual(self.catalog.stats()["citation_pending"], 1)
        self.assertEqual(self.catalog.stats()["pending_originals"], 1)
        self.assertEqual(self.catalog.get_meta("last_sync_at"), "2026-09-17T01:00:00+00:00")
        detail = self.catalog.get_meta("sync_error")
        self.assertEqual(detail["stage"], "catalog_import")
        self.assertEqual(detail["category"], "http")
        self.assertEqual(detail["http_status"], 503)
        self.assertIn("at", detail)
        self.assertNotIn("fixture-token", output)
        self.assertNotIn(PAPER["title"], output)
        with patch.object(sys, "argv", ["catalog_sync.py", "--state-dir", self.directory.name, "--max-seconds", "60"]), \
                patch("local_catalog_worker.phase_lock", return_value=contextlib.nullcontext(True)), \
                patch.object(catalog_sync, "run_sync", return_value=completed), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(catalog_sync.main(), 1)

    def test_report_failure_cannot_advance_success_timestamp(self):
        previous = "2026-09-17T01:00:00+00:00"
        self.catalog.set_meta("last_sync_at", previous)
        def respond(path, *args, **kwargs):
            if path == "papers":
                return []
            if path == "rpc/report_institution_catalog":
                raise RuntimeError("private response https://secret.example/token=do-not-log")
            self.fail("Unexpected request")
        self.service.request.side_effect = respond
        completed, output = self.run_bounded(1)
        self.assertEqual(completed, 0)
        self.assertEqual(self.catalog.get_meta("last_sync_at"), previous)
        self.assertEqual(self.catalog.get_meta("sync_error")["stage"], "status_report")
        self.assertEqual(self.catalog.get_meta("sync_state"), "offline")
        self.assertNotIn("secret.example", output)
        self.assertNotIn("do-not-log", json.dumps(self.catalog.get_meta("sync_error")))

    def test_recovery_clears_errors_after_both_status_calls_succeed(self):
        self.catalog.set_meta("last_sync_at", "old-success")
        calls = [0]
        def respond(path, *args, **kwargs):
            calls[0] += 1
            if calls[0] == 1:
                raise ServiceRequestError("Service temporarily unavailable", category="timeout")
            if path == "papers":
                return []
            self.assertEqual(path, "rpc/report_institution_catalog")
            self.assertEqual(self.catalog.get_meta("last_sync_at"), "old-success")
            self.assertIsNotNone(self.catalog.get_meta("sync_error"))
            self.assertNotEqual(args[0]["p_status"]["last_sync_at"], "old-success")
            return None
        self.service.request.side_effect = respond
        completed, _ = self.run_bounded(61)
        self.assertEqual(completed, 1)
        self.assertIsNone(self.catalog.get_meta("sync_error"))
        self.assertEqual(self.catalog.get_meta("sync_state"), "idle")
        self.assertNotEqual(self.catalog.get_meta("last_sync_at"), "old-success")

    def test_worker_heartbeat_failure_does_not_publish_a_success_report(self):
        self.service.request.return_value = []
        self.service.status.side_effect = TimeoutError("private connection detail")
        completed, _ = self.run_bounded(1)
        self.assertEqual(completed, 0)
        self.assertIsNone(self.catalog.get_meta("last_sync_at"))
        self.assertEqual([call.args[0] for call in self.service.request.call_args_list], ["papers"])
        self.assertEqual(self.catalog.get_meta("sync_error")["category"], "timeout")

    def test_capacity_pause_is_a_completed_cycle_not_a_transport_failure(self):
        self.catalog.upsert_papers([PAPER])
        self.catalog.enqueue("original", ORIGINAL)
        def respond(path, *args, **kwargs):
            if path == "papers":
                return []
            if path == "rpc/sync_institution_catalog":
                return {"accepted": [], "capacity_blocked": True}
            return None
        self.service.request.side_effect = respond
        completed, _ = self.run_bounded(1)
        self.assertEqual(completed, 1)
        self.assertEqual(self.catalog.get_meta("sync_state"), "capacity_blocked")
        self.assertEqual(self.catalog.stats()["citation_pending"], 1)
        self.assertEqual(self.catalog.stats()["pending_originals"], 1)
        self.assertIsNotNone(self.catalog.get_meta("last_sync_at"))


if __name__ == "__main__":
    unittest.main()
