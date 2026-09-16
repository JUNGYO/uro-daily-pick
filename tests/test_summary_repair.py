"""Exercise real summary validation with synthetic originals and mocked model replies."""
import copy
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import local_summary as spark
from evidence import BASE_FIELDS, DETAIL_FIELDS, source_blocks, validate_evidence, validate_metadata
from summarize_papers import validate_summary
from summary_repair import apply_repairs, claim_issues
from summary_wire import SourceAliases

PAPER = {"title": "Synthetic prospective cohort"}
BODY = ("Methods\nA prospective cohort enrolled 60 adults.\n"
        "Results\nThe primary endpoint occurred in 17 participants.\n"
        "Limitations\nFollow-up was incomplete and interpretation requires caution.")


def draft(body=BODY):
    blocks = source_blocks(body)
    methods = next(b["id"] for b in blocks if "enrolled 60" in b["text"])
    results = next(b["id"] for b in blocks if "in 17 participants" in b["text"])
    limitations = next(b["id"] for b in blocks if "interpretation requires caution" in b["text"])
    claims = dict.fromkeys((*BASE_FIELDS, *DETAIL_FIELDS), [])
    claims.update(summary_1=[methods], summary_2=[results], summary_3=[limitations],
                  sample_size=[methods], key_finding=[results], qa_1=[results])
    return {
        "summary_ko": "성인 60명을 대상으로 전향적 코호트 연구를 수행했다.\n주요 평가변수는 17명에서 발생했다.\n추적 관찰의 불완전성 때문에 해석에 주의가 필요하다.",
        "structured": {**dict.fromkeys(BASE_FIELDS, "Not reported"),
                       "sample_size": "60 adults", "key_finding": "17 participants"},
        "clinical_relevance": 3,
        "qa": [{"q": "주요 평가변수는 몇 명에서 발생했는가?", "a": "17명에서 발생했다."}],
        "research_details": dict.fromkeys(DETAIL_FIELDS, "Not reported"),
        "evidence": claims,
    }


def encoded(value):
    return json.dumps(value, ensure_ascii=False)


def model_reply(value, body=BODY):
    wire = copy.deepcopy(value)
    aliases = SourceAliases(source_blocks(body))
    if 'evidence' in wire:
        wire['evidence'] = {key: aliases.encode_refs(refs) for key, refs in wire['evidence'].items()}
    else:
        for change in wire.values():
            change['sources'] = aliases.encode_refs(change['sources'])
    return encoded(wire)


def result_patch(raw, key="summary_2"):
    return {key: {"text": raw["summary_ko"].splitlines()[1], "sources": raw["evidence"][key]}}


