import copy
from datetime import date
import json
from pathlib import Path
import sys
import ssl
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import catalog_backfill as backfill
from journal_registry import journal_entries
from local_catalog import CITATION_FIELDS, LocalCatalog
import local_catalog_worker as local_worker
from local_catalog_worker import LocalStore, phase_lock, seed_recent_jobs


def paper(pmid="1", title="A clinical study"):
    return {"pmid": pmid, "title": title, "pub_date": "2025-01-01", "doi": "10.1/" + pmid,
            "abstract": "Published abstract", "journal": "A journal"}


def original(pmid="1", source="a" * 64, title="A clinical study"):
    return {"p_pmid": pmid, "p_doi": "10.1/" + pmid, "p_title": title,
            "p_source": {"content_hash": "b" * 64, "summary_source_hash": source,
                         "characters": 3000, "section_count": 3, "source_url": "https://example.org/article"}}


def summary(pmid="1", source="a" * 64, title="A clinical study"):
    item = original(pmid, source, title)
    del item["p_source"]["summary_source_hash"]
    item["p_summary"] = {"summary_ko": "One\nTwo\nThree", "structured_data": {"study_design": "Cohort"},
                         "clinical_relevance": "Derived interpretation", "qa_data": [],
                         "summary_model": "test.evidence-v1", "summary_source_hash": source}
    return item


class LocalCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.catalog = LocalCatalog(self.directory, reserve_bytes=0)

    def tearDown(self):
        self.catalog.close()
        self.temp.cleanup()

    def test_citations_survive_restart_and_stale_cloud_ack_cannot_drop_new_revision(self):
        self.catalog.upsert_papers([paper()])
        sent = self.catalog.pending_citations()[0]
        self.catalog.upsert_papers([paper(title="Corrected title")])
        self.assertFalse(self.catalog.ack_citation("1", sent["version"], 101))
        self.catalog.upsert_papers([{**paper(), "id": 101, "fulltext_available": True}], synced=True)
        self.assertEqual(self.catalog.candidates()[0]["title"], "Corrected title")
        self.assertFalse(self.catalog.citation_is_synced("1"))
        self.catalog.close()
        self.catalog = LocalCatalog(self.directory, reserve_bytes=0)
        pending = self.catalog.pending_citations()[0]
        self.assertEqual(pending["paper"]["title"], "Corrected title")
        self.assertTrue(self.catalog.ack_citation("1", pending["version"], 101))
        self.assertEqual(self.catalog.stats()["citation_pending"], 0)

    def test_atomic_page_rollback_dedup_and_date_cutoff(self):
        with self.assertRaises(ValueError):
            self.catalog.upsert_papers([paper(), {**paper("2"), "document": "must never be accepted"}])
        self.assertEqual(self.catalog.stats()["local_papers"], 0)
        self.catalog.upsert_papers([paper(), paper(), {**paper("2"), "pub_date": "1999-12-31"}])
        self.assertEqual(self.catalog.stats()["local_papers"], 1)
        self.assertEqual(self.catalog.pending_citations()[0]["version"], 1)

    def test_recheck_timestamp_alone_does_not_create_new_citation_revision(self):
        citation = {**paper(), "integrity_status": "current", "integrity_checked_at": "2026-09-16T00:00:00Z"}
        self.catalog.upsert_papers([citation], synced=True)
        self.catalog.upsert_papers([{**citation, "integrity_checked_at": "2026-09-17T00:00:00Z"}])
        self.assertEqual(self.catalog.pending_citations(), [])
        self.assertEqual(self.catalog.candidates()[0]["integrity_checked_at"], citation["integrity_checked_at"])
        changed = {**citation, "integrity_status": "corrected", "integrity_checked_at": "2026-09-17T00:00:00Z"}
        self.catalog.upsert_papers([changed])
        self.assertEqual(self.catalog.pending_citations()[0]["paper"], changed)

    def test_disk_reserve_blocks_new_data_but_allows_acknowledgements(self):
        self.catalog.upsert_papers([paper()])
        item = self.catalog.pending_citations()[0]
        version = self.catalog.enqueue("original", original())
        self.catalog.reserve_bytes = 100
        with patch("local_catalog.shutil.disk_usage") as usage:
            usage.return_value.free = 10
            with self.assertRaises(backfill.StorageCapacityReached):
                self.catalog.upsert_papers([paper("2")], synced=True)
            with self.assertRaises(backfill.StorageCapacityReached):
                self.catalog.enqueue("summary", summary())
            self.assertTrue(self.catalog.ack_citation("1", item["version"], 100))
            self.assertTrue(self.catalog.ack_outbox("1", "original", version))

    def test_cloud_seed_is_separate_from_local_acquisition_and_omits_null_metadata(self):
        self.catalog.upsert_papers([{**paper(), "keywords": None, "id": 11,
                                    "fulltext_available": True, "summary_model": "remote"}], synced=True)
        self.assertEqual(self.catalog.stats()["synced_papers"], 1)
        self.assertEqual(self.catalog.stats()["local_originals"], 0)
        self.catalog.upsert_papers([paper(title="Updated")])
        pending = self.catalog.pending_citations()[0]["paper"]
        self.assertNotIn("keywords", pending)
        self.assertNotIn("id", pending)
        self.assertLessEqual(set(pending), set(CITATION_FIELDS))
        self.assertFalse(self.catalog.worker_candidates()[0]["fulltext_available"])

    def test_outbox_commit_updates_local_ready_and_cas_versions_never_reset(self):
        self.catalog.upsert_papers([paper()])
        old = self.catalog.enqueue("original", original())
        self.assertTrue(self.catalog.ack_outbox("1", "original", old))
        new = self.catalog.enqueue("original", original())
        self.assertGreater(new, old)
        self.assertFalse(self.catalog.ack_outbox("1", "original", old))
        version = self.catalog.enqueue("summary", summary())
        self.assertIs(self.catalog.worker_candidates()[0]["fulltext_available"], True)
        self.assertEqual(self.catalog.stats()["local_summaries"], 1)
        self.assertEqual(self.catalog.stats()["pending_summaries"], 1)
        self.catalog.close()
        self.catalog = LocalCatalog(self.directory, reserve_bytes=0)
        self.assertTrue(self.catalog.has_pending_event("1", "summary"))
        self.assertFalse(self.catalog.invalidate_summary("1", version - 1))
        self.assertTrue(self.catalog.invalidate_summary("1", version))
        self.assertEqual(self.catalog.stats()["local_summaries"], 0)
        self.assertEqual(self.catalog.stats()["pending_summaries"], 1)

    def test_raw_body_or_invalid_source_cannot_partially_enqueue(self):
        self.catalog.upsert_papers([paper()])
        self.catalog.enqueue("original", original())
        raw = summary()
        raw["p_summary"]["structured_data"]["content_text"] = "private original"
        with self.assertRaises(ValueError):
            self.catalog.enqueue("summary", raw)
        with self.assertRaises(ValueError):
            self.catalog.enqueue("summary", summary(source="c" * 64))
        self.assertFalse(self.catalog.has_pending_event("1", "summary"))
        self.assertEqual(self.catalog.stats()["local_summaries"], 0)

    def test_identity_change_clears_ready_and_quarantines_stale_events(self):
        self.catalog.upsert_papers([paper()])
        self.catalog.enqueue("original", original())
        self.catalog.enqueue("summary", summary())
        self.catalog.upsert_papers([paper(title="New identity")])
        self.assertEqual(self.catalog.stats()["local_originals"], 0)
        self.assertEqual(self.catalog.stats()["local_summaries"], 0)
        self.assertEqual(self.catalog.outbox_batch(), [])
        self.assertTrue(self.catalog.has_pending_event("1", "summary"))
        self.assertFalse(self.catalog.observe_local_source("1", "a" * 64,
                        expected_title="A clinical study", expected_doi="10.1/1"))

    def test_observed_legacy_source_is_counted_without_fake_cloud_receipt(self):
        self.catalog.upsert_papers([{**paper(), "id": 10, "fulltext_available": True}], synced=True)
        self.assertTrue(self.catalog.observe_local_source("1", "a" * 64,
                        expected_title=paper()["title"], expected_doi=paper()["doi"]))
        self.assertTrue(self.catalog.observe_local_summary("1", summary()["p_summary"],
                        expected_title=paper()["title"], expected_doi=paper()["doi"]))
        self.assertEqual(self.catalog.stats()["local_originals"], 1)
        self.assertEqual(self.catalog.stats()["local_summaries"], 1)
        self.assertEqual(self.catalog.outbox_batch(), [])
        self.catalog.enqueue("summary", summary())
        self.catalog.observe_local_source("1", "c" * 64)
        self.assertEqual(self.catalog.outbox_batch(), [])
        self.assertEqual(self.catalog.stats()["local_summaries"], 0)

    def test_outbox_fairness_and_deferred_poison_citation_do_not_block_followers(self):
        self.catalog.upsert_papers([paper(str(n)) for n in range(1, 5)])
        for n in range(1, 5):
            self.catalog.enqueue("original", original(str(n)))
        self.catalog.enqueue("summary", summary("4"))
        self.assertEqual([event["kind"] for event in self.catalog.outbox_batch(2)], ["original", "summary"])
        version = self.catalog.pending_citations()[0]["version"]
        self.assertTrue(self.catalog.defer_citation("1", version, time.time() + 3600, "bad row"))
        self.assertNotIn("1", [row["paper"]["pmid"] for row in self.catalog.pending_citations()])
        self.assertEqual(self.catalog.stats()["citation_pending"], 4)
        self.catalog.upsert_papers([paper(title="Repair")])
        self.assertIn("1", [row["paper"]["pmid"] for row in self.catalog.pending_citations()])
        self.assertFalse(self.catalog.defer_citation("1", version, time.time() + 3600, "stale failure"))

    def test_remote_updates_are_prioritized_before_new_citations_under_cloud_capacity_pause(self):
        self.catalog.upsert_papers([paper("1")])
        self.catalog.upsert_papers([{**paper("2"), "id": 20}], synced=True)
        self.catalog.upsert_papers([paper("2", "Correction")])
        self.assertEqual(self.catalog.pending_citations(1)[0]["paper"]["pmid"], "2")

    def test_wal_commit_before_checkpoint_crash_replays_without_loss_or_duplicates(self):
        store = LocalStore(self.catalog)
        job = {**backfill.job_for("A journal"), "pmids": ["1", "2"], "processed": 0}
        store.insert("catalog_backfill_jobs", [job], "job_key")
        update = store.update
        def crash(key, values):
            if values.get("processed"):
                raise RuntimeError("Process exited after durable citation commit")
            update(key, values)
        store.update = crash
        with self.assertRaises(RuntimeError):
            backfill.process_job(store, job, time.monotonic() + 10, details=lambda ids: [paper(p) for p in ids])
        self.assertEqual(self.catalog.stats()["local_papers"], 2)
        self.catalog.close()
        self.catalog = LocalCatalog(self.directory, reserve_bytes=0)
        store = LocalStore(self.catalog)
        resumed = store.read("catalog_backfill_jobs", {})[0]
        backfill.process_job(store, resumed, time.monotonic() + 10,
            search=lambda _: self.fail("Committed PMID snapshot must be reused"),
            details=lambda ids: [paper(p) for p in ids])
        self.assertEqual(self.catalog.stats()["local_papers"], 2)
        self.assertEqual(store.read("catalog_backfill_jobs", {})[0]["status"], "done")
        self.assertTrue(all(row["version"] == 1 for row in self.catalog.pending_citations()))

    def test_daily_polling_is_independent_of_completed_historical_jobs_and_covers_offline_gap(self):
        store = LocalStore(self.catalog)
        entry = journal_entries()[0]
        historic = backfill.job_for(entry.query, journal_id=entry.id, priority=0)
        store.insert("catalog_backfill_jobs", [{**historic, "status": "done"}], "job_key")
        self.catalog.set_meta("recent_completed_through", "2026-01-01")
        jobs = seed_recent_jobs(store, today=date(2026, 9, 17), entries=[entry])
        self.assertIn("2025/12/25:2026/09/17[EDAT]", jobs[0]["query"])
        self.assertIn("[MDAT]", jobs[0]["query"])
        self.assertEqual(store.next_job(recent=True)["job_key"], jobs[0]["job_key"])
        self.assertIsNone(store.next_job(recent=False))
        store.update(jobs[0]["job_key"], {"status": "done"})
        next_day = seed_recent_jobs(store, today=date(2026, 9, 18), entries=[entry])
        self.assertNotEqual(jobs[0]["job_key"], next_day[0]["job_key"])

    def test_disk_guard_preserves_checkpoint_and_process_lock_excludes_duplicate(self):
        store = LocalStore(self.catalog)
        job = backfill.job_for("A journal")
        store.insert("catalog_backfill_jobs", [job], "job_key")
        self.catalog.reserve_bytes = 100
        with patch("local_catalog.shutil.disk_usage") as usage:
            usage.return_value.free = 10
            with self.assertRaises(backfill.StorageCapacityReached):
                store.ensure_capacity()
        self.assertEqual(len(store.read("catalog_backfill_jobs", {})), 1)
        with phase_lock(self.directory, "catalog") as first:
            self.assertTrue(first)
            with phase_lock(self.directory, "catalog") as second:
                self.assertFalse(second)
        with phase_lock(self.directory, "catalog") as released:
            self.assertTrue(released)


