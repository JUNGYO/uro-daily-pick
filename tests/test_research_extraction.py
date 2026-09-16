"""Synthetic project extraction tests. No model, cloud, publisher, or scheduled-task calls."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import research_extraction as research
import institution_worker as worker
import local_summary as spark
from evidence import source_blocks

BODY = "Methods: Six participants received therapy.\nResults: Endpoint 17 was reported.\nLimitations: Short follow-up."


def request(body=BODY, pmid="123"):
    title = "Synthetic controlled study"
    return {"version": 1, "workspace_revision": 2, "collection_id": 8, "reference_id": 9,
        "question": "Compare measured results", "template": "general",
        "columns": [{"id": "population", "label": "Population", "instruction": "Report sample size"},
                    {"id": "outcome", "label": "Outcome", "instruction": "Report endpoint"}],
        "paper": {"id": 10, "pmid": pmid, "doi": "10.1000/synthetic", "title": title},
        "source": {"content_hash": hashlib.sha256(body.encode()).hexdigest(),
            "summary_source_hash": hashlib.sha256(("fulltext\n" + title + "\n" + body).encode()).hexdigest()}}


def job(number=1, req=None):
    return {"id": number, "lease_token": f"00000000-0000-4000-8000-{number:012d}", "request": req or request()}


def result(req=None):
    return {"version": 1, "values": {"population": "6명", "outcome": "17의 측정 결과"},
        "evidence": {"population": [source_blocks(BODY)[0]["id"]], "outcome": [source_blocks(BODY)[1]["id"]]},
        "model": research.MODEL_LABEL}


def save_original(directory, req=None, body=BODY, archive=False):
    req = req or request(body)
    folder = directory / ("cloud-archive" if archive else "documents")
    folder.mkdir(exist_ok=True)
    document = {"content_text": body, "content_hash": hashlib.sha256(body.encode()).hexdigest(), "sections": [], "source_url": "https://example.invalid/"}
    value = {"paper": req["paper"], "document": document} if archive else {**req["paper"], "document": document}
    path = folder / (req["paper"]["pmid"] + ".json")
    path.write_text(json.dumps(value), encoding="utf-8")
    return path, document


class ResearchExtractionTests(unittest.TestCase):
    def test_request_rejects_unknown_fields_paths_hashes_and_duplicate_columns(self):
        mutations = [lambda q: q.update(content_text=BODY), lambda q: q["paper"].update(pmid="../worker"),
            lambda q: q["source"].update(content_hash="fake"), lambda q: q["columns"].append(q["columns"][0]),
            lambda q: q["paper"].update(id=True), lambda q: q["columns"][0].update(raw_body=BODY)]
        for mutation in mutations:
            req = request(); mutation(req)
            with self.subTest(req=req), self.assertRaises(ValueError): research.validate_request(req)

    def test_original_requires_local_identity_content_and_summary_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            path, document = save_original(directory)
            self.assertEqual(research.load_original(directory, request()), document)
            for field, wrong in [("content_hash", "0" * 64), ("summary_source_hash", "1" * 64)]:
                req = request(); req["source"][field] = wrong
                with self.assertRaises(research.ResearchSourceUnavailable): research.load_original(directory, req)
            for key, wrong in [("title", "Unrelated title"), ("doi", "10.1000/wrong"), ("pmid", "124")]:
                data = json.loads(path.read_text()); data[key] = wrong
                path.write_text(json.dumps(data))
                with self.assertRaises(research.ResearchSourceUnavailable): research.load_original(directory, request())
                save_original(directory)
            data = json.loads(path.read_text()); data["document"]["content_text"] += "tampered"
            path.write_text(json.dumps(data))
            with self.assertRaises(research.ResearchSourceUnavailable): research.load_original(directory, request())

    def test_legacy_local_archive_is_verified_without_cloud_body_reads(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            _, document = save_original(directory, archive=True)
            self.assertEqual(research.load_original(directory, request()), document)

    def test_each_value_needs_real_local_evidence_and_anchored_numbers(self):
        blocks = {b["id"]: b["text"] for b in source_blocks(BODY)}
        self.assertEqual(research.validate_result(result(), request(), blocks), result())
        for mutate in [lambda r: r["values"].update(outcome="99"),
            lambda r: r["evidence"].update(outcome=["p-9999999"]),
            lambda r: r["evidence"].update(outcome=[source_blocks(BODY)[0]["id"]]),
            lambda r: r["evidence"].update(outcome=[]),
            lambda r: r["values"].update(outcome=""), lambda r: r.update(content_text=BODY)]:
            data = result(); mutate(data)
            with self.assertRaises(ValueError): research.validate_result(data, request(), blocks)
        empty = result(); empty["values"]["outcome"] = ""; empty["evidence"]["outcome"] = []
        research.validate_result(empty, request(), blocks)

    def test_verbatim_article_body_is_not_a_derived_cell(self):
        body = "Original article sentence with full narrative evidence and methods. " * 6
        req = request(body); blocks = {b["id"]: b["text"] for b in source_blocks(body)}
        data = result(); data["values"] = {"population": body.strip(), "outcome": ""}
        data["evidence"] = {"population": [next(iter(blocks))], "outcome": []}
        with self.assertRaisesRegex(ValueError, "paraphrase"): research.validate_result(data, req, blocks)

    def test_custom_contract_uses_existing_chat_and_does_not_require_daily_qa(self):
        raw = {k: result()[k] for k in ("values", "evidence")}
        with patch.object(research, "chat", return_value=json.dumps(raw)) as call:
            output = research.extract(request(), {"content_text": BODY}, time.monotonic() + 30)
        self.assertEqual(output, result())
        args = call.call_args.args
        self.assertIn("untrusted", args[0]); self.assertIn("source", json.loads(args[1]))
        self.assertEqual(set(args[2]["properties"]), {"values", "evidence"})
        self.assertNotIn("qa", output); self.assertNotIn("summary_ko", output)
        self.assertEqual(spark.ENDPOINT, "http://127.0.0.1:18000")

    def test_long_body_visits_all_blocks_and_resumes_validated_chunk_checkpoint(self):
        body = ("No measured result in this source paragraph.\n" * 900) + "Endpoint 17."
        req = request(body)
        sources = []
        def respond(system, content, schema, deadline=None):
            source = json.loads(content)["source"]; sources.append(source)
            return json.dumps({"values": {"population": "", "outcome": ""}, "evidence": {"population": [], "outcome": []}})
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "partial.json"
            count = 0
            def interrupted(*args, **kwargs):
                nonlocal count
                count += 1
                if count == 2: raise spark.SummaryBudgetExpired()
                return respond(*args, **kwargs)
            with patch.object(research, "chat", side_effect=interrupted):
                with self.assertRaises(spark.SummaryBudgetExpired): research.extract(req, {"content_text": body}, time.monotonic() + 30, cache)
            self.assertEqual(len(json.loads(cache.read_text())["results"]), 1)
            with patch.object(research, "chat", side_effect=respond) as call:
                output = research.extract(req, {"content_text": body}, time.monotonic() + 30, cache)
            self.assertEqual(call.call_count, len(research._chunk_blocks(source_blocks(body))) - 1)
            self.assertIn("Endpoint 17.", sources[-1])
            self.assertEqual(output["values"], {"population": "", "outcome": ""})
            self.assertNotIn("source paragraph", cache.read_text())

    def test_short_paragraph_ids_count_toward_chunk_context_budget(self):
        blocks = source_blocks("x\n" * 10000)
        chunks = research._chunk_blocks(blocks)
        self.assertEqual(sum(len(chunk) for chunk in chunks), len(blocks))
        self.assertTrue(all(len(research.numbered_source(chunk)) <= 18000 for chunk in chunks))

    def test_changed_workspace_does_not_reuse_old_chunk_values(self):
        req = request()
        empty = {"values": {"population": "", "outcome": ""}, "evidence": {"population": [], "outcome": []}}
        with tempfile.TemporaryDirectory() as temporary, patch.object(research, "chat", return_value=json.dumps(empty)) as call:
            cache = Path(temporary) / "partial.json"
            research.extract(req, {"content_text": BODY}, time.monotonic() + 30, cache)
            req["workspace_revision"] += 1
            research.extract(req, {"content_text": BODY}, time.monotonic() + 30, cache)
            self.assertEqual(call.call_count, 2)

    def test_combination_context_is_bounded_and_reduction_always_makes_progress(self):
        req = request(); req["columns"] = [{"id": f"col_{i}", "label": "Clinical detail", "instruction": "Report detail"} for i in range(6)]
        # Escapes double JSON size; these inputs previously allowed nonshrinking recursive groups.
        candidates = [{"values": {c["id"]: ('"' * 1400) + str(i) for c in req["columns"]},
            "evidence": {c["id"]: [f"p-{i:07d}"] for c in req["columns"]}} for i in range(24)]
        block_map = {f"p-{i:07d}": f"Reported finding {i}." for i in range(24)}
        calls = []
        def reduce(request, batch, blocks, source, deadline, instruction=""):
            self.assertLessEqual(len(source), 24000); calls.append(source)
            return {"values": {c["id"]: "" for c in batch}, "evidence": {c["id"]: [] for c in batch}}
        with patch.object(research, "_ask", side_effect=reduce):
            merged = research._combine(req, req["columns"], candidates, block_map, time.monotonic() + 30)
        self.assertLess(len(calls), 150)
        self.assertTrue(all(v == "" for v in merged["values"].values()))

    def test_budget_yield_requires_durable_validated_progress_and_can_exceed_three_leases(self):
        service = Mock(); count = 0
        def rpc(name, **kwargs):
            nonlocal count
            if name == "claim_research_extractions":
                count += 1
                return [job()] if count <= 6 else []
            return True if name == "finish_research_extraction" else None
        service.rpc.side_effect = rpc
        attempts = 0
        def extract(request, document, deadline, cache, progress=None):
            nonlocal attempts
            attempts += 1
            if attempts <= 4:
                progress(); raise spark.SummaryBudgetExpired()
            if attempts == 5: raise spark.SummaryBudgetExpired()
            return result()
        with tempfile.TemporaryDirectory() as temporary, patch.object(research, "load_original", return_value={"content_text": BODY}), \
                patch.object(research, "extract", side_effect=extract), patch.object(research, "ensure_server"), contextlib.redirect_stdout(io.StringIO()):
            actual = research.run_research_queue(Path(temporary), 60, service)
        codes = [c.kwargs["p_error_code"] for c in service.rpc.call_args_list if c.args[0] == "fail_research_extraction"]
        self.assertEqual(codes, ["budget_yield"] * 4 + ["retryable_error"])
        self.assertEqual(actual["completed"], 1)

    def test_rpc_allowlist_rejects_raw_payloads_before_network_and_checks_claims(self):
        service = object.__new__(worker.Service); service.config = {"id": "worker"}; service.token = "token"
        service.request = Mock(return_value=True)
        service.rpc("finish_research_extraction", p_job_id=1, p_lease_token=job()["lease_token"], p_request=request(), p_result=result())
        payload = service.request.call_args.args[1]
        self.assertNotIn("content_text", json.dumps(payload)); self.assertNotIn(BODY, json.dumps(payload))
        service.request.reset_mock()
        for name, values in [("claim_research_extractions", {"p_limit": True}),
            ("finish_research_extraction", {"p_job_id": 1, "p_document": {"content_text": BODY}}),
            ("fail_research_extraction", {"p_job_id": 1, "p_lease_token": job()["lease_token"], "p_error_code": BODY})]:
            with self.assertRaises(ValueError): service.rpc(name, **values)
        service.request.assert_not_called()
        service.request.return_value = [dict(job(), document=BODY)]
        with self.assertRaises(ValueError): service.rpc("claim_research_extractions", p_limit=1)

    def test_queue_drains_multiple_jobs_and_keeps_source_unavailable_retryable(self):
        service = Mock(); pending = [job(1), job(2), job(3)]
        def rpc(name, **kwargs):
            if name == "claim_research_extractions": return [pending.pop(0)] if pending else []
            return True if name == "finish_research_extraction" else None
        service.rpc.side_effect = rpc
        with tempfile.TemporaryDirectory() as temporary, patch.object(research, "load_original", side_effect=[research.ResearchSourceUnavailable(), {"content_text": BODY}, {"content_text": BODY}]), \
                patch.object(research, "extract", return_value=result()), patch.object(research, "ensure_server") as ready, contextlib.redirect_stdout(io.StringIO()):
            actual = research.run_research_queue(Path(temporary), 60, service)
        self.assertEqual(actual, {"completed": 2, "failed": 1}); ready.assert_called_once()
        service.rpc.assert_any_call("fail_research_extraction", p_job_id=1, p_lease_token=job()["lease_token"], p_error_code="source_unavailable")
        self.assertEqual(sum(c.args[0] == "finish_research_extraction" for c in service.rpc.call_args_list), 2)

    def test_changed_source_drops_superseded_completion_without_failing_new_job(self):
        service = Mock(); service.rpc.side_effect = [[job()], research.ResearchLeaseSuperseded(), []]
        with tempfile.TemporaryDirectory() as temporary, patch.object(research, "load_original", return_value={"content_text": BODY}), \
                patch.object(research, "extract", return_value=result()), patch.object(research, "ensure_server"), contextlib.redirect_stdout(io.StringIO()):
            research.run_research_queue(Path(temporary), 60, service)
        self.assertNotIn("fail_research_extraction", [c.args[0] for c in service.rpc.call_args_list])

    def test_expired_budget_cannot_claim_or_infer(self):
        service = Mock()
        with tempfile.TemporaryDirectory() as temporary, patch.object(research, "chat") as chat, contextlib.redirect_stdout(io.StringIO()):
            research.run_research_queue(Path(temporary), 0, service)
            with self.assertRaises(spark.SummaryBudgetExpired):
                with spark.literature_inference_lock(Path(temporary), time.monotonic() - 1): pass
        service.rpc.assert_not_called(); chat.assert_not_called()

    def test_only_current_research_lease_errors_are_classified_as_superseded(self):
        service = object.__new__(worker.Service); service.config = {"url": "https://example.invalid", "public_key": "test"}; service.opener = Mock()
        service.opener.open.side_effect = worker.HTTPError("https://example.invalid", 409, "changed", {}, None)
        with self.assertRaises(research.ResearchLeaseSuperseded): service.request("rpc/finish_research_extraction", {})
        with self.assertRaises(research.ResearchLeaseSuperseded): service.request("rpc/fail_research_extraction", {})

    def test_research_publication_respects_reserved_service_deadline(self):
        service = object.__new__(worker.Service); service.config = {"url": "https://example.invalid", "public_key": "test"}; service.opener = Mock()
        service.research_deadline = 100
        with patch.object(worker.time, "monotonic", return_value=101):
            with self.assertRaises(TimeoutError): service.request("rpc/finish_research_extraction", {})
        service.opener.open.assert_not_called()

    def test_summary_scope_locks_each_inference_and_restores_previous_configuration(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(spark, "summary_inference_lock") as lock, \
                patch.object(spark, "local_request", return_value={"choices": [{"finish_reason": "stop", "message": {"content": "{}"}}]}):
            lock.return_value = contextlib.nullcontext()
            with spark.literature_inference_scope(Path(temporary)):
                spark.chat("summary", "source"); spark.chat("summary", "source")
            self.assertEqual(lock.call_count, 2)
            spark.chat("summary", "source")
            self.assertEqual(lock.call_count, 2)

    def test_inference_telemetry_never_logs_article_model_content_or_unknown_usage(self):
        response = {"choices": [{"finish_reason": "stop", "message": {"content": "private model answer"}}],
                    "usage": {"prompt_tokens": 123, "completion_tokens": 45,
                              "unexpected": "private usage detail"}}
        output = io.StringIO()
        with patch.object(spark, "local_request", return_value=response), contextlib.redirect_stdout(output):
            self.assertEqual(spark.chat("private prompt", "private article"), "private model answer")
        log = output.getvalue()
        self.assertIn('"prompt_tokens": 123', log)
        self.assertIn('"completion_tokens": 45', log)
        self.assertIn('"lock_seconds":', log)
        self.assertIn('"model_seconds":', log)
        self.assertNotIn('private', log)


if __name__ == "__main__":
    unittest.main()