class SummaryRepairTests(unittest.TestCase):
    def test_initial_model_wire_requires_exactly_three_separate_summary_strings(self):
        schema = spark._summary_schema(source_blocks(BODY))
        self.assertIn("summary_lines", schema["required"])
        self.assertNotIn("summary_ko", schema["properties"])
        self.assertNotIn("summary_ko", schema["required"])
        field = schema["properties"]["summary_lines"]
        self.assertEqual(field["type"], "array")
        self.assertEqual((field["minItems"], field["maxItems"]), (3, 3))
        self.assertEqual(field["items"]["type"], "string")
        self.assertEqual(field["items"]["maxLength"], 220)

    def test_three_model_strings_become_existing_publication_shape_with_unchanged_evidence(self):
        canonical = draft()
        wire = copy.deepcopy(canonical)
        wire["summary_lines"] = wire.pop("summary_ko").splitlines()
        paper = {**PAPER, "pmid": "123", "doi": "10.1000/synthetic"}
        document = {"content_text": BODY, "content_hash": hashlib.sha256(BODY.encode()).hexdigest(),
                    "sections": ["Methods", "Results"], "source_url": "https://example.test/article"}
        with patch.object(spark, "chat", return_value=model_reply(wire)) as chat:
            result = spark.generate_summary(paper, document)
        self.assertEqual(chat.call_count, 1)
        self.assertEqual(result["summary_ko"], canonical["summary_ko"])
        self.assertEqual(result["summary_ko"].count("\n"), 2)
        self.assertEqual(result["evidence"]["claims"], canonical["evidence"])
        payload = spark.summary_payload(paper, document, result)
        self.assertEqual(payload["p_summary"]["summary_ko"], canonical["summary_ko"])
        self.assertNotIn("summary_lines", payload["p_summary"])
        self.assertNotIn("content_text", payload["p_source"])
        self.assertEqual(spark.validate_cached_summary(result, paper, document), result)

    def test_initial_wire_rejects_wrong_array_length_and_embedded_newlines(self):
        canonical = draft()
        lines = canonical["summary_ko"].splitlines()
        invalid = [lines[:1], lines + [lines[0]],
                   [lines[0], lines[1] + "\n추가 문장이다.", lines[2]],
                   [lines[0], lines[1] + "\r추가 문장이다.", lines[2]],
                   [lines[0], "", lines[2]], [lines[0], None, lines[2]],
                   [lines[0], "가" * 221, lines[2]]]
        for values in invalid:
            wire = copy.deepcopy(canonical)
            wire.pop("summary_ko")
            wire["summary_lines"] = values
            with self.subTest(values=values), self.assertRaises(ValueError):
                spark._initial_draft(encoded(wire))

    def test_initial_parser_preserves_canonical_cached_draft_compatibility(self):
        canonical = draft()
        self.assertEqual(spark._initial_draft(encoded(canonical)), canonical)

    def test_model_response_cannot_bypass_alias_contract_with_canonical_source_strings(self):
        with patch.object(spark, "chat", return_value=encoded(draft())) as chat:
            with self.assertRaisesRegex(ValueError, "source alias"):
                spark.generate_summary(PAPER, {"content_text": BODY})
        self.assertEqual(chat.call_count, 1)

    def test_unknown_canonical_id_in_cached_draft_is_not_silently_remapped(self):
        invalid = draft()
        invalid["evidence"]["summary_2"] = invalid["evidence"]["summary_1"]
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "evidence.json"
            with patch.object(spark, "chat", side_effect=[model_reply(invalid), spark.SummaryBudgetExpired()]):
                with self.assertRaises(spark.SummaryBudgetExpired):
                    spark.generate_summary(PAPER, {"content_text": BODY}, cache_path=cache)
            path = cache.with_suffix(".draft.json")
            checkpoint = json.loads(path.read_text(encoding="utf-8"))
            checkpoint["draft"]["evidence"]["summary_2"] = ["p-9999999"]
            path.write_text(encoded(checkpoint), encoding="utf-8")
            with patch.object(spark, "chat") as chat:
                with self.assertRaisesRegex(ValueError, "canonical citation"):
                    spark.generate_summary(PAPER, {"content_text": BODY}, cache_path=cache)
            chat.assert_not_called()
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), checkpoint)

    def test_malformed_model_choices_and_nontext_content_raise_validation_error(self):
        responses = [{}, {"choices": []}, {"choices": None}, {"choices": [None]},
                     {"choices": [{"finish_reason": "stop", "message": None}]},
                     *({"choices": [{"finish_reason": "stop", "message": {"content": content}}]}
                       for content in (None, 17, [], {}))]
        for response in responses:
            with self.subTest(response=response), patch.object(spark, "local_request", return_value=response) as request:
                with self.assertRaises(ValueError):
                    spark.chat("Synthetic instruction", "Synthetic input")
                self.assertEqual(request.call_count, 1)

    def test_published_evidence_rejects_boolean_version_and_invalid_detail_text(self):
        raw = draft()
        support = validate_evidence(raw, validate_summary(encoded(raw)), BODY)
        cases = []
        bad = copy.deepcopy(support); bad["evidence"]["version"] = True; cases.append(bad)
        for value in ("", "\x00", "\ud800"):
            bad = copy.deepcopy(support); bad["research_details"]["outcome"] = value; cases.append(bad)
        for bad in cases:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_metadata(bad["evidence"], bad["research_details"])

    def test_summary_source_is_required_even_when_text_says_not_reported(self):
        raw = draft()
        lines = raw["summary_ko"].splitlines()
        lines[1] = "Not reported"
        raw["summary_ko"] = "\n".join(lines)
        raw["evidence"]["summary_2"] = []
        with self.assertRaises(ValueError):
            validate_evidence(raw, validate_summary(encoded(raw)), BODY)
        self.assertIn("summary_2", claim_issues(raw, BODY))

    def test_only_wrong_citation_is_repaired_and_all_valid_claims_are_preserved(self):
        valid = draft()
        invalid = copy.deepcopy(valid)
        invalid["evidence"]["summary_2"] = invalid["evidence"]["summary_1"]
        original = copy.deepcopy(invalid)
        with patch.object(spark, "chat", side_effect=[model_reply(invalid), model_reply(result_patch(valid))]) as chat:
            result = spark.generate_summary(PAPER, {"content_text": BODY})
        self.assertEqual(chat.call_count, 2)
        request = json.loads(chat.call_args_list[1].args[1])
        self.assertEqual(set(request["failed_claims"]), {"summary_2"})
        feedback = request["failed_claims"]["summary_2"]["numeric_feedback"]
        self.assertEqual(feedback["absent_from_cited"], ["17"])
        self.assertEqual(feedback["present_elsewhere_in_body"], ["17"])
        self.assertEqual(feedback["absent_from_body"], [])
        self.assertEqual(result["summary_ko"], valid["summary_ko"])
        self.assertEqual(result["structured_data"], valid["structured"])
        self.assertEqual(result["qa_data"], valid["qa"])
        self.assertEqual(result["research_details"], valid["research_details"])
        self.assertEqual(result["evidence"]["claims"], valid["evidence"])
        self.assertEqual(invalid, original)
        self.assertEqual(spark.validate_cached_summary(result, PAPER, {"content_text": BODY}), result)

    def test_unsupported_question_number_repairs_question_and_answer_together(self):
        valid = draft()
        invalid = copy.deepcopy(valid)
        invalid["qa"][0]["q"] = "18명에서 발생했는가?"
        self.assertEqual(set(claim_issues(invalid, BODY)), {"qa_1"})
        repaired = {"qa_1": {**valid["qa"][0], "sources": valid["evidence"]["qa_1"]}}
        with patch.object(spark, "chat", side_effect=[model_reply(invalid), model_reply(repaired)]) as chat:
            result = spark.generate_summary(PAPER, {"content_text": BODY})
        request = json.loads(chat.call_args_list[1].args[1])
        self.assertEqual(set(request["failed_claims"]), {"qa_1"})
        self.assertEqual(request["failed_claims"]["qa_1"]["question"], invalid["qa"][0]["q"])
        self.assertEqual(request["failed_claims"]["qa_1"]["numeric_feedback"]["question_absent_from_body"], ["18"])
        self.assertEqual(result["qa_data"], valid["qa"])
        self.assertEqual(result["summary_ko"], valid["summary_ko"])

    def test_repeated_unsupported_question_is_rejected_after_bounded_repairs(self):
        invalid = draft()
        invalid["qa"][0]["q"] = "18명에서 발생했는가?"
        rejected = {"qa_1": {**invalid["qa"][0], "sources": invalid["evidence"]["qa_1"]}}
        with patch.object(spark, "chat", side_effect=[model_reply(invalid), model_reply(rejected), model_reply(rejected)]) as chat:
            with self.assertRaisesRegex(ValueError, "qa_1"):
                spark.generate_summary(PAPER, {"content_text": BODY})
        self.assertEqual(chat.call_count, 3)

    def test_model_schemas_enumerate_only_original_or_supplied_excerpt_locations(self):
        valid = draft()
        invalid = copy.deepcopy(valid)
        invalid["evidence"]["summary_2"] = invalid["evidence"]["summary_1"]
        with patch.object(spark, "chat", side_effect=[model_reply(invalid), model_reply(result_patch(valid))]) as chat:
            spark.generate_summary(PAPER, {"content_text": BODY})
        first_schema = chat.call_args_list[0].args[2]
        self.assertEqual(set(first_schema["$defs"]["source_id"]["enum"]), set(range(1, len(source_blocks(BODY)) + 1)))
        content = json.loads(chat.call_args_list[1].args[1])
        excerpt_ids = {int(value) for value in re.findall(r"\[(\d+)\]", content["source"])}
        self.assertEqual(content["failed_claims"]["summary_2"]["sources"], [2])
        repair_schema = chat.call_args_list[1].args[2]
        self.assertEqual(set(repair_schema["$defs"]["source_id"]["enum"]), excerpt_ids)
        self.assertEqual(set(repair_schema["properties"]), {"summary_2"})
        self.assertFalse(repair_schema["additionalProperties"])

    def test_patch_cannot_change_valid_claims_or_use_an_unoffered_source_id(self):
        valid = draft()
        repair = result_patch(valid)
        offered = valid["evidence"]["summary_2"]
        invalid_cases = [
            {**repair, "summary_1": {"text": "변경된 문장이다.", "sources": offered}},
            {},
            {"summary_2": {**repair["summary_2"], "sources": valid["evidence"]["summary_1"]}},
            {"summary_2": {**repair["summary_2"], "sources": ["p-9999999"]}},
            {"summary_2": {**repair["summary_2"], "sources": offered * 2}},
            {"summary_2": {**repair["summary_2"], "content_text": "Synthetic extra content"}},
        ]
        for value in invalid_cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                apply_repairs(valid, value, ["summary_2"], offered)
        self.assertEqual(valid, draft())

    def test_a_repaired_field_still_has_to_pass_numeric_and_source_validation(self):
        valid = draft()
        invalid = copy.deepcopy(valid)
        invalid["evidence"]["summary_2"] = invalid["evidence"]["summary_1"]
        fabricated = {"summary_2": {"text": "주요 평가변수는 99명에서 발생했다.",
                                      "sources": valid["evidence"]["summary_2"]}}
        with patch.object(spark, "chat", side_effect=[model_reply(invalid), model_reply(fabricated), model_reply(fabricated)]) as chat:
            with self.assertRaisesRegex(ValueError, "summary_2"):
                spark.generate_summary(PAPER, {"content_text": BODY})
        self.assertEqual(chat.call_count, 3)

    def test_invalid_publication_shape_cannot_be_accepted_as_a_repaired_field(self):
        valid = draft()
        offered = valid["evidence"]["summary_2"]
        for text in ("두 줄로\n바뀐 문장", "가" * 2001, "금지\x00문자", ""):
            with self.subTest(text=text[:20]), self.assertRaises(ValueError):
                apply_repairs(valid, {"summary_2": {"text": text, "sources": offered}}, ["summary_2"], offered)

    def test_interrupted_repair_resumes_saved_draft_without_another_full_summary(self):
        valid = draft()
        invalid = copy.deepcopy(valid)
        invalid["evidence"]["summary_2"] = invalid["evidence"]["summary_1"]
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "evidence.json"
            with patch.object(spark, "chat", side_effect=[model_reply(invalid), spark.SummaryBudgetExpired()]):
                with self.assertRaises(spark.SummaryBudgetExpired):
                    spark.generate_summary(PAPER, {"content_text": BODY}, cache_path=cache)
            checkpoint = json.loads(cache.with_suffix(".draft.json").read_text(encoding="utf-8"))
            self.assertEqual(checkpoint["draft"], invalid)
            with patch.object(spark, "chat", return_value=model_reply(result_patch(valid))) as chat:
                result = spark.generate_summary(PAPER, {"content_text": BODY}, cache_path=cache)
            self.assertEqual(chat.call_count, 1)
            request = json.loads(chat.call_args.args[1])
            self.assertEqual(set(request["failed_claims"]), {"summary_2"})
            self.assertEqual(result["evidence"]["claims"], valid["evidence"])
            self.assertFalse(list(Path(temporary).glob("*.pending")))

    def test_stale_title_or_body_draft_is_ignored_instead_of_patching_old_claims(self):
        invalid = draft()
        invalid["evidence"]["summary_2"] = invalid["evidence"]["summary_1"]
        for paper, body in (({"title": "Different synthetic title"}, BODY), (PAPER, BODY + "\nNew observation.")):
            with self.subTest(paper=paper, body=body[-20:]), tempfile.TemporaryDirectory() as temporary:
                cache = Path(temporary) / "evidence.json"
                with patch.object(spark, "chat", side_effect=[model_reply(invalid), spark.SummaryBudgetExpired()]):
                    with self.assertRaises(spark.SummaryBudgetExpired):
                        spark.generate_summary(PAPER, {"content_text": BODY}, cache_path=cache)
                with patch.object(spark, "chat", return_value=model_reply(draft(body), body)) as chat:
                    result = spark.generate_summary(paper, {"content_text": body}, cache_path=cache)
                self.assertEqual(chat.call_count, 1)
                request = json.loads(chat.call_args.args[1])
                self.assertEqual(request["source_type"], "fulltext")
                self.assertNotIn("failed_claims", request)
                self.assertEqual(result["summary_source_hash"], hashlib.sha256(("fulltext\n" + paper["title"] + "\n" + body).encode()).hexdigest())

    def test_completed_cache_rechecks_provenance_and_claim_values(self):
        with patch.object(spark, "chat", return_value=model_reply(draft())):
            result = spark.generate_summary(PAPER, {"content_text": BODY})
        self.assertEqual(spark.validate_cached_summary(result, PAPER, {"content_text": BODY}), result)
        cases = []
        bad = copy.deepcopy(result); bad["summary_model"] = "spark/older-model"; cases.append(bad)
        bad = copy.deepcopy(result); bad["summary_source_hash"] = "f" * 64; cases.append(bad)
        bad = copy.deepcopy(result); bad["evidence"]["content_hash"] = "f" * 64; cases.append(bad)
        bad = copy.deepcopy(result); bad["evidence"]["claims"]["summary_2"] = bad["evidence"]["claims"]["summary_1"]; cases.append(bad)
        bad = copy.deepcopy(result); bad["summary_ko"] = bad["summary_ko"].replace("17", "99"); cases.append(bad)
        for bad in cases:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                spark.validate_cached_summary(bad, PAPER, {"content_text": BODY})
        with self.assertRaises(ValueError):
            spark.validate_cached_summary(result, {"title": "Changed title"}, {"content_text": BODY})
        with self.assertRaises(ValueError):
            spark.validate_cached_summary(result, PAPER, {"content_text": BODY + "\nChanged original."})

    def test_malformed_alias_evidence_is_rejected_as_validation_error(self):
        valid = json.loads(model_reply(draft()))
        for evidence in (None, [], {**valid["evidence"], "summary_2": None}):
            with self.subTest(evidence=evidence):
                invalid = copy.deepcopy(valid)
                invalid["evidence"] = evidence
                with patch.object(spark, "chat", return_value=encoded(invalid)) as chat:
                    with self.assertRaises(ValueError):
                        spark.generate_summary(PAPER, {"content_text": BODY})
                self.assertEqual(chat.call_count, 1)


if __name__ == "__main__":
    unittest.main()
