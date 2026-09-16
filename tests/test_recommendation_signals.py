"""Recommendation trust regressions using synthetic metadata and feedback only."""
import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import generate_recs as recs
from recommendation_topics import paper_topics, topic_id
from test_recommendation_readiness import ready_paper


def likes(readers=3, candidates=(3, 4)):
    rows = [{"user_id": "me", "paper_id": pid} for pid in (1, 2)]
    for index in range(readers):
        rows.extend({"user_id": f"peer-{index}", "paper_id": pid} for pid in (1, 2, *candidates))
    return rows


def context(rows=None, papers=None):
    return recs.build_collaborative_context("me", recs.likes_by_user(likes() if rows is None else rows),
                                            [ready_paper(3), ready_paper(4)] if papers is None else papers)


class CollaborativeSupportTests(unittest.TestCase):
    def test_sparse_or_single_shared_like_never_claims_similar_readers(self):
        for rows in ([], likes(1), likes(2), [row for row in likes(5) if row["paper_id"] != 2]):
            with self.subTest(rows=len(rows)):
                result = context(rows)
                self.assertEqual(result["network"]["status"], "insufficient")
                self.assertEqual(result["network"]["topics"], [])
                self.assertEqual(result["paper_signals"], {})
                self.assertNotIn("cohort_size", result["network"])
                _, reasons = recs.score_paper(ready_paper(3), {"id": "me", "keywords": ["prostate"]},
                                             [], [], [], rows)
                self.assertNotIn("similar_readers", [r["type"] for r in reasons["reasons"]])

    def test_duplicate_likes_are_not_independent_readers_or_papers(self):
        self.assertEqual(context(likes(1) * 10)["network"]["status"], "insufficient")
        one_paper = context(likes(3, candidates=(3,)) * 4)
        self.assertEqual(one_paper["paper_signals"][3]["support"], 3)
        self.assertEqual(one_paper["network"]["topics"], [])

    def test_cohort_alone_does_not_support_a_candidate_or_topic(self):
        rows = likes(3, candidates=())
        rows.extend([{"user_id": "peer-0", "paper_id": 3}, {"user_id": "peer-1", "paper_id": 4}])
        result = context(rows)
        self.assertEqual(result["network"]["status"], "qualified")
        self.assertEqual(result["paper_signals"], {})
        self.assertEqual(result["network"]["topics"], [])

    def test_small_jaccard_overlap_is_not_a_cohort(self):
        rows = likes(3, candidates=tuple(range(3, 40)))
        self.assertEqual(context(rows)["network"]["status"], "insufficient")

    def test_qualified_support_is_bounded_and_contains_no_peer_identity(self):
        result = context()
        signal = result["paper_signals"][3]
        self.assertEqual(signal, {"score": 0.5, "support": 3, "cohort_size": 3})
        self.assertEqual(result["network"]["topics"], [
            {"id": "prostate", "label": "prostate", "reader_support": 3,
             "paper_support": 2, "source": "metadata"}])
        profile = {"id": "me", "keywords": ["prostate"]}
        score, payload = recs.score_paper(ready_paper(3), profile, [], [], [], [], result)
        baseline, _ = recs.score_paper(ready_paper(3), profile, [], [], [], [])
        self.assertAlmostEqual(score - baseline, 0.75, places=2)
        reason = next(reason for reason in payload["reasons"] if reason["type"] == "similar_readers")
        self.assertEqual(reason["support"], 3)
        self.assertEqual(reason["cohort_size"], 3)
        serialized = json.dumps(payload)
        self.assertNotIn("peer-", serialized)
        self.assertNotIn("user_id", serialized)
        self.assertNotIn("probability", serialized)

    def test_unrelated_content_cannot_gain_collaborative_boost(self):
        unrelated = {**ready_paper(3), "title": "Stone study", "keywords": ["stones"]}
        profile = {"id": "me", "keywords": ["prostate"]}
        score, payload = recs.score_paper(unrelated, profile, [], [], [], [], context())
        baseline, _ = recs.score_paper(unrelated, profile, [], [], [], [])
        self.assertEqual(score, baseline)
        self.assertNotIn("similar_readers", [reason["type"] for reason in payload["reasons"]])

    def test_opt_out_disables_learning_and_excludes_contributions(self):
        filtered = recs.likes_by_user(likes(), {"me", "peer-0", "peer-1"})
        self.assertEqual(recs.build_collaborative_context("me", filtered)["network"]["status"], "insufficient")
        profile = {"id": "me", "keywords": ["prostate"], "personalization_enabled": False}
        actual = recs.score_paper(ready_paper(3), profile, [ready_paper(1)], [], [ready_paper(2)], likes(), context())
        baseline = recs.score_paper(ready_paper(3), profile, [], [], [], [])
        self.assertEqual(actual, baseline)
        self.assertFalse(actual[1]["personalization_enabled"])
        self.assertEqual(actual[1]["network"]["status"], "disabled")
        self.assertEqual(actual[1]["network"]["topics"], [])
        self.assertIn("keyword", [reason["type"] for reason in actual[1]["reasons"]])

    def test_cohort_and_topics_are_bounded(self):
        papers = [{**ready_paper(pid), "keywords": [f"topic-{n}" for n in range(20)]} for pid in (3, 4)]
        result = context(likes(70), papers)
        self.assertEqual(result["network"]["cohort_size"], recs.MAX_SIMILAR_READERS)
        self.assertEqual(len(result["network"]["topics"]), recs.MAX_NETWORK_TOPICS)
        self.assertLessEqual(result["paper_signals"][3]["score"], 1.0)

    def test_retracted_or_pre2000_metadata_cannot_supply_network_topics(self):
        for changed in ({"pub_date": "1999-01-01"}, {"integrity_status": "retracted"}, {"summary_review_required": True}):
            papers = [{**ready_paper(pid), **changed} for pid in (3, 4)]
            self.assertEqual(context(papers=papers)["network"]["topics"], [])