class LocalPubMedTransportTests(unittest.TestCase):
    @staticmethod
    def response(body):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = body
        return response

    def test_count_snapshot_uses_system_verified_context_exact_query_and_bounded_read(self):
        response = self.response(b'{"esearchresult":{"count":"1","idlist":["123"]}}')
        job = backfill.job_for(journal_entries()[0].query)
        with patch.object(local_worker, "urlopen", return_value=response) as request, \
                patch.object(local_worker.time, "sleep") as sleep, \
                patch.object(local_worker.time, "monotonic", return_value=100):
            result = local_worker.pubmed_search(job, 160)
        self.assertEqual(backfill.validate_ids(result), (1, ["123"]))
        context = request.call_args.kwargs["context"]
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertEqual(request.call_args.kwargs["timeout"], 45)
        parsed = urlsplit(request.call_args.args[0].full_url)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.hostname, "eutils.ncbi.nlm.nih.gov")
        self.assertEqual(parse_qs(parsed.query)["term"], [backfill.search_term(job)])
        response.read.assert_called_once_with(16 * 1024**2 + 1)
        sleep.assert_called_once_with(.4)

    def test_details_reuse_article_parser_and_larger_metadata_read_limit(self):
        xml = b'''<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID>
          <Article><ArticleTitle>A clinical study</ArticleTitle><Journal><JournalIssue>
          <PubDate><Year>2025</Year><Month>01</Month><Day>01</Day></PubDate></JournalIssue>
          <Title>A journal</Title></Journal></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>'''
        response = self.response(xml)
        with patch.object(local_worker, "urlopen", return_value=response), \
                patch.object(local_worker.time, "sleep"), \
                patch.object(local_worker.time, "monotonic", return_value=100):
            rows = local_worker.pubmed_details(["123"], 130)
        self.assertEqual(rows[0]["pmid"], "123")
        self.assertEqual(rows[0]["pub_date"], "2025-01-01")
        self.assertEqual(set(rows[0]), set(CITATION_FIELDS))
        response.read.assert_called_once_with(32 * 1024**2 + 1)

    def test_transient_retry_respects_remaining_budget_and_permanent_failure_is_not_retried(self):
        for code, expected in ((429, local_worker.CatalogDeadlineExpired), (403, HTTPError)):
            error = HTTPError("https://eutils.ncbi.nlm.nih.gov/", code, "fixture", {}, None)
            with self.subTest(code=code), patch.object(local_worker, "urlopen", side_effect=error) as request, \
                    patch.object(local_worker.time, "sleep"), \
                    patch.object(local_worker.time, "monotonic", return_value=100):
                with self.assertRaises(expected):
                    local_worker.pubmed_search(backfill.job_for("A journal"), 102)
                self.assertEqual(request.call_count, 1)

    def test_transient_request_recovers_without_changing_tls_or_bypassing_size_limit(self):
        response = self.response(b'{"esearchresult":{"count":"0","idlist":[]}}')
        error = HTTPError("https://eutils.ncbi.nlm.nih.gov/", 503, "fixture", {}, None)
        with patch.object(local_worker, "urlopen", side_effect=[error, response]) as request, \
                patch.object(local_worker.time, "sleep") as sleep, \
                patch.object(local_worker.time, "monotonic", return_value=100):
            result = local_worker.pubmed_search(backfill.job_for("A journal"), 160)
        self.assertEqual(result["count"], "0")
        self.assertEqual(request.call_count, 2)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [.4, 2, .4])
        with patch.object(local_worker, "urlopen", return_value=self.response(b"x" * 17)), \
                patch.object(local_worker.time, "sleep"), \
                patch.object(local_worker.time, "monotonic", return_value=100):
            with self.assertRaisesRegex(ValueError, "size limit"):
                local_worker._pubmed_request("esearch.fcgi", {}, 160, 16, json.loads)

    def test_expired_deadline_and_unverified_context_make_no_network_request(self):
        with patch.object(local_worker, "urlopen") as request, \
                patch.object(local_worker.time, "monotonic", return_value=100):
            with self.assertRaises(local_worker.CatalogDeadlineExpired):
                local_worker.pubmed_search(backfill.job_for("A journal"), 100)
            request.assert_not_called()
        insecure = MagicMock(verify_mode=ssl.CERT_NONE, check_hostname=False)
        with patch.object(local_worker.ssl, "create_default_context", return_value=insecure), \
                patch.object(local_worker, "urlopen") as request:
            with self.assertRaisesRegex(ValueError, "verified HTTPS"):
                local_worker.pubmed_search(backfill.job_for("A journal"), 160)
            request.assert_not_called()

    def test_cooperative_network_deadline_does_not_mark_checkpoint_failed(self):
        store = MagicMock()
        store.next_job.return_value = backfill.job_for("A journal")
        with patch.object(backfill, "process_job", side_effect=local_worker.CatalogDeadlineExpired) as process, \
                patch.object(local_worker.time, "monotonic", return_value=100):
            local_worker._process_until(store, 160, recent=False)
        store.update.assert_not_called()
        self.assertTrue(callable(process.call_args.kwargs["search"]))
        self.assertTrue(callable(process.call_args.kwargs["details"]))


if __name__ == "__main__":
    unittest.main()
