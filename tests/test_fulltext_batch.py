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
        self.assertEqual([p["id"] for p in batch.select_candidates(papers, records, now, 2)], [3, 4])

    def test_failed_attempt_cannot_overwrite_a_successful_concurrent_import(self):
        with patch.object(batch.requests, "patch", return_value=Mock()) as update, \
             patch.object(batch.requests, "post", return_value=Mock()) as insert:
            batch.record_unavailable("https://example.test", {"apikey": "fixture"}, 5, "No OA document")
        self.assertEqual(update.call_args.kwargs["params"]["status"], "eq.failed")
        self.assertEqual(insert.call_args.kwargs["headers"]["Prefer"], "resolution=ignore-duplicates,return=minimal")


if __name__ == "__main__":
    unittest.main()
