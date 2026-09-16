import copy
import sys
from pathlib import Path
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, MagicMock, patch
from xml.etree import ElementTree as ET

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import catalog_backfill as backfill
import fetch_papers as fetch


class MemoryStore:
    def __init__(self,job=None):
        self.jobs={job["job_key"]:copy.deepcopy(job)} if job else {}
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
    def read(self,table,params):
        if table!="catalog_backfill_jobs":raise AssertionError("Unexpected table")
        rows=list(self.jobs.values())
        key=params.get("job_key","")
        if key.startswith("eq."):rows=[row for row in rows if row["job_key"]==key[3:]]
        elif key.startswith("in.("):
            keys=set(key[4:-1].split(","))
            rows=[row for row in rows if row["job_key"] in keys]
        return copy.deepcopy(rows[:params.get("limit",len(rows))])
    def adopt_query(self,query,metadata):
        for job in self.jobs.values():
            if job["query"]==query and job.get("start_date")==backfill.AUTOMATIC_START_DATE:
                job.update(copy.deepcopy(metadata))


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

    def test_configured_queries_use_the_approved_registry_without_resetting_legacy_identity(self):
        queries=fetch.build_journal_queries()
        entries=backfill.journal_entries()
        self.assertEqual(len(queries),65)
        self.assertEqual(queries,[entry.query for entry in entries])
        self.assertEqual(sum(entry.legacy_query is None for entry in entries),35)
        legacy='Journal of Urology[Journal]'
        self.assertTrue(any(entry.legacy_query==legacy for entry in entries))
        self.assertEqual(backfill.job_for(legacy)["job_key"],backfill.job_for(legacy,journal_id="journal-of-urology")["job_key"])

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
                       {"count":"0","idlist":[],"warninglist":{"phrasesnotfound":["wrong journal"]}},
                       {"count":"0","idlist":[],"warninglist":{"quotedphrasesnotfound":['"missing-issn"[Journal]']}},
                       {"count":"0","idlist":[],"warninglist":{"phrasesignored":["bad term"]}},
                       {"count":"10000","idlist":[]},
                       {"count":"-1","idlist":[]},
                       {"count":"1","idlist":["0"]}]:
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


