"""Local acquisition and summaries remain durable during a cloud outage."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import institution_worker as worker
from evidence import BASE_FIELDS, DETAIL_FIELDS
from local_summary import MODEL_LABEL, summary_payload
from local_service import LocalService, validate_publication_payload


class MemoryCatalog:
    def __init__(self, papers):
        self.papers = {str(row["pmid"]): copy.deepcopy(row) for row in papers}
        self.events, self.metadata = [], {}

    def candidates(self, pmid=None, include_summary=False):
        return [copy.deepcopy(row) for key, row in self.papers.items() if pmid is None or str(pmid) == key]

    worker_candidates = candidates

    def get_papers(self, pmids):
        return [self.papers[key] for key in pmids if key in self.papers]

    def enqueue(self, kind, payload):
        self.events.append((kind, copy.deepcopy(payload)))
        paper = self.papers[payload["p_pmid"]]
        paper["fulltext_available"] = True
        if kind == "original":
            source_hash = payload["p_source"]["summary_source_hash"]
            paper["acquired_source_hash"] = source_hash
            if paper.get("summary_source_hash") != source_hash:
                paper["summary_source_hash"] = None
                paper["summarized_at"] = None
        else:
            paper.update(payload["p_summary"], summary_basis="fulltext", summarized_at="2026-09-17T00:00:00Z")
        return len(self.events)

    def set_meta(self, key, value):
        self.metadata[key] = value

    def close(self):
        pass


class LocalServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        (self.directory / "documents").mkdir()
        self.paper = {"pmid": "123", "doi": "10.1000/example", "title": "Synthetic controlled study",
                      "pub_date": "2026-01-01", "fulltext_available": False}
        self.body = "The synthetic study reports methods and results. " * 60
        self.document = {"content_text": self.body, "content_hash": hashlib.sha256(self.body.encode()).hexdigest(),
                         "sections": [{"title": "Methods"}, {"title": "Results"}], "source_url": "https://example.test/paper"}
        self.source_hash = hashlib.sha256(("fulltext\n" + self.paper["title"] + "\n" + self.body).encode()).hexdigest()
        self.summary = {"summary_ko": "연구 방법을 검토했습니다.\n연구 결과를 확인했습니다.\n연구의 제한점을 살펴보았습니다.",
            "structured_data": dict.fromkeys(BASE_FIELDS, "Not reported"),
            "clinical_relevance": 3, "qa_data": [{"q": "연구의 한계는 무엇입니까?", "a": "Not reported"}],
            "summary_model": MODEL_LABEL, "summary_source_hash": self.source_hash,
            "research_details": dict.fromkeys(DETAIL_FIELDS, "Not reported"),
            "evidence": {"version": 1, "content_hash": self.document["content_hash"],
                "claims": {**{f"summary_{i}": ["p-0000000"] for i in range(1, 4)},
                           **dict.fromkeys((*BASE_FIELDS, *DETAIL_FIELDS, "qa_1"), [])}}}
        self.catalog = MemoryCatalog([self.paper])
        self.cloud = Mock()
        self.cloud.request.side_effect = RuntimeError("Cloud unavailable")
        # Dependency injection needs no initialized credentials or actual catalog.
        self.service = LocalService(self.directory, self.cloud, catalog=self.catalog)

    def tearDown(self):
        self.temp.cleanup()

    def save_original(self):
        (self.directory / "documents" / "123.json").write_text(json.dumps(
            {**self.paper, "document": self.document}), encoding="utf-8")

    def test_candidates_status_and_acquisition_are_local_while_cloud_is_unavailable(self):
        self.assertEqual([row["pmid"] for row in self.service.candidates()], ["123"])
        self.service.status("running", "123", "retryable_error")
        self.assertEqual(self.catalog.metadata["worker_status"]["state"], "running")
        self.save_original()
        self.service.register_original(self.paper, self.document)
        self.assertEqual(self.service.candidates(), [])
        self.assertEqual([row["pmid"] for row in self.service.candidates(include_summary=True)], ["123"])
        self.assertEqual(self.catalog.events[0][0], "original")
        self.assertNotIn("content_text", json.dumps(self.catalog.events))
        self.assertNotIn(self.body, json.dumps(self.catalog.events))
        self.cloud.assert_not_called()
        self.cloud.request.assert_not_called()
        self.cloud.rpc.assert_not_called()

    def test_valid_summary_is_ready_locally_while_events_are_pending_and_not_regenerated(self):
        self.save_original()
        self.service.rpc("publish_institution_summary", **summary_payload(self.paper, self.document, self.summary))
        self.assertEqual([kind for kind, _ in self.catalog.events], ["original", "summary"])
        self.assertEqual(self.service.candidates(include_summary=True), [])
        self.assertTrue(self.service.publication_is_local)
        self.assertEqual(len(self.service.candidates("123", include_summary=True)), 1)
        self.cloud.rpc.assert_not_called()

    def test_article_without_doi_can_stage_acquisition_and_summary(self):
        self.paper["doi"] = ""
        self.catalog.papers["123"]["doi"] = ""
        self.save_original()
        self.service.register_original(self.paper, self.document)
        self.service.rpc("publish_institution_summary", **summary_payload(self.paper, self.document, self.summary))
        self.assertEqual(self.catalog.events[-1][0], "summary")
        self.assertEqual(self.catalog.events[-1][1]["p_doi"], "")

    def test_new_source_or_model_is_eligible_again(self):
        self.save_original()
        self.service.rpc("publish_institution_summary", **summary_payload(self.paper, self.document, self.summary))
        self.catalog.papers["123"]["summary_model"] = "spark/older-model"
        self.assertEqual(len(self.service.candidates(include_summary=True)), 1)
        self.catalog.papers["123"]["summary_model"] = MODEL_LABEL
        self.document["content_text"] += "Changed source."
        self.document["content_hash"] = hashlib.sha256(self.document["content_text"].encode()).hexdigest()
        self.save_original()
        self.service.register_original(self.paper, self.document)
        self.assertEqual(len(self.service.candidates(include_summary=True)), 1)

    def test_body_hash_stale_summary_and_original_absence_are_rejected(self):
        payload = summary_payload(self.paper, self.document, self.summary)
        with self.assertRaises(ValueError):
            self.service.rpc("publish_institution_summary", **payload)
        self.save_original()
        self.document["content_text"] += "Tampered."
        self.save_original()
        with self.assertRaises(ValueError):
            self.service.rpc("publish_institution_summary", **payload)
        self.document["content_hash"] = hashlib.sha256(self.document["content_text"].encode()).hexdigest()
        self.save_original()
        with self.assertRaises(ValueError):
            self.service.rpc("publish_institution_summary", **payload)
        self.assertEqual(self.catalog.events, [])

    def test_nested_raw_fields_or_unbounded_values_never_enter_outbox(self):
        base = summary_payload(self.paper, self.document, self.summary)
        invalid = []
        changed = copy.deepcopy(base); changed["p_source"]["content_text"] = self.body; invalid.append(changed)
        changed = copy.deepcopy(base); changed["p_summary"]["structured_data"]["raw"] = self.body; invalid.append(changed)
        changed = copy.deepcopy(base); changed["p_summary"]["qa_data"][0]["body"] = self.body; invalid.append(changed)
        changed = copy.deepcopy(base); changed["p_summary"]["summary_ko"] = self.body + "\n둘째 줄\n셋째 줄"; invalid.append(changed)
        changed = copy.deepcopy(base); changed["p_source"]["source_url"] = "https://example.test/paper?credential=secret"; invalid.append(changed)
        for payload in invalid:
            with self.subTest(payload=sorted(payload["p_source"])), self.assertRaises(ValueError):
                validate_publication_payload("summary", payload)
        self.assertEqual(self.catalog.events, [])

    def test_figure_scope_uses_local_catalog_without_excluding_ready_papers(self):
        self.catalog.papers["1999"] = {**self.paper, "pmid": "1999", "pub_date": "1999-12-31"}
        self.catalog.papers["123"]["fulltext_available"] = True
        self.assertEqual(self.service.automatic_figure_pmids(["123", "1999"]), {"123"})
        self.assertEqual([row["pmid"] for row in self.service.candidates("1999")], ["1999"])
        self.cloud.request.assert_not_called()

    def test_cloud_acquisition_marker_without_local_original_does_not_skip_collection(self):
        self.catalog.papers["123"]["fulltext_available"] = True
        self.assertEqual(len(self.service.candidates()), 1)
        self.assertEqual(self.service.candidates(include_summary=True), [])

    def test_empty_start_waits_for_local_discovery_and_checks_again_after_batch(self):
        clock = [0]
        service = Mock()
        service.candidates.side_effect = [[], [self.paper], []]
        cycle = Mock(return_value={"completed": 1})
        def sleep(seconds): clock[0] += seconds
        counts = worker.run_local_cycles(service, 65, "collect", cycle, clock=lambda: clock[0], sleep=sleep)
        self.assertEqual(counts, {"completed": 1})
        cycle.assert_called_once_with([self.paper])
        self.assertEqual(service.candidates.call_count, 3)

    def test_explicit_paper_cycle_exits_after_one_lookup(self):
        service = Mock()
        service.candidates.return_value = []
        sleep = Mock()
        worker.run_local_cycles(service, 65, "summarize", Mock(), "123", clock=lambda: 0, sleep=sleep)
        sleep.assert_not_called()
        service.candidates.assert_called_once_with("123", include_summary=True)

    def test_sync_deadline_bounds_original_and_catalog_rpc_retry_paths(self):
        service = object.__new__(worker.Service)
        service.config = {"url": "https://example.invalid", "public_key": "synthetic"}
        service.sync_deadline = 1010
        service.summary_deadline = None
        service.opener = Mock()
        service.opener.open.side_effect = worker.URLError("Synthetic outage")
        for path in ("rpc/register_institution_original", "rpc/sync_institution_catalog", "rpc/report_institution_catalog"):
            with self.subTest(path=path), patch.object(worker.time, "monotonic", return_value=1008), \
                    patch.object(worker.time, "sleep") as sleep:
                with self.assertRaises(TimeoutError):
                    service.request(path, {})
                self.assertEqual(service.opener.open.call_args.kwargs["timeout"], 2)
                sleep.assert_not_called()

    def test_malformed_ack_is_distinct_from_definitive_server_rejection(self):
        from unittest.mock import MagicMock
        service = object.__new__(worker.Service)
        service.config = {"url": "https://example.invalid", "public_key": "synthetic"}
        service.opener = MagicMock()
        service.opener.open.return_value.__enter__.return_value.read.return_value = b"malformed json"
        with self.assertRaises(json.JSONDecodeError):
            service.request("rpc/sync_institution_catalog", {})
        service.opener.open.side_effect = worker.HTTPError("https://example.invalid", 400, "Validation", {}, None)
        with self.assertRaisesRegex(RuntimeError, "^Service HTTP 400$"):
            service.request("rpc/sync_institution_catalog", {})

    def test_reopen_keeps_local_completion_separate_from_cloud_sync_and_identity_change(self):
        from local_catalog import LocalCatalog
        catalog = LocalCatalog(self.directory)
        catalog.upsert_papers([self.paper])
        service = LocalService(self.directory, self.cloud, catalog=catalog)
        self.save_original()
        try:
            service.rpc("publish_institution_summary", **summary_payload(self.paper, self.document, self.summary))
            self.assertFalse(catalog.citation_is_synced("123"))
            self.assertEqual({event["kind"] for event in catalog.outbox_batch()}, {"original", "summary"})
            self.assertEqual(service.candidates(include_summary=True), [])
        finally:
            service.close()
        catalog = LocalCatalog(self.directory)
        service = LocalService(self.directory, self.cloud, catalog=catalog)
        try:
            self.assertEqual(service.candidates(include_summary=True), [])
            self.assertEqual(len(catalog.outbox_batch()), 2)
            for event in catalog.outbox_batch():
                catalog.ack_outbox(event["pmid"], event["kind"], event["version"])
            self.assertEqual(catalog.outbox_batch(), [])
            catalog.upsert_papers([{**self.paper, "title": self.paper["title"] + " revised"}])
            self.assertEqual(len(service.candidates()), 1)
            self.assertEqual(len(service.candidates(include_summary=True)), 1)
        finally:
            service.close()
        self.cloud.rpc.assert_not_called()


if __name__ == "__main__":
    unittest.main()
