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
        first_page = [ready_paper(n * 3) for n in range(1, recs.CATALOG_PAGE_SIZE + 1)]
        last_id = first_page[-1]["id"]
        with patch.object(recs, "sb", side_effect=[first_page, [ready_paper(last_id + 3)], [], []]) as get:
            papers = recs.get_catalog_papers()
        self.assertEqual(len(papers), recs.CATALOG_PAGE_SIZE + 1)
        first = get.call_args_list[0].kwargs["params"]
        second = get.call_args_list[1].kwargs["params"]
        self.assertEqual(first["id"], "gt.0")
        self.assertEqual(second["id"], "gt." + str(last_id))
        self.assertEqual(first["order"], "id.asc")
        self.assertEqual(first["fulltext_available"], "eq.true")
        self.assertEqual(first["summary_basis"], "eq.fulltext")
        for field in ("summary_source_hash", "summarized_at", "summary_model", "summary_ko"):
            self.assertEqual(first[field], "not.is.null")
        self.assertEqual(first["pub_date"], "gte.2000-01-01")
        self.assertNotIn("fetched_at", first)
        self.assertNotIn("offset", first)
        self.assertNotIn("offset", second)

    def test_catalog_candidate_cursor_rejects_invalid_or_nonadvancing_pages(self):
        for page in (None, {}, [ready_paper(0)], [ready_paper(True)],
                     [ready_paper("1")], [ready_paper(3), ready_paper(2)],
                     [ready_paper(2), ready_paper(2)], [None],
                     [ready_paper(n) for n in range(1, recs.CATALOG_PAGE_SIZE + 2)]):
            with self.subTest(page=page), patch.object(recs, "sb", return_value=page):
                with self.assertRaises(ValueError):
                    recs.get_catalog_papers()
        first_page = [ready_paper(n) for n in range(1, recs.CATALOG_PAGE_SIZE + 1)]
        with patch.object(recs, "sb", side_effect=[first_page, [first_page[-1]]]):
            with self.assertRaises(ValueError):
                recs.get_catalog_papers()

    def test_unready_feedback_and_read_papers_remain_available_for_scoring_signals(self):
        unready = {**ready_paper(2), "summary_basis": None, "summary_ko": None}
        abstract = {**ready_paper(3), "summary_basis": "abstract"}
        with patch.object(recs, "sb", side_effect=[
                [ready_paper()], [{"paper_id": 1}, {"paper_id": 2}],
                [{"paper_id": 2}, {"paper_id": 3}], [unready, abstract]]) as get:
            papers = recs.get_catalog_papers()
        self.assertEqual([paper["id"] for paper in papers], [1, 2, 3])
        self.assertEqual(get.call_args.kwargs["params"]["id"], "in.(2,3)")
        self.assertNotIn("summary_basis", get.call_args.kwargs["params"])
        self.assertEqual([paper["id"] for paper in papers if recs.has_fulltext_summary(paper)], [1])
        score, reasons = recs.behavioral_score(ready_paper(4), [unready], set(), [abstract])
        self.assertGreater(score, 0)
        self.assertTrue(reasons)

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

    def test_prior_recommendations_are_excluded_even_without_reading_or_personalization(self):
        for personalized in (True, False):
            with self.subTest(personalized=personalized), \
                 patch.multiple(recs, SUPABASE_URL="https://example.test", SUPABASE_KEY="fixture"), \
                 patch.object(recs, "get_catalog_papers", return_value=[ready_paper(n) for n in range(1, 8)]), \
                 patch.object(recs, "get_all_profiles", return_value=[{"id": "reader", "keywords": ["prostate"], "personalization_enabled": personalized}]), \
                 patch.object(recs, "get_all_feedbacks_likes", return_value=[]), \
                 patch.object(recs, "get_user_feedbacks", return_value=[]), \
                 patch.object(recs, "get_user_reads", return_value=[]), \
                 patch.object(recs, "get_prior_recommendation_ids", return_value={1, 2, 3}) as history, \
                 patch.object(recs, "sb", return_value=[]) as database, \
                 contextlib.redirect_stdout(io.StringIO()):
                recs.main()
            writes = [call.args[2] for call in database.call_args_list if call.args[0] == "POST"]
            self.assertEqual({r["paper_id"] for r in writes[0]["p_recs"]}, {4, 5, 6, 7})
            history.assert_called_once_with("reader", writes[0]["p_date"])

    def test_recommendation_history_is_paginated_and_strictly_before_the_requested_day(self):
        with patch.object(recs, "sb", side_effect=[[{"paper_id": n} for n in range(500)], [{"paper_id": 900}]]) as get:
            ids = recs.get_prior_recommendation_ids("reader", "2026-09-20")
        self.assertEqual(len(ids), 501)
        self.assertIn(900, ids)
        for call in get.call_args_list:
            self.assertEqual(call.kwargs["params"]["user_id"], "eq.reader")
            self.assertEqual(call.kwargs["params"]["rec_date"], "lt.2026-09-20")
        self.assertEqual(get.call_args.kwargs["params"]["offset"], "500")
        with patch.object(recs, "sb", return_value=[{"paper_id": "unexpected"}]):
            with self.assertRaises(ValueError):
                recs.get_prior_recommendation_ids("reader", "2026-09-20")


if __name__ == "__main__":
    unittest.main()
