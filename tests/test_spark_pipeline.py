"""No real model, browser or service calls: verify the Z8/Spark data boundary."""
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
from http.client import IncompleteRead
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import institution_worker as worker
import local_summary as spark
from evidence import BASE_FIELDS, DETAIL_FIELDS, source_blocks, validate_evidence
from check_fulltext_queue import assess

BODY="The study enrolled six participants. The measured endpoint was 17. "*40
HTML=f'<article><h2>Methods</h2><p>{BODY}</p><h2>Results</h2><p>Endpoint 17.</p></article>'


def derived(paper,document):
    result = {"summary_ko":"연구 설계를 평가했다.\n주요 결과가 보고되었다.\n추가 검증이 필요하다.",
        "structured_data":dict.fromkeys(["study_design","sample_size","key_finding","population"],"Not reported"),
        "clinical_relevance":3,"qa_data":[{"q":"한계는?","a":"추가 검증."}],"summary_model":spark.MODEL_LABEL,
        "summary_source_hash":hashlib.sha256(("fulltext\n"+paper["title"]+"\n"+document["content_text"]).encode()).hexdigest()}
    location = source_blocks(document["content_text"])[0]["id"]
    claims = dict.fromkeys((*BASE_FIELDS, *DETAIL_FIELDS), [])
    claims.update({key:[location] for key in ("summary_1", "summary_2", "summary_3", "qa_1")})
    support = validate_evidence({"research_details":dict.fromkeys(DETAIL_FIELDS,"Not reported"),
                                "evidence":claims}, result, document["content_text"])
    return {**result, **support}


