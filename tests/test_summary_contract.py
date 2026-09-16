"""Synthetic model-output/DB-publication contract checks; no service calls."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from summarize_papers import validate_summary


def draft():
    return {
        "summary_ko": "연구의 설계를 확인했다.\n연구 결과를 확인했다.\n해석의 한계를 확인했다.",
        "structured": dict.fromkeys(
            ("study_design", "sample_size", "key_finding", "population"), "Not reported"),
        "clinical_relevance": 3,
        "qa": [{"q": "연구의 한계는?", "a": "Not reported"}],
    }


def three_lines(length):
    return "가" * (length - 4) + "\n나\n다"


class SummaryContractTests(unittest.TestCase):
    def test_stored_summary_length_matches_publish_rpc_inclusive_bounds(self):
        for length in (10, 2000):
            with self.subTest(length=length):
                raw = draft()
                raw["summary_ko"] = three_lines(length)
                summary = validate_summary(json.dumps(raw))
                self.assertEqual(len(summary["summary_ko"]), length)
                self.assertEqual(summary["summary_ko"].count("\n"), 2)
        for length in (5, 9, 2001, 4000):
            with self.subTest(length=length):
                raw = draft()
                raw["summary_ko"] = three_lines(length)
                with self.assertRaisesRegex(ValueError, "10..2000"):
                    validate_summary(json.dumps(raw))

    def test_length_is_checked_after_existing_line_normalization(self):
        raw = draft()
        expected = raw["summary_ko"]
        raw["summary_ko"] = " " * 2500 + expected.replace("\n", "  \r\n\r\n  ") + " " * 2500
        self.assertGreater(len(raw["summary_ko"]), 4000)
        self.assertEqual(validate_summary(json.dumps(raw))["summary_ko"], expected)
        raw["summary_ko"] = "  a  \n  b  \n  c  "
        with self.assertRaises(ValueError):
            validate_summary(json.dumps(raw))

    def test_normalization_never_truncates_four_nonempty_lines_to_three(self):
        for value in ("First line\nSecond line", "First line\nSecond line\nThird line\nFourth line", "\n \n"):
            with self.subTest(value=value):
                raw = draft()
                raw["summary_ko"] = value
                with self.assertRaisesRegex(ValueError, "three summary lines"):
                    validate_summary(json.dumps(raw))

    def test_qa_count_and_each_published_field_retain_database_limits(self):
        raw = draft()
        raw["structured"] = dict.fromkeys(raw["structured"], "가" * 1500)
        raw["qa"] = [{"q": "나" * 2000, "a": "다" * 2000} for _ in range(3)]
        result = validate_summary(json.dumps(raw))
        self.assertEqual(len(result["qa_data"]), 3)
        self.assertEqual(result["structured_data"], raw["structured"])
        for field in raw["structured"]:
            bad = copy.deepcopy(raw)
            bad["structured"][field] += "가"
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "structured"):
                validate_summary(json.dumps(bad))
        for field in ("q", "a"):
            bad = copy.deepcopy(raw)
            bad["qa"][0][field] += "나"
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "question/answer"):
                validate_summary(json.dumps(bad))
        for count in (0, 4):
            bad = copy.deepcopy(raw)
            bad["qa"] = [{"q": "Question", "a": "Answer"}] * count
            with self.subTest(count=count), self.assertRaises(ValueError):
                validate_summary(json.dumps(bad))

    def test_relevance_remains_an_integer_in_the_database_range(self):
        for value in (True, False, 3.0, "3", 0, 6):
            with self.subTest(value=value):
                raw = draft()
                raw["clinical_relevance"] = value
                with self.assertRaisesRegex(ValueError, "relevance"):
                    validate_summary(json.dumps(raw))
        for value in (1, 5):
            raw = draft()
            raw["clinical_relevance"] = value
            self.assertEqual(validate_summary(json.dumps(raw))["clinical_relevance"], value)

    def test_text_jsonb_cannot_store_is_rejected_in_every_published_text_field(self):
        paths = [("summary_ko",), *(("structured", field) for field in draft()["structured"]),
                 ("qa", 0, "q"), ("qa", 0, "a")]
        for invalid in ("\x00", "\ud800", "\udfff"):
            for path in paths:
                with self.subTest(invalid=repr(invalid), path=path):
                    raw = draft()
                    parent = raw
                    for key in path[:-1]:
                        parent = parent[key]
                    parent[path[-1]] += invalid
                    with self.assertRaises(ValueError):
                        validate_summary(json.dumps(raw))

    def test_unicode_supplementary_characters_remain_valid(self):
        raw = draft()
        raw["summary_ko"] += " \U0001f4da"
        self.assertEqual(validate_summary(json.dumps(raw))["summary_ko"], raw["summary_ko"])

    def test_raw_extensions_are_not_published_by_the_summary_allowlist(self):
        raw = draft()
        raw["content_text"] = "Synthetic untrusted extra field"
        raw["structured"]["content_text"] = "Synthetic extra field"
        raw["qa"][0]["content_text"] = "Synthetic extra field"
        raw["evidence"] = {"summary_1": ["p-0000000"]}
        result = validate_summary(json.dumps(raw))
        self.assertEqual(set(result), {"summary_ko", "structured_data", "qa_data", "clinical_relevance"})
        self.assertNotIn("content_text", result["structured_data"])
        self.assertEqual(set(result["qa_data"][0]), {"q", "a"})


if __name__ == "__main__":
    unittest.main()
