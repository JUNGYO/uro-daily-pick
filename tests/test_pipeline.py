"""Offline regressions: no production database, model calls, or email delivery."""
import contextlib
import io
import sys
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import Mock, patch

import requests
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import classify_papers as classify
import fetch_papers as fetch
import generate_recs as recs
import send_digest as digest
import summarize_papers as summary


class PipelineTests(unittest.TestCase):
    def test_missing_configuration_stops_every_stage(self):
        for module in (fetch, classify, summary, recs, digest):
            with self.subTest(module=module.__name__), patch.object(module, "SUPABASE_URL", ""):
                with self.assertRaises(SystemExit) as caught:
                    module.main()
                self.assertNotEqual(caught.exception.code, 0)

    def test_database_failures_are_not_treated_as_data_or_success(self):
        calls = [
            (classify.sb_get, ("papers", {}), "get"),
            (classify.sb_patch, (1, {}), "patch"),
            (summary.sb_get, ("papers", {}), "get"),
            (summary.sb_patch, (1, {}), "patch"),
            (digest.sb_get, ("profiles", {}), "get"),
            (recs.sb, ("GET", "papers"), "get"),
            (recs.sb, ("POST", "recommendations", []), "post"),
            (recs.sb, ("DELETE", "recommendations"), "delete"),
            (fetch.get_existing_pmids, (), "get"),
            (fetch.insert_papers, ([{"pmid": "1"}],), "post"),
        ]
        for fn, args, method in calls:
            response = Mock()
            response.raise_for_status.side_effect = requests.HTTPError("database unavailable")
            with self.subTest(function=fn.__qualname__, method=method):
                with patch.object(requests, method, return_value=response), self.assertRaises(requests.HTTPError):
                    fn(*args)

    def test_partial_fetch_is_reported_as_failure_after_preserving_results(self):
        paper = {"pmid": "1", "title": "Test", "abstract": "Abstract"}
        with patch.multiple(fetch, SUPABASE_URL="https://example.test", SUPABASE_KEY="test", URO_QUERIES=["one", "two"]), \
             patch.object(fetch, "get_existing_pmids", return_value=set()), \
             patch.object(fetch, "search_pmids", side_effect=[requests.Timeout(), ["1"]]), \
             patch.object(fetch, "fetch_details", return_value=[paper]), \
             patch.object(fetch, "insert_papers", return_value=1) as insert, \
             patch.object(fetch.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                fetch.main()
            insert.assert_called_once_with([paper])

    def test_exhausted_summary_retries_stop_pipeline(self):
        with patch.dict(summary.os.environ, {"SUMMARY_SOURCE":"abstract"}), \
             patch.multiple(summary, SUPABASE_URL="https://example.test", SUPABASE_KEY="test", GEMINI_API_KEY="test"), \
             patch.object(summary, "sb_get", return_value=[{"id": 1, "pmid": "1", "title": "Test", "abstract": "Abstract"}]), \
             patch.object(summary, "summarize", return_value=None), \
             patch.object(summary.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                summary.main()

    def test_digest_preferences_and_korean_week_boundary(self):
        users = [{"id": "daily", "digest_frequency": "daily"},
                 {"id": "weekly", "digest_frequency": "weekly"},
                 {"id": "deleted", "name": "[DELETED]", "digest_frequency": "daily"}]
        with patch.object(digest, "sb_get", return_value=users) as get:
            # Sunday 15:00 UTC is Monday 00:00 KST.
            monday = digest.get_digest_users(datetime(2026, 9, 13, 15, tzinfo=timezone.utc))
            sunday = digest.get_digest_users(datetime(2026, 9, 13, 14, tzinfo=timezone.utc))
        self.assertEqual([u["id"] for u in monday], ["daily", "weekly"])
        self.assertEqual([u["id"] for u in sunday], ["daily"])
        self.assertEqual(get.call_args.args[1]["email_digest"], "eq.true")

    def test_digest_uses_verified_address_and_reports_delivery_failure(self):
        user = {"id": "1", "name": "Reader", "digest_email_address": "reader@example.test"}
        with patch.multiple(digest, SUPABASE_URL="https://example.test", SUPABASE_KEY="test", RESEND_API_KEY="test", FROM_EMAIL="Verified <digest@example.test>"), \
             patch.object(digest, "get_digest_users", return_value=[user]), \
             patch.object(digest, "get_user_email", return_value="reader@example.test") as auth_email, \
             patch.object(digest, "get_today_recs", return_value=[{"paper": {}}]), \
             patch.object(digest, "prepare_delivery", return_value=({"payload":{"to":["reader@example.test"]}}, {}, "test-key")) as prepare, \
             patch.object(digest, "send_email", side_effect=requests.Timeout()) as send, \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                digest.main()
            auth_email.assert_called_once_with("1")
            self.assertEqual(prepare.call_args.args[1], "reader@example.test")
            self.assertEqual(send.call_args.args[0]["to"], ["reader@example.test"])

    def test_email_renders_literal_metadata(self):
        html = digest.build_html("Reader & Team", [{"paper": {"title": "A < B", "journal": "A & B"}}])
        self.assertIn("Reader &amp; Team", html)
        self.assertIn("A &lt; B", html)

    def test_single_schedule_runs_stages_in_order(self):
        workflows = {p.name: yaml.load(p.read_text(), Loader=yaml.BaseLoader)
                     for p in (ROOT / ".github/workflows").glob("*.yml")}
        scheduled = [name for name, data in workflows.items() if "schedule" in data["on"]]
        self.assertEqual(scheduled, ["daily-fetch.yml"])
        steps = workflows["daily-fetch.yml"]["jobs"]["fetch"]["steps"]
        self.assertEqual([step["run"] for step in steps if step.get("run", "").startswith("python scripts/")], [
            "python scripts/fetch_papers.py", "python scripts/classify_papers.py",
            "python scripts/import_fulltexts.py",
            "python scripts/summarize_papers.py", "python scripts/generate_recs.py", "python scripts/send_digest.py",
        ])
        for name in ("daily-fetch.yml", "daily-recommend.yml", "daily-email.yml", "manual-run.yml"):
            self.assertEqual(workflows[name]["concurrency"]["group"], "uro-daily-pipeline")
            self.assertEqual(workflows[name]["concurrency"]["cancel-in-progress"], "false")


if __name__ == "__main__":
    unittest.main()