class SparkPipelineTests(unittest.TestCase):
    def test_collection_does_not_wait_for_spark_or_publish_originals(self):
        papers=[{"pmid":str(n),"doi":"10.1000/study","title":"Synthetic study"} for n in (1,2)]
        service=Mock(); service.candidates.return_value=papers
        browser=Mock(); browser.read.return_value={"status":"downloaded","title":"Synthetic study","doi":"10.1000/study", "html":HTML,"url":"https://link.springer.com/article/10.1000/study"}
        with tempfile.TemporaryDirectory() as temporary, \
             patch.dict(sys.modules,{"msvcrt":SimpleNamespace(locking=lambda *a:None,LK_NBLCK=1)}), \
             patch.object(worker,"Service",return_value=service), patch.object(worker,"Browser",return_value=browser), \
             patch.object(worker,"fetch_oa",side_effect=worker.FulltextUnavailable()), \
             patch.object(worker,"ensure_server") as readiness, patch.object(worker,"generate_summary") as summary, \
             patch.object(worker.time,"sleep"), contextlib.redirect_stdout(io.StringIO()):
            directory=Path(temporary)
            worker.run(directory,Path("node.exe"),60,phase="collect")
            self.assertEqual(len(list((directory/"documents").glob("[12].json"))),2)
            readiness.assert_not_called(); summary.assert_not_called()
            service.rpc.assert_not_called()
            self.assertEqual(service.register_original.call_count,2)

    def test_summary_queue_uses_local_bodies_without_opening_a_publisher(self):
        paper={"pmid":"1","doi":"10.1000/study","title":"Synthetic study"}
        document={**worker.parse_document(HTML.encode()),"source_url":"https://link.springer.com/article/10.1000/study"}
        service=Mock(); service.candidates.return_value=[paper,{**paper,"pmid":"2"}]; service.rpc.return_value=None
        with tempfile.TemporaryDirectory() as temporary, \
             patch.dict(sys.modules,{"msvcrt":SimpleNamespace(locking=lambda *a:None,LK_NBLCK=1)}), \
             patch.object(worker,"Service",return_value=service), patch.object(worker,"Browser") as browser, \
             patch.object(worker,"fetch_oa") as fetch, patch.object(worker,"ensure_server"), \
             patch.object(worker,"generate_summary",return_value=derived(paper,document)) as summary, \
             patch.object(worker.time,"sleep"), contextlib.redirect_stdout(io.StringIO()):
            directory=Path(temporary); (directory/"documents").mkdir()
            worker.save_json(directory/"documents/1.json",{**paper,"document":document})
            worker.run(directory,Path("node.exe"),60,phase="summarize")
            browser.assert_not_called(); fetch.assert_not_called()
            self.assertEqual(summary.call_count,1)
            self.assertIsNotNone(summary.call_args.kwargs["deadline"])
            self.assertTrue((directory/"documents/1.summary.json").exists())

    def test_expired_summary_budget_never_starts_another_model_request(self):
        with patch.object(spark.time,"monotonic",return_value=10), patch.object(spark,"local_request") as call:
            with self.assertRaises(spark.SummaryBudgetExpired):
                spark.chat("summary",BODY,deadline=9)
            call.assert_not_called()

    def test_long_article_evidence_resumes_after_a_budget_interruption(self):
        paper={"title":"Synthetic long article"}
        document={"content_text":BODY*30}
        chunks=(len(document["content_text"])+17999)//18000
        expected=derived(paper,document)
        raw={"summary_ko":expected["summary_ko"],"structured":expected["structured_data"],
             "clinical_relevance":expected["clinical_relevance"],"qa":expected["qa_data"],
             "research_details":expected["research_details"],"evidence":expected["evidence"]["claims"]}
        first_location=source_blocks(document["content_text"])[0]["id"]
        first_note=f"[{first_location}] The study enrolled six participants; the measured endpoint was 17."
        def reply(_system,content,schema=None,**_kwargs):
            if schema is not None:
                return json.dumps(raw,ensure_ascii=False)
            location=content.split("]",1)[0].lstrip("[")
            return f"[{location}] The study enrolled six participants; the measured endpoint was 17."
        with tempfile.TemporaryDirectory() as temporary:
            cache=Path(temporary)/"evidence.json"
            with patch.object(spark,"chat",side_effect=[first_note,spark.SummaryBudgetExpired()]):
                with self.assertRaises(spark.SummaryBudgetExpired):
                    spark.generate_summary(paper,document,cache_path=cache)
            self.assertEqual(json.loads(cache.read_text())["notes"],[first_note])
            with patch.object(spark,"chat",side_effect=reply) as chat:
                result=spark.generate_summary(paper,document,cache_path=cache)
            self.assertEqual(chat.call_count,chunks)  # remaining chunks plus final summary
            self.assertEqual(result["summary_source_hash"],derived(paper,document)["summary_source_hash"])

    @unittest.skipUnless(os.name=="nt","Windows byte-range lock")
    def test_overlapping_scheduled_run_exits_cleanly_before_service_access(self):
        import msvcrt
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)
            with (directory/"worker.lock").open("w+b") as lock:
                lock.write(b"0"); lock.flush(); lock.seek(0)
                msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
                try:
                    with patch.object(worker,"Service") as service, contextlib.redirect_stdout(io.StringIO()):
                        worker.run(directory,Path("node.exe"),60)
                    service.assert_not_called()
                finally:
                    lock.seek(0); msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)

    def test_interrupted_service_response_retries_without_losing_checkpoint(self):
        service=object.__new__(worker.Service)
        service.config={"url":"https://example.invalid","public_key":"test"}
        service.opener=MagicMock()
        response=service.opener.open.return_value.__enter__.return_value
        response.read.side_effect=[IncompleteRead(b"partial"),worker.ssl.SSLError("transient TLS read"),b'{"saved":true}']
        with patch.object(worker.time,"sleep"):
            self.assertEqual(service.request("rpc/test",{"hash":"checkpoint"}),{"saved":True})
        self.assertEqual(service.opener.open.call_count,3)

    def test_reuses_existing_spark_and_sends_only_explicit_model_messages(self):
        with patch.object(spark,"local_request",side_effect=[{"data":[{"id":spark.MODEL}]},
                {"choices":[{"finish_reason":"stop","message":{"content":"{}"}}]}]) as call:
            spark.ensure_server()
            spark.chat("summary instructions",BODY,spark.SCHEMA)
        self.assertEqual(call.call_args.args[0],"/v1/chat/completions")
        self.assertEqual(call.call_args.args[1]["model"],"nvidia/Qwen3.8-27B-NVFP4")
        self.assertNotIn("tools",call.call_args.args[1])
        self.assertEqual(spark.ENDPOINT,"http://127.0.0.1:18000")

    def test_raw_fields_are_rejected_before_any_service_request(self):
        service=object.__new__(worker.Service)
        service.request=Mock()
        for name,values in [("publish_institution_fulltext",{"p_document":{"content_text":BODY}}),
                ("publish_institution_summary",{"p_document":{"content_text":BODY}}),
                ("register_institution_original",{"p_document":{"content_text":BODY}})]:
            with self.assertRaises(ValueError): service.rpc(name,**values)
        service.request.assert_not_called()

    def test_acquisition_receipt_contains_provenance_without_original_text(self):
        service=object.__new__(worker.Service)
        service.rpc=Mock()
        document={**worker.parse_document(HTML.encode()),"source_url":"https://example.test/article"}
        service.register_original({"pmid":"1","title":"Study","doi":""},document)
        name=service.rpc.call_args.args[0]
        payload=service.rpc.call_args.kwargs
        self.assertEqual(name,"register_institution_original")
        self.assertEqual(set(payload["p_source"]),{"content_hash","summary_source_hash","characters","section_count","source_url"})
        self.assertNotIn(document["content_text"],json.dumps(payload))

    def exercise_queue(self,fail_first=False,archived=False,revised_title=False):
        papers=[{"pmid":str(n),"doi":"10.1000/study","title":"Synthetic study"} for n in (1,2)]
        service=Mock()
        service.candidates.return_value=papers
        service.rpc.return_value=None
        browser=Mock()
        browser.read.return_value={"status":"downloaded","title":"Synthetic study","doi":"10.1000/study",
            "html":HTML,"url":"https://link.springer.com/article/10.1000/study"}
        calls=0
        def summarize(paper,document):
            nonlocal calls
            calls+=1
            if fail_first and calls==1: raise ValueError("Invalid summary")
            return derived(paper,document)
        with tempfile.TemporaryDirectory() as temporary, \
             patch.dict(sys.modules,{"msvcrt":SimpleNamespace(locking=lambda *a:None,LK_NBLCK=1)}), \
             patch.object(worker,"Service",return_value=service),patch.object(worker,"Browser",return_value=browser), \
             patch.object(worker,"fetch_oa",side_effect=worker.FulltextUnavailable()),patch.object(worker,"ensure_server"), \
             patch.object(worker,"generate_summary",side_effect=summarize),patch.object(worker.time,"sleep"), \
             contextlib.redirect_stdout(io.StringIO()):
            directory=Path(temporary)
            if archived:
                (directory/"cloud-archive").mkdir()
                document=worker.parsed_result(papers[0],browser.read.return_value)
                cached_paper={**papers[0],"title":papers[0]["title"]+"."} if revised_title else papers[0]
                worker.save_json(directory/"cloud-archive/1.json",{"paper":cached_paper,"document":document})
            worker.run(directory,Path("node.exe"),60)
            if archived:
                self.assertEqual(browser.read.call_count,1)
            self.assertIn(BODY.strip(),json.loads((directory/"documents/1.json").read_text(encoding="utf-8"))["document"]["content_text"])
            sent=[c for c in service.rpc.call_args_list if c.args[0]=="publish_institution_summary"]
            self.assertEqual(len(sent),1 if fail_first else 2)
            for call in sent:
                outgoing=json.dumps(call.kwargs)
                self.assertNotIn("content_text",outgoing)
                self.assertNotIn(BODY,outgoing)
                self.assertNotIn("sections",call.kwargs["p_source"])
        return service

    def test_multiple_papers_are_saved_locally_and_only_summaries_are_published(self):
        self.exercise_queue()

    def test_existing_cloud_archive_is_reused_for_qwen_resummary(self):
        self.exercise_queue(archived=True)

    def test_corrected_title_reuses_matching_doi_archive_with_new_summary_hash(self):
        self.exercise_queue(archived=True,revised_title=True)

    def test_cache_title_corrections_require_matching_doi_and_similar_title(self):
        paper={"title":"Structured prostate cancer clinical study","doi":"10.1000/study"}
        self.assertTrue(worker.cached_paper_matches({**paper,"title":paper["title"]+"."},paper))
        self.assertFalse(worker.cached_paper_matches({**paper,"doi":"10.1000/another"},paper))
        self.assertFalse(worker.cached_paper_matches({**paper,"title":"Unrelated bladder article"},paper))
        self.assertFalse(worker.cached_paper_matches({"title":paper["title"]+".","doi":""},{**paper,"doi":""}))
        with self.assertRaises(ValueError):worker.verify_cached_body({"content_text":"changed","content_hash":"original"})

    def test_catalog_conflict_requeues_only_the_publication(self):
        service=object.__new__(worker.Service)
        service.config={"url":"https://example.invalid","public_key":"test"}
        service.opener=Mock()
        service.opener.open.side_effect=worker.HTTPError("https://example.invalid",400,"Catalog changed",{},None)
        with self.assertRaises(ValueError):service.request("rpc/publish_institution_summary",{})
        service.opener.open.side_effect=worker.HTTPError("https://example.invalid",403,"Denied",{},None)
        with self.assertRaises(RuntimeError):service.request("rpc/publish_institution_summary",{})

    def test_candidate_query_includes_old_models_with_publication_cutoff(self):
        service=object.__new__(worker.Service)
        service.request=Mock(return_value=[])
        service.candidates()
        params=service.request.call_args.kwargs["params"]
        self.assertIn("summary_model.neq."+spark.MODEL_LABEL,params["or"])
        self.assertNotIn("fetched_at",params)
        self.assertEqual(params["pub_date"],"gte.2000-01-01")

    def test_only_an_explicit_pmid_bypasses_the_automatic_cutoff(self):
        service=object.__new__(worker.Service)
        service.request=Mock(return_value=[])
        service.candidates("123")
        params=service.request.call_args.kwargs["params"]
        self.assertEqual(params["pmid"],"eq.123")
        self.assertNotIn("pub_date",params)

    def test_figures_use_catalog_dates_even_for_already_summarized_papers(self):
        service=object.__new__(worker.Service)
        service.request=Mock(side_effect=[[{"pmid":"5"}],[{"pmid":"101"}]])
        self.assertEqual(service.automatic_figure_pmids([str(i) for i in range(1,102)]),{"5","101"})
        for call in service.request.call_args_list:
            self.assertEqual(call.kwargs["params"]["pub_date"],"gte.2000-01-01")
            self.assertNotIn("or",call.kwargs["params"])

    def test_candidate_cursor_avoids_deep_offsets_and_keeps_newest_first(self):
        service=object.__new__(worker.Service)
        first=[{"id":i,"pmid":str(i),"pub_date":"2020-01-01"} for i in range(1,1001)]
        service.request=Mock(side_effect=[first,[{"id":1001,"pmid":"1001","pub_date":"2026-01-01"}]])
        result=service.candidates()
        self.assertEqual(len(result),1001)
        self.assertEqual(result[0]["pmid"],"1001")
        self.assertEqual(service.request.call_args_list[0].kwargs["params"]["id"],"gt.0")
        self.assertEqual(service.request.call_args_list[1].kwargs["params"]["id"],"gt.1000")
        for call in service.request.call_args_list:
            self.assertNotIn("offset",call.kwargs["params"])

    def test_candidate_cursor_rejects_a_nonadvancing_page(self):
        service=object.__new__(worker.Service)
        service.request=Mock(return_value=[{"id":0,"pmid":"1"}]*1000)
        with self.assertRaises(ValueError): service.candidates()

    def test_one_invalid_summary_retains_body_and_does_not_block_next_paper(self):
        service=self.exercise_queue(fail_first=True)
        service.status.assert_any_call("running","1","retryable_error")

    def test_queue_health_separates_short_offline_period_from_broken_installation(self):
        now=datetime.now(timezone.utc)
        self.assertEqual(assess({"workers":[{"last_seen_at":now.isoformat()}]},now),[])
        self.assertTrue(assess({"workers":[{"last_seen_at":(now-timedelta(hours=3)).isoformat()}]},now))
        with self.assertRaises(ValueError): assess({"workers":[]},now)
        with self.assertRaises(ValueError): assess({"workers":[{"last_seen_at":(now-timedelta(hours=25)).isoformat()}]},now)


if __name__=="__main__": unittest.main()
