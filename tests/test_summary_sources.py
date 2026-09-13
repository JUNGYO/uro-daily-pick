"""Source selection regressions: only a real body may produce a full-text summary."""
import contextlib
import hashlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import summarize_papers as summary

BODY = "Methods: 40 participants. Results: outcome 17. Limitations: single center. " * 20
VALID = json.dumps({"summary_ko": "연구 설계를 평가했다.\n주요 결과를 보고했다.\n단일 기관 연구라는 한계가 있다.",
    "structured": dict.fromkeys(["study_design", "sample_size", "key_finding", "population"], "Reported"),
    "clinical_relevance": 3, "qa": [{"q": "연구 한계는?", "a": "단일 기관 연구이다."}]})


class SourceTests(unittest.TestCase):
    def run_summary(self, papers, ready, *, rows=None, source="fulltext", pmid="", budget="1"):
        def get(table, params):
            if table == "papers":
                return papers
            if params.get("select") == "paper_id,content_hash":
                return [{"paper_id": pid, "content_hash": "body-hash"} for pid in ready]
            return [{"content_text": BODY}] if rows is None else rows
        with patch.dict(summary.os.environ, {"SUMMARY_SOURCE": source, "SUMMARY_PMID": pmid, "SUMMARY_BATCH_SIZE": budget}), \
             patch.multiple(summary, SUPABASE_URL="https://example.test", SUPABASE_KEY="test", GEMINI_API_KEY="test"), \
             patch.object(summary, "sb_get", side_effect=get), \
             patch.object(summary, "summarize", return_value=VALID) as model, \
             patch.object(summary, "sb_patch") as save, \
             patch.object(summary.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            try:
                summary.main()
                return model, save, None
            except SystemExit as error:
                return model, save, str(error)

    def test_newer_abstract_does_not_consume_fulltext_budget(self):
        papers = [{"id": 2, "pmid": "2", "title": "New abstract", "abstract": "ABSTRACT"},
                  {"id": 1, "pmid": "1", "title": "Body only", "abstract": ""}]
        model, save, error = self.run_summary(papers, [1])
        self.assertIsNone(error)
        model.assert_called_once_with("Body only", BODY, "fulltext")
        data = save.call_args.args[1]
        self.assertEqual(save.call_args.args[0], 1)
        self.assertEqual(data["summary_basis"], "fulltext")
        self.assertEqual(data["summary_source_hash"], hashlib.sha256(f"fulltext\nBody only\n{BODY}".encode()).hexdigest())
        self.assertEqual(len(data["summary_ko"].splitlines()), 3)

    def test_missing_or_disappearing_body_never_falls_back_to_abstract(self):
        paper = {"id": 1, "pmid": "1", "title": "Study", "abstract": "ABSTRACT"}
        for ready, rows in [([], None), ([1], []), ([1], [{"content_text": "Only a title"}])]:
            with self.subTest(ready=ready, rows=rows):
                model, save, error = self.run_summary([paper], ready, rows=rows, pmid="1")
                self.assertIsNotNone(error)
                model.assert_not_called()
                save.assert_not_called()

    def test_legacy_abstract_run_never_overwrites_fulltext(self):
        model, save, error = self.run_summary([{"id": 1, "pmid": "1", "title": "Study", "abstract": "ABSTRACT", "summary_basis": "fulltext"}], [], source="abstract")
        self.assertIsNone(error)
        model.assert_not_called()
        save.assert_not_called()

    def test_cached_body_skips_model_and_leaves_budget_for_next_paper(self):
        papers = [{"id": 1, "pmid": "1", "title": "Cached", "summary_model": summary.GEMINI_MODEL,
                   "summary_source_hash": hashlib.sha256(f"fulltext\nCached\n{BODY}".encode()).hexdigest()},
                  {"id": 2, "pmid": "2", "title": "Uncached"}]
        model, save, error = self.run_summary(papers, [1, 2])
        self.assertIsNone(error)
        model.assert_called_once_with("Uncached", BODY, "fulltext")
        self.assertEqual(save.call_args.args[0], 2)


if __name__ == "__main__":
    unittest.main()