class RecommendationTopicTests(unittest.TestCase):
    def test_exact_aliases_deduplicate_without_substring_expansion(self):
        paper = {"keywords": [" Prostate  cancer ", "PROSTATE NEOPLASMS", "AI", " ＡＩ "],
                 "mesh_terms": ["Prostatic Neoplasms", "Artificial intelligence"]}
        self.assertEqual(paper_topics(paper), {"prostatic neoplasms", "artificial intelligence"})
        self.assertEqual(topic_id("AI–assisted"), "ai-assisted")
        self.assertEqual(topic_id("renal cell carcinoma"), "renal cell carcinoma")
        self.assertNotEqual(topic_id("renal cell carcinoma"), topic_id("kidney cancer"))
        self.assertEqual(topic_id("available"), "available")
        self.assertNotIn("artificial intelligence", paper_topics({"title": "AI", "keywords": ["failure"]}))
        self.assertEqual(paper_topics({"mesh_terms": ["Humans", "Male", "Randomized Controlled Trial", "Carcinoma, Renal Cell"]}),
                         {"renal cell carcinoma"})
        self.assertEqual(paper_topics({"keywords": ["x", "a" * 101, "Cohort studies"]}), set())

    def test_alias_duplication_does_not_inflate_content_or_behavior(self):
        paper = {**ready_paper(3), "keywords": ["prostatic neoplasms"]}
        one = recs.text_match_score(paper, ["prostate cancer"])
        many = recs.text_match_score(paper, ["prostate cancer", "prostatic neoplasms", "PROSTATE NEOPLASMS"])
        self.assertEqual(one, many)
        self.assertEqual(one, (0.3, ["prostatic neoplasms"]))
        liked = {"keywords": ["prostate cancer", "prostate neoplasms"], "mesh_terms": ["prostatic neoplasms"]}
        self.assertEqual(recs.behavioral_score(paper, [liked], [], []), recs.behavioral_score(paper, [liked] * 10, [], []))

    def test_title_keyword_boundary_and_dedup_do_not_depend_on_alias_order(self):
        paper = {"title": "Artificial intelligence in care", "abstract": "", "keywords": []}
        self.assertEqual(recs.text_match_score(paper, ["AI", "artificial intelligence"]),
                         recs.text_match_score(paper, ["artificial intelligence", "AI"]))
        self.assertEqual(recs.text_match_score({"title": "Available prostate trials"}, ["AI"]), (0.0, []))

    def test_topic_counts_deduplicate_metadata_but_preserve_distinct_papers(self):
        papers = [{**ready_paper(pid), "keywords": ["prostate cancer", "prostate neoplasms"],
                   "mesh_terms": ["prostatic neoplasms"]} for pid in (3, 4)]
        self.assertEqual(context(papers=papers)["network"]["topics"], [
            {"id": "prostatic neoplasms", "label": "prostatic neoplasms", "reader_support": 3,
             "paper_support": 2, "source": "metadata"}])

    def test_diversity_breaks_close_ties_without_losing_recency_priority(self):
        same = {**ready_paper(1), "journal": "Journal A"}
        duplicate = {**same, "id": 2}
        different = {**ready_paper(3), "journal": "Journal B", "keywords": ["stones"]}
        historical = {**different, "id": 4, "pub_date": "2010-01-01"}
        picks = recs.diverse_picks([(same, 10, {}), (duplicate, 9.5, {}),
                                  (different, 9.0, {}), (historical, 50, {})], 3)
        self.assertEqual([paper["id"] for paper, _, _ in picks], [1, 3, 2])


class RecommendationGenerationTests(unittest.TestCase):
    def test_optout_and_dislike_filter_survive_real_generation_path(self):
        profiles = [{"id": "me", "keywords": ["prostate"], "personalization_enabled": False},
                    *[{"id": f"peer-{n}", "keywords": []} for n in range(3)]]
        papers = [ready_paper(pid) for pid in range(1, 8)]
        papers[-1]["summary_basis"] = "abstract"
        with patch.multiple(recs, SUPABASE_URL="https://example.test", SUPABASE_KEY="fixture"), \
             patch.object(recs, "get_catalog_papers", return_value=papers), \
             patch.object(recs, "get_all_profiles", return_value=profiles), \
             patch.object(recs, "get_all_feedbacks_likes", return_value=likes()), \
             patch.object(recs, "get_user_feedbacks", side_effect=lambda uid: [{"paper_id": 3, "action": "dislike"}] if uid == "me" else []), \
             patch.object(recs, "get_user_reads", return_value=[{"paper_id": 2, "dwell_seconds": 30}]), \
             patch.object(recs, "sb", return_value=[]) as database, \
             contextlib.redirect_stdout(io.StringIO()):
            recs.main()
        writes = [call.args[2] for call in database.call_args_list if call.args[0] == "POST"]
        own = next(write for write in writes if write["p_user_id"] == "me")
        self.assertEqual({row["paper_id"] for row in own["p_recs"]}, {1, 2, 4, 5, 6})
        for row in own["p_recs"]:
            self.assertFalse(row["reasons"]["personalization_enabled"])
            self.assertEqual(row["reasons"]["network"]["status"], "disabled")


if __name__ == "__main__":
    unittest.main()
