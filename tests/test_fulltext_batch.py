import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import import_fulltexts as batch


class FulltextBatchTests(unittest.TestCase):
    def test_ready_documents_and_recent_misses_are_skipped_with_a_budget(self):
        now = datetime.now(timezone.utc)
        papers = [{"id": n, "pmid": str(n)} for n in range(1, 6)]
        records = [{"paper_id": 1, "status": "ready", "fetched_at": (now-timedelta(days=20)).isoformat()},
                   {"paper_id": 2, "status": "failed", "fetched_at": now.isoformat()},
                   {"paper_id": 3, "status": "failed", "fetched_at": (now-timedelta(days=8)).isoformat()}]
        self.assertEqual([p["id"] for p in batch.select_candidates(papers, records, now, 2)], [4, 5])
        self.assertEqual([p["id"] for p in batch.select_candidates(papers, records, now, 0)], [4, 5, 3])

    def test_catalog_backfill_includes_older_papers_without_abstracts(self):
        calls = []
        def get(url, *, headers, params):
            calls.append((url, params))
            return [{"id": 1, "pmid": "42315681"}] if url.endswith('/papers') else []
        with patch.dict(batch.os.environ, {"SUPABASE_URL": "https://example.test", "SUPABASE_SERVICE_KEY": "test", "FULLTEXT_BATCH_SIZE": "0"}), \
             patch.object(batch, "get_json", side_effect=get), \
             patch.object(batch, "fetch_oa", return_value=(b"body", "https://example.test/article")), \
             patch.object(batch, "parse_document", return_value={}), \
             patch.object(batch, "publish") as publish, patch.object(batch.time, "sleep"):
            batch.main()
        self.assertNotIn("fetched_at", calls[0][1])
        self.assertNotIn("abstract", calls[0][1])
        publish.assert_called_once()

    def test_runtime_yield_does_not_mark_unattempted_papers_unavailable(self):
        with patch.dict(batch.os.environ, {"SUPABASE_URL": "https://example.test", "SUPABASE_SERVICE_KEY": "test", "FULLTEXT_BATCH_SIZE": "0", "FULLTEXT_MAX_SECONDS": "60"}), \
             patch.object(batch, "paginate", side_effect=[[{"id": 1, "pmid": "1"}], []]), \
             patch.object(batch.time, "monotonic", side_effect=[0, 61]), \
             patch.object(batch, "fetch_oa") as fetch, patch.object(batch, "record_unavailable") as record:
            batch.main()
        fetch.assert_not_called()
        record.assert_not_called()

    def test_failed_attempt_cannot_overwrite_a_successful_concurrent_import(self):
        with patch.object(batch.requests, "patch", return_value=Mock()) as update, \
             patch.object(batch.requests, "post", return_value=Mock()) as insert:
            batch.record_unavailable("https://example.test", {"apikey": "fixture"}, 5, "No OA document")
        self.assertEqual(update.call_args.kwargs["params"]["status"], "eq.failed")
        self.assertEqual(insert.call_args.kwargs["headers"]["Prefer"], "resolution=ignore-duplicates,return=minimal")


if __name__ == "__main__":
    unittest.main()
