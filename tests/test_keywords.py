import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from keywords import keyword_matches, keyword_count
from generate_recs import text_match_score, score_paper, behavioral_score

TITLE = "Active Surveillance Use for Favorable-Risk Prostate Cancer in a Veterans Affairs Population."


class KeywordTests(unittest.TestCase):
    def test_literal_acronyms_unicode_and_phrases(self):
        for text, term, expected in [(TITLE, "AI", False), ("failure available trial", "AI", False),
                ("(AI), AI-assisted AI/ML", "AI", True), ("HTML", "ML", False),
                ("AI_model", "AI", False), ("éAI", "AI", False), ("AI한글", "AI", False),
                ("prostate\u00a0 cancer", "prostate cancer", True), ("C++ study", "C++", True),
                ("C.. study", "C++", False), ("text", " ", False)]:
            with self.subTest(text=text, term=term):
                self.assertEqual(keyword_matches(text, term), expected)
        self.assertEqual(keyword_count("Affairs AI (AI) AI-assisted", "AI"), 3)

    def test_false_matches_do_not_change_score_or_keyword_alert(self):
        paper = {"id": 1, "title": TITLE, "abstract": "Available findings in Veterans Affairs.", "keywords": [], "mesh_terms": []}
        self.assertEqual(text_match_score(paper, ["AI"]), (0, []))
        profile = {"id": "reader", "keywords": ["AI"]}
        baseline = score_paper(paper, profile, [], [], [], [])
        alerted = score_paper(paper, {**profile, "alerts": [{"alert_type": "keyword", "value": "AI"}]}, [], [], [], [])
        self.assertEqual(baseline, alerted)
        paper["title"] = "AI-assisted diagnosis"
        self.assertEqual(text_match_score(paper, ["AI"]), (0.25, ["AI"]))

    def test_false_dislike_does_not_penalize_liked_metadata(self):
        paper = {"title": TITLE, "abstract": "Available findings.", "keywords": ["urology"]}
        liked = [{"keywords": ["urology"]}]
        self.assertEqual(behavioral_score(paper, liked, ["AI"], []), behavioral_score(paper, liked, [], []))


if __name__ == "__main__":
    unittest.main()
