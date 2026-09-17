"""Offline monitor regressions: genuine outages must never become healthy reports."""
import contextlib
from datetime import datetime, timezone
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import check_catalog_sync as monitor


def fresh(**changes):
    stamp = datetime.now(timezone.utc).isoformat()
    return {"available": True, "report_stale": False, "sync_stale": False,
            "reported_at": stamp, "last_sync_at": stamp,
            "local_papers": 100, "synced_papers": 80, "citation_pending": 20,
            "local_originals": 30, "local_summaries": 10,
            "pending_originals": 3, "pending_summaries": 2,
            "sync_state": "idle", "registry_version": "fixture-v1", **changes}


class CatalogSyncHealthTests(unittest.TestCase):
    def run_monitor(self, status=None, error=None):
        output = io.StringIO()
        with patch.dict(monitor.os.environ, {"SUPABASE_URL": "https://fixture.example/",
                                            "SUPABASE_SERVICE_KEY": "sb_secret_fixture"}), \
                patch.object(monitor, "get_json", return_value=status, side_effect=error) as get, \
                contextlib.redirect_stdout(output):
            monitor.main()
        return output.getvalue(), get

    def test_fresh_report_uses_only_lightweight_rpc(self):
        output, get = self.run_monitor(fresh())
        get.assert_called_once_with("https://fixture.example/rest/v1/rpc/catalog_sync_health",
                                    headers={"apikey": "sb_secret_fixture"}, params={})
        self.assertIn("Current revisions synchronized: 80", output)
        self.assertNotIn("::warning::", output)

    def test_capacity_blocking_is_warning_not_false_completion(self):
        output, _ = self.run_monitor(fresh(sync_state="capacity_blocked"))
        self.assertIn("::warning::", output)
        self.assertIn("uploads remain queued", output)
        self.assertIn("Citation synchronization pending: 20", output)

    def test_active_cycle_with_recent_success_can_be_healthy(self):
        self.assertEqual(monitor.validate_health(fresh(sync_state="syncing"))["sync_state"], "syncing")

    def test_missing_stale_and_error_reports_fail(self):
        for status in [
            {"available": False, "report_stale": True, "sync_stale": True},
            fresh(report_stale=True), fresh(sync_stale=True, last_sync_at=None),
            fresh(sync_stale=True, last_sync_at="2020-01-01T00:00:00+00:00"),
            fresh(sync_state="offline"), fresh(sync_state="error"),
        ]:
            with self.subTest(status=status), self.assertRaises(SystemExit) as caught:
                self.run_monitor(status)
            self.assertIn("health failed", str(caught.exception))

    def test_unknown_states_and_malformed_counters_fail_closed(self):
        for status in [None, [], {}, fresh(available=1), fresh(report_stale="false"),
                       fresh(sync_stale=None), fresh(sync_state="healthy"), fresh(sync_state=[]),
                       fresh(local_papers=True), fresh(local_papers="100"), fresh(local_papers=-1),
                       fresh(local_papers=1_000_000_001), fresh(citation_pending=19),
                       fresh(pending_originals=31), fresh(pending_summaries=101),
                       fresh(local_originals=101), fresh(local_summaries=101),
                       fresh(registry_version=None), fresh(registry_version="")]:
            with self.subTest(status=status), self.assertRaises(ValueError):
                monitor.validate_health(status)

    def test_invalid_timestamp_does_not_pass_even_with_fresh_flags(self):
        for field in ("reported_at", "last_sync_at"):
            for stamp in (None, 123, "invalid", "2026-01-01T00:00:00"):
                with self.subTest(field=field, stamp=stamp), self.assertRaisesRegex(ValueError, "timestamp"):
                    monitor.validate_health(fresh(**{field: stamp}))

    def test_request_failure_remains_failed_and_does_not_expose_exception(self):
        for error in (requests.Timeout("secret-token response-body"),
                      requests.HTTPError("https://secret-token@fixture.example/private"),
                      requests.RequestException("secret-token response-body"),
                      ValueError("secret-token invalid JSON response-body")):
            with self.subTest(error=type(error).__name__), self.assertRaises(SystemExit) as caught:
                self.run_monitor(error=error)
            self.assertIn("cloud API request failed", str(caught.exception))
            self.assertNotIn("secret-token", str(caught.exception))
            self.assertTrue(caught.exception.__suppress_context__)

    def test_missing_configuration_fails_before_any_request(self):
        with patch.dict(monitor.os.environ, {}, clear=True), patch.object(monitor, "get_json") as get:
            with self.assertRaisesRegex(SystemExit, "required"):
                monitor.main()
            get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
