import copy
import sys
from pathlib import Path
import time
import unittest
from unittest.mock import Mock, MagicMock, patch
from xml.etree import ElementTree as ET

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import catalog_backfill as backfill
import fetch_papers as fetch


class MemoryStore:
    def __init__(self,job):
        self.jobs={job["job_key"]:copy.deepcopy(job)}
        self.papers={}
        self.fail_checkpoint=False
    def insert(self,table,rows,conflict):
        target=self.papers if table=="papers" else self.jobs
        for row in rows:
            if table=="papers":target.setdefault(row[conflict],{}).update(copy.deepcopy(row))
            else:target.setdefault(row[conflict],copy.deepcopy(row))
        return len(rows)
    def update(self,key,values):
        if self.fail_checkpoint and values.get("processed"):
            self.fail_checkpoint=False
            raise RuntimeError("Interrupted after insert")
        self.jobs[key].update(copy.deepcopy(values))
    def ensure_capacity(self):pass


class AllTimeTests(unittest.TestCase):
    def test_existing_catalog_snapshot_is_paginated_once_and_is_resumable(self):
        store=Mock()
        store.read.side_effect=[[],[{"pmid":str(i)} for i in range(1,1001)],[{"pmid":"1001"}]]
        backfill.seed_existing_catalog(store)
        job=store.insert.call_args.args[1][0]
        self.assertEqual(len(job["pmids"]),1001)
        self.assertEqual(job["status"],"active")
        self.assertEqual(store.read.call_args.args[1]["offset"],1000)
        store.reset_mock()
        store.read.side_effect=None
        store.read.return_value=[{"job_key":job["job_key"]}]
        backfill.seed_existing_catalog(store)
        store.insert.assert_not_called()

    def test_citation_refresh_preserves_summary_and_resumes_known_identifiers(self):
        job={**backfill.job_for("Existing catalog citation audit v1"),"pmids":["1"],"processed":0}
        store=MemoryStore(job)
        store.papers["1"]={"pmid":"1","title":"Old title","summary_ko":"Verified body summary","summarized_at":"existing"}
        backfill.process_job(store,job,time.monotonic()+10,lambda _:self.fail("Known PMID needs no search"),
            lambda _:[{"pmid":"1","title":"Corrected title","abstract":"New abstract","pub_date":"2000-01-01"}])
        self.assertEqual(store.papers["1"]["title"],"Corrected title")
        self.assertEqual(store.papers["1"]["summary_ko"],"Verified body summary")

    def test_real_store_upserts_citations_but_never_overwrites_checkpoints(self):
        with patch.dict(backfill.os.environ,{"SUPABASE_URL":"https://example.invalid","SUPABASE_SERVICE_KEY":"test"}), \
             patch.object(backfill.requests,"post") as post:
            post.return_value.__enter__.return_value.json.return_value=[{"pmid":"1"}]
            store=backfill.Store()
            store.read=Mock(return_value=[])
            store.insert("papers",[{"pmid":"1","title":"Corrected"}],"pmid")
            self.assertIn("merge-duplicates",post.call_args.kwargs["headers"]["Prefer"])
            self.assertNotIn("summary_ko",post.call_args.kwargs["json"][0])
            store.insert("catalog_backfill_jobs",[backfill.job_for("test")],"job_key")
            self.assertIn("ignore-duplicates",post.call_args.kwargs["headers"]["Prefer"])

    def test_unchanged_citations_do_not_generate_writes_or_table_bloat(self):
        store=object.__new__(backfill.Store)
        citation={"pmid":"1","title":"Already current"}
        store.read=Mock(return_value=[citation])
        with patch.object(backfill.requests,"post") as post:
            self.assertEqual(store.insert("papers",[citation],"pmid"),0)
            post.assert_not_called()

    def test_storage_pause_preserves_last_page_and_resumes_without_loss(self):
        job={**backfill.job_for("Known citations"),"pmids":[str(i) for i in range(1100)],"processed":0}
        store=MemoryStore(job)
        store.ensure_capacity=Mock(side_effect=[None,backfill.StorageCapacityReached()])
        details=lambda ids:[{"pmid":pmid,"title":"Article "+pmid,"pub_date":"2000-01-01"} for pmid in ids]
        with self.assertRaises(backfill.StorageCapacityReached):
            backfill.process_job(store,job,time.monotonic()+10,details=details)
        self.assertEqual(store.jobs[job["job_key"]]["processed"],1000)
        self.assertEqual(len(store.papers),1000)
        store.ensure_capacity=Mock()
        backfill.process_job(store,store.jobs[job["job_key"]],time.monotonic()+10,details=details)
        self.assertEqual(len(store.papers),1100)
        self.assertEqual(store.jobs[job["job_key"]]["status"],"done")

    def test_queries_allow_pubmed_journal_mapping_and_previous_titles(self):
        queries=fetch.build_journal_queries()
        self.assertEqual(len(queries),30)
        self.assertIn("Journal of Urology[Journal]",queries)
        self.assertTrue(any("British Journal of Urology[Journal]" in q for q in queries))
        self.assertFalse(any('"' in q for q in queries))

    def test_partition_covers_identifiers_with_a_shared_publication_cutoff(self):
        root=backfill.job_for("A journal[Journal]")
        high,low=backfill.split_job(root,["10","1000"])
        self.assertEqual(low["lower_uid"],1)
        self.assertEqual(high["lower_uid"],low["upper_uid"]+1)
        self.assertIsNone(high["upper_uid"])
        self.assertIn("NOT 1:",backfill.search_term(high))
        self.assertNotIn("date",backfill.search_term(root))
        self.assertIn("2000:3000[dp]",backfill.search_term(root))
        self.assertIn("2000:3000[dp]",backfill.search_term(high))
        self.assertEqual(root["start_date"],"2000-01-01")

    def test_truncated_and_unrecognized_queries_are_rejected(self):
        for result in [{"count":"3","idlist":["1","2"]},
                       {"count":"2","idlist":["1","1"]},
                       {"count":"0","idlist":[],"warninglist":{"phrasesnotfound":["wrong journal"]}}]:
            with self.assertRaises(ValueError):backfill.validate_ids(result)

    def test_resume_after_committed_insert_preserves_old_and_abstractless_records(self):
        job={**backfill.job_for("A journal[Journal]"),"processed":0}
        store=MemoryStore(job)
        ids=[str(n) for n in range(1,104)]
        def details(items):
            return [{"pmid":p,"title":"Historical article "+p,"abstract":"","pub_date":"2000-01-01"} for p in items]
        search=lambda _: {"count":str(len(ids)),"idlist":ids}
        store.fail_checkpoint=True
        with self.assertRaises(RuntimeError):backfill.process_job(store,job,time.monotonic()+10,search,details)
        resumed=store.jobs[job["job_key"]]
        backfill.process_job(store,resumed,time.monotonic()+10,lambda _:self.fail("snapshot should be reused"),details)
        self.assertEqual(len(store.papers),103)
        self.assertEqual(store.jobs[job["job_key"]]["status"],"done")
        self.assertTrue(all(p["abstract"]=="" for p in store.papers.values()))

    def test_medline_dates_and_invalid_dates_do_not_lose_historical_year(self):
        article=ET.fromstring('<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>Old paper</ArticleTitle>'
          '<Journal><JournalIssue><PubDate><MedlineDate>1937 Nov-Dec</MedlineDate></PubDate></JournalIssue></Journal></Article></MedlineCitation></PubmedArticle>')
        self.assertEqual(fetch.parse_article(article)["pub_date"],"1937-11-01")

    def test_out_of_scope_results_are_examined_without_insert_or_deleting_archives(self):
        job={**backfill.job_for("A journal[Journal]"),"pmids":["1","2","3"],"processed":0}
        store=MemoryStore(job)
        old={"pmid":"1","title":"Preserved original","pub_date":"1999-12-31","summary_ko":"Existing"}
        store.papers["1"]=copy.deepcopy(old)
        details=lambda _:[{"pmid":"1","title":"Outside range","pub_date":"1999-12-31"},
            {"pmid":"2","title":"Boundary article","pub_date":"2000-01-01"},
            {"pmid":"3","title":"Date unknown","pub_date":None}]
        backfill.process_job(store,job,time.monotonic()+10,details=details)
        self.assertEqual(store.papers["1"],old)
        self.assertEqual(set(store.papers),{"1","2"})
        self.assertEqual(store.jobs[job["job_key"]]["processed"],3)
        self.assertEqual(store.jobs[job["job_key"]]["status"],"done")

    def test_missing_metadata_is_retried_without_marking_page_complete(self):
        job={**backfill.job_for("A journal[Journal]"),"processed":0}
        store=MemoryStore(job)
        with self.assertRaises(ValueError):
            backfill.process_job(store,job,time.monotonic()+10,
                lambda _:{"count":"2","idlist":["1","2"]},
                lambda _:[{"pmid":"1","title":"Available article","pub_date":"2000-01-01"}])
        self.assertEqual(store.jobs[job["job_key"]]["processed"],0)
        self.assertEqual(store.jobs[job["job_key"]]["unavailable_pmids"],["2"])
        self.assertIn("1",store.papers)


if __name__=="__main__":unittest.main()