class RegistryCheckpointTests(unittest.TestCase):
    def entry(self,query,legacy=None,identity="example-journal"):
        return SimpleNamespace(id=identity,query=query,legacy_query=legacy)

    def test_changed_query_gets_pending_work_without_copying_completed_legacy_progress(self):
        legacy={**backfill.job_for('Old journal[Journal]'),"status":"done","processed":2,
                "pmids":["1","2"],"source_count":2,"updated_at":"old timestamp"}
        store=MemoryStore(legacy)
        entry=self.entry('"1234-5678"[Journal]',legacy["query"])
        backfill.seed_registry_jobs(store,[entry])
        self.assertEqual(store.jobs[legacy["job_key"]],legacy)
        current=store.jobs[backfill.job_for(entry.query)["job_key"]]
        self.assertEqual(current.get("status","pending"),"pending")
        self.assertNotIn("processed",current)
        self.assertNotIn("pmids",current)
        self.assertEqual(current["priority"],10)
        self.assertEqual(current["registry_version"],backfill.REGISTRY_VERSION)
        before=copy.deepcopy(store.jobs)
        backfill.seed_registry_jobs(store,[entry])
        self.assertEqual(store.jobs,before)

    def test_identical_query_adopts_all_shards_without_touching_progress_retries_or_timestamps(self):
        query='"1234-5678"[Journal]'
        root={**backfill.job_for(query),"status":"split","source_count":12000,"updated_at":"root time"}
        shard={**backfill.job_for(query,2,100),"status":"error","pmids":["2","3"],"processed":1,
               "unavailable_pmids":["3"],"error_code":"ValueError","retry_after":"later","updated_at":"shard time"}
        old_scope={**backfill.job_for(query,1,1),"start_date":None,"status":"done","processed":1}
        store=MemoryStore(root)
        store.jobs[shard["job_key"]]=copy.deepcopy(shard)
        store.jobs[old_scope["job_key"]]=copy.deepcopy(old_scope)
        backfill.seed_registry_jobs(store,[self.entry(query,query)])
        metadata=backfill.registry_metadata(backfill.job_for(query,journal_id="example-journal",priority=10))
        self.assertEqual(store.jobs[root["job_key"]],{**root,**metadata})
        self.assertEqual(store.jobs[shard["job_key"]],{**shard,**metadata})
        self.assertEqual(store.jobs[old_scope["job_key"]],old_scope)

    def test_approved_registry_initializes_every_journal_and_prioritizes_the_new_35(self):
        store=MemoryStore()
        backfill.seed_registry_jobs(store)
        self.assertEqual(len(store.jobs),65)
        self.assertEqual(sum(job["priority"]==0 for job in store.jobs.values()),35)
        self.assertEqual(sum(job["priority"]==10 for job in store.jobs.values()),30)
        self.assertTrue(all(job["start_date"]=="2000-01-01" for job in store.jobs.values()))
        self.assertTrue(all(job.get("status","pending")=="pending" for job in store.jobs.values()))
        self.assertTrue(all(len(job["query_version"])==64 for job in store.jobs.values()))

    def test_duplicate_registry_queries_fail_before_any_store_mutation(self):
        store=Mock()
        with self.assertRaises(ValueError):
            backfill.seed_registry_jobs(store,[self.entry("same"),self.entry("same",identity="other")])
        store.insert.assert_not_called()
        store.adopt_query.assert_not_called()

    def test_uid_children_retain_registry_query_version_and_priority(self):
        job=backfill.job_for('"1234-5678"[Journal]',journal_id="new-journal",priority=0)
        high,low=backfill.split_job(job,["10","10000"])
        for child in (high,low):
            self.assertEqual(backfill.registry_metadata(child),backfill.registry_metadata(job))
        self.assertEqual(low["upper_uid"]+1,high["lower_uid"])

    def test_scheduler_reads_only_current_registry_in_new_journal_priority_order(self):
        store=object.__new__(backfill.Store)
        store.read=Mock(return_value=[])
        self.assertIsNone(store.next_job())
        params=store.read.call_args.args[1]
        self.assertEqual(params["registry_version"],"eq."+backfill.REGISTRY_VERSION)
        self.assertEqual(params["start_date"],"eq.2000-01-01")
        self.assertTrue(params["order"].startswith("priority.asc,"))
        self.assertEqual(params["limit"],1)
        self.assertIn("retry_after",params["or"])

    def test_query_adoption_request_is_atomic_and_metadata_only(self):
        store=object.__new__(backfill.Store)
        store.url="https://example.invalid"
        store.headers={}
        job=backfill.job_for('"1234-5678"[Journal]',journal_id="example-journal",priority=0)
        metadata=backfill.registry_metadata(job)
        with patch.object(backfill,"patch_fields") as patch_fields:
            store.adopt_query(job["query"],metadata)
            self.assertEqual(patch_fields.call_args.kwargs["data"],metadata)
            self.assertEqual(patch_fields.call_args.kwargs["params"],{
                "query":"eq."+job["query"],"start_date":"eq.2000-01-01"})
            with self.assertRaises(ValueError):store.adopt_query(job["query"],{**metadata,"status":"done"})
            self.assertEqual(patch_fields.call_count,1)

    def test_unrecognized_issn_never_marks_an_empty_query_complete(self):
        job=backfill.job_for('"1234-5678"[Journal]',journal_id="example-journal")
        store=MemoryStore(job)
        with self.assertRaises(ValueError):
            backfill.process_job(store,job,time.monotonic()+10,
                lambda _:{"count":"0","idlist":[],"warninglist":{"quotedphrasesnotfound":[job["query"]]}},
                lambda _:self.fail("Invalid search must not fetch metadata"))
        self.assertEqual(store.jobs[job["job_key"]],job)

    def test_pubmed_search_is_rate_limited_and_respects_identifier_snapshot_limit(self):
        with patch.object(backfill.time,"sleep") as sleep,patch.object(backfill,"get_json",return_value={"esearchresult":{}}) as get:
            backfill.pubmed_search(backfill.job_for('"1234-5678"[Journal]'))
        sleep.assert_called_once_with(.4)
        self.assertEqual(get.call_args.kwargs["params"]["retmax"],9999)
        self.assertIn("2000:3000[dp]",get.call_args.kwargs["params"]["term"])

    def test_expired_budget_makes_no_pubmed_calls_or_checkpoint_changes(self):
        job=backfill.job_for('"1234-5678"[Journal]')
        store=MemoryStore(job)
        search=Mock()
        details=Mock()
        backfill.process_job(store,job,time.monotonic()-1,search,details)
        search.assert_not_called()
        details.assert_not_called()
        self.assertEqual(store.jobs[job["job_key"]],job)

    def test_seed_only_initializes_registry_without_catalog_scan_or_ncbi_requests(self):
        store=Mock()
        with patch.object(sys,"argv",["catalog_backfill.py","--seed-only"]), \
             patch.object(backfill,"Store",return_value=store), \
             patch.object(backfill,"seed_registry_jobs") as seed, \
             patch.object(backfill,"seed_existing_catalog") as audit, \
             patch.object(backfill,"process_job") as process, \
             patch.object(backfill,"report_status") as report:
            backfill.main()
        seed.assert_called_once_with(store)
        report.assert_called_once_with(store)
        store.ensure_capacity.assert_not_called()
        audit.assert_not_called()
        process.assert_not_called()

    def test_capacity_pause_still_initializes_scope_without_large_catalog_audit(self):
        store=Mock()
        store.ensure_capacity.side_effect=backfill.StorageCapacityReached()
        events=[]
        with patch.object(sys,"argv",["catalog_backfill.py"]), \
             patch.object(backfill,"Store",return_value=store), \
             patch.object(backfill,"seed_registry_jobs",side_effect=lambda _:events.append("seed")), \
             patch.object(backfill,"seed_existing_catalog") as audit, \
             patch.object(backfill,"report_status") as report:
            backfill.main()
        self.assertEqual(events,["seed"])
        audit.assert_not_called()
        report.assert_called_once_with(store)


if __name__=="__main__":unittest.main()
