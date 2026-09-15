"""Regression for ready summaries stranded outside the recent-fetch pool."""
import contextlib
import io
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import generate_recs as recs


def ready_paper(paper_id=1):
    return {"id": paper_id, "pmid": str(paper_id), "title": "Prostate cancer study",
            "abstract": "Clinical outcomes were assessed. " * 10,
            "pub_date": "2026-06-01", "fetched_at": "2026-06-02",
            "keywords": ["prostate"], "fulltext_available": True,
            "summary_basis": "fulltext", "summary_ko": "Design\nResults\nLimitations",
            "summary_source_hash": "a" * 64, "summary_model": "fixture",
            "summarized_at": "2026-09-14T00:00:00Z"}


class RecommendationReadinessTests(unittest.TestCase):
    def test_incomplete_or_abstract_summaries_cannot_be_daily_picks(self):
        self.assertTrue(recs.has_fulltext_summary(ready_paper()))
        for change in [{"fulltext_available": False}, {"summary_basis": "abstract"},
                       {"summary_ko": "Only one line"}, {"summary_ko": None},
                       {"summary_source_hash": None}, {"summary_model": " "},
                       {"summarized_at": None}]:
            with self.subTest(change=change):
                self.assertFalse(recs.has_fulltext_summary({**ready_paper(), **change}))

    def test_catalog_query_crosses_old_fetch_dates_and_server_page_limits(self):
        first_page = [ready_paper(n) for n in range(500)]
        with patch.object(recs, "sb", side_effect=[first_page, [ready_paper(500)], [], []]) as get:
            papers = recs.get_catalog_papers()
        self.assertEqual(len(papers), 501)
        self.assertEqual(get.call_args_list[1].kwargs["params"]["offset"], "500")
        self.assertNotIn("fetched_at", get.call_args.kwargs["params"])

    def test_rebuild_excludes_pre2000_papers_preserving_feedback_and_history(self):
        papers = [ready_paper(n) for n in range(1, 8)]
        papers[-1]["abstract"]=""
        papers[-1]["pub_date"]="1937-11-01"
        papers.append({**ready_paper(99), "summary_basis": "abstract",
                       "pub_date": "2099-01-01", "title": "Prostate prostate prostate"})
        with patch.multiple(recs, SUPABASE_URL="https://example.test", SUPABASE_KEY="fixture"), \
             patch.object(recs, "get_catalog_papers", return_value=papers), \
             patch.object(recs, "get_all_profiles", return_value=[{"id": "reader", "keywords": ["prostate"]}]), \
             patch.object(recs, "get_all_feedbacks_likes", return_value=[]), \
             patch.object(recs, "get_user_feedbacks", return_value=[{"paper_id": 1, "action": "like"}]), \
             patch.object(recs, "get_user_reads", return_value=[{"paper_id": 2, "dwell_seconds": 45}]), \
             patch.object(recs, "sb", return_value=[]) as database, \
             contextlib.redirect_stdout(io.StringIO()):
            recs.main()
        writes = [c for c in database.call_args_list if c.args[0] != "GET"]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0].args[:2], ("POST", "rpc/replace_daily_recommendations"))
        payload = writes[0].args[2]
        self.assertEqual(payload["p_date"], datetime.now(timezone(timedelta(hours=9))).date().isoformat())
        self.assertEqual({r["paper_id"] for r in payload["p_recs"]}, set(range(3, 7)))


if __name__ == "__main__":
    unittest.main()
