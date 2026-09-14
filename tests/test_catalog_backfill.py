import copy
import sys
from pathlib import Path
import time
import unittest
from unittest.mock import patch
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
        for row in rows:target.setdefault(row[conflict],copy.deepcopy(row))
        return len(rows)
    def update(self,key,values):
        if self.fail_checkpoint and values.get("processed"):
            self.fail_checkpoint=False
            raise RuntimeError("Interrupted after insert")
        self.jobs[key].update(copy.deepcopy(values))


class AllTimeTests(unittest.TestCase):
    def test_queries_allow_pubmed_journal_mapping_and_previous_titles(self):
        queries=fetch.build_journal_queries()
        self.assertEqual(len(queries),30)
        self.assertIn("Journal of Urology[Journal]",queries)
        self.assertTrue(any("British Journal of Urology[Journal]" in q for q in queries))
        self.assertFalse(any('"' in q for q in queries))

    def test_partition_covers_all_identifiers_without_date_limits(self):
        root=backfill.job_for("A journal[Journal]")
        high,low=backfill.split_job(root,["10","1000"])
        self.assertEqual(low["lower_uid"],1)
        self.assertEqual(high["lower_uid"],low["upper_uid"]+1)
        self.assertIsNone(high["upper_uid"])
        self.assertIn("NOT 1:",backfill.search_term(high))
        self.assertNotIn("date",backfill.search_term(root))
        self.assertNotIn("[dp]",backfill.search_term(root))

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
            return [{"pmid":p,"title":"Historical article "+p,"abstract":"","pub_date":"1901-01-01"} for p in items]
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

    def test_missing_metadata_is_retried_without_marking_page_complete(self):
        job={**backfill.job_for("A journal[Journal]"),"processed":0}
        store=MemoryStore(job)
        with self.assertRaises(ValueError):
            backfill.process_job(store,job,time.monotonic()+10,
                lambda _:{"count":"2","idlist":["1","2"]},
                lambda _:[{"pmid":"1","title":"Available article"}])
        self.assertEqual(store.jobs[job["job_key"]]["processed"],0)
        self.assertEqual(store.jobs[job["job_key"]]["unavailable_pmids"],["2"])
        self.assertIn("1",store.papers)


if __name__=="__main__":unittest.main()
