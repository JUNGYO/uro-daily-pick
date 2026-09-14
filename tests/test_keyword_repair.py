import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from repair_keyword_reasons import repair_reasons


class RepairTests(unittest.TestCase):
    def test_actual_historical_repair_and_remains_false_matches(self):
        for text in ["DNA mismatch repair (MMR) genes", "Their relevance remains incompletely defined."]:
            paper = {"abstract": text, "study_type": "meta_analysis"}
            reasons = {"matched_terms": ["AI"], "reasons": [
                {"type": "keyword", "label": "ai"}, {"type": "alert", "label": "Alert: AI"},
                {"type": "keyword", "label": "Meta Analysis"}, {"type": "fresh", "label": "Recent publication"}]}
            fixed = repair_reasons(paper, reasons)
            self.assertEqual(fixed["matched_terms"], [])
            self.assertEqual([r["label"] for r in fixed["reasons"]], ["Meta Analysis", "Recent publication"])
            self.assertEqual(repair_reasons(paper, fixed), fixed)

    def test_missing_terms_do_not_hide_stale_reasons_and_real_ai_is_preserved(self):
        reasons = {"reasons": [{"type": "keyword", "label": "AI"}]}
        self.assertEqual(repair_reasons({"abstract": "Available findings"}, reasons)["reasons"], [])
        self.assertEqual(repair_reasons({"abstract": "An AI-assisted tool"}, reasons)["reasons"], reasons["reasons"])

    def test_typed_alerts_keep_author_and_journal_matching_separate(self):
        paper = {"title": "DNA mismatch repair", "journal": "European Urology", "authors": ["Ai Lee"]}
        reasons = {"reasons": [
            {"type": "alert", "alert_type": "journal", "label": "Alert: Urol"},
            {"type": "alert", "alert_type": "author", "label": "Alert: Ai Lee"},
            {"type": "alert", "alert_type": "keyword", "label": "Alert: AI"}]}
        self.assertEqual([r["label"] for r in repair_reasons(paper, reasons)["reasons"]], ["Alert: Urol", "Alert: Ai Lee"])
