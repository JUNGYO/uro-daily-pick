"""No real model, browser or service calls: verify the Z8/Spark data boundary."""
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
from http.client import IncompleteRead
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import institution_worker as worker
import local_summary as spark
from check_fulltext_queue import assess

BODY="The study enrolled six participants. The measured endpoint was 17. "*40
HTML=f'<article><h2>Methods</h2><p>{BODY}</p><h2>Results</h2><p>Endpoint 17.</p></article>'


def derived(paper,document):
    return {"summary_ko":"연구 설계를 평가했다.\n주요 결과가 보고되었다.\n추가 검증이 필요하다.",
        "structured_data":dict.fromkeys(["study_design","sample_size","key_finding","population"],"Not reported"),
        "clinical_relevance":3,"qa_data":[{"q":"한계는?","a":"추가 검증."}],"summary_model":spark.MODEL_LABEL,
        "summary_source_hash":hashlib.sha256(("fulltext\n"+paper["title"]+"\n"+document["content_text"]).encode()).hexdigest()}


class SparkPipelineTests(unittest.TestCase):
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
                ("publish_institution_summary",{"p_document":{"content_text":BODY}})]:
            with self.assertRaises(ValueError): service.rpc(name,**values)
        service.request.assert_not_called()

    def exercise_queue(self,fail_first=False):
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
            worker.run(directory,Path("node.exe"),60)
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
