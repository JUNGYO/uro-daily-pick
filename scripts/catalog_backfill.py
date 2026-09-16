"""Resumable PubMed inventory from 2000 onward. Only citation metadata goes to Supabase."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import time
from xml.etree import ElementTree as ET

import requests
from common import get_json, patch_fields, supabase_headers
from fetch_papers import PUBMED_BASE, PUBMED_EMAIL, parse_article
from catalog_policy import AUTOMATIC_START_DATE, PUBMED_DATE_RANGE, automatic_paper
from journal_registry import REGISTRY_VERSION, journal_entries

PAGE_LIMIT = 9999


class StorageCapacityReached(Exception):
    pass


def job_for(query, lower=1, upper=None, *, journal_id=None, priority=20):
    # Keep the original identity so an exactly unchanged query can resume its
    # committed UID snapshot. A different query must receive a new checkpoint.
    identity=json.dumps([query,lower,upper,AUTOMATIC_START_DATE],separators=(",",":"))
    result={"job_key":hashlib.sha256(identity.encode()).hexdigest(),"query":query,
            "lower_uid":lower,"upper_uid":upper,"start_date":AUTOMATIC_START_DATE}
    if journal_id is not None:
        result.update(journal_id=journal_id,registry_version=REGISTRY_VERSION,
                      query_version=hashlib.sha256(query.encode()).hexdigest(),priority=priority)
    return result


def search_term(job):
    query="("+job["query"]+") AND "+PUBMED_DATE_RANGE
    low,high=job["lower_uid"],job.get("upper_uid")
    if high is not None:
        return f"{query} AND {low}:{high}[UID]"
    return query if low==1 else f"{query} NOT 1:{low-1}[UID]"


def split_job(job, ids):
    low,high=job["lower_uid"],job.get("upper_uid")
    # UID partitions cover the complete date-filtered search, including future IDs.
    ceiling=high if high is not None else max(int(pmid) for pmid in ids)
    pivot=(low+ceiling)//2
    if pivot<low or (high is not None and pivot>=high) or ceiling<=low:
        raise ValueError("Cannot partition oversized PubMed result")
    metadata={key:job[key] for key in ("journal_id","query_version","registry_version","priority") if key in job}
    return [{**job_for(job["query"],pivot+1,high),**metadata},
            {**job_for(job["query"],low,pivot),**metadata}]


def validate_ids(result):
    warnings=result.get("warninglist") or {}
    if result.get("errorlist") or any(warnings.get(key) for key in ("phrasesnotfound","quotedphrasesnotfound","phrasesignored")):
        raise ValueError("PubMed did not recognize a configured search term")
    count=int(result["count"])
    ids=result.get("idlist",[])
    if count<0 or any(not str(pmid).isdigit() or int(pmid)<1 for pmid in ids) or len(ids)!=len(set(ids)):
        raise ValueError("Invalid PubMed identifier response")
    if count<=PAGE_LIMIT and count!=len(ids):
        raise ValueError("Incomplete PubMed identifier snapshot")
    if count>PAGE_LIMIT and not ids:
        raise ValueError("Oversized PubMed search returned no partition identifiers")
    return count,ids


class Store:
    def __init__(self):
        self.url=os.environ.get("SUPABASE_URL","").rstrip("/")
        key=os.environ.get("SUPABASE_SERVICE_KEY","")
        if not self.url or not key: raise ValueError("Supabase configuration required")
        self.headers=supabase_headers(key)

    def read(self,table,params):
        return get_json(self.url+"/rest/v1/"+table,headers=self.headers,params=params)

    def insert(self,table,rows,conflict):
        if not rows:return 0
        if table=="papers":
            columns=sorted({key for row in rows for key in row})
            existing=self.read("papers",{"select":",".join(columns),"pmid":"in.("+",".join(row["pmid"] for row in rows)+")"})
            known={row["pmid"]:row for row in existing}
            rows=[row for row in rows if row["pmid"] not in known or any(known[row["pmid"]].get(k)!=v for k,v in row.items())]
            if not rows:return 0
        # Refresh citation fields on existing rows. Model output/provenance and
        # user activity are absent from these payloads and remain untouched.
        resolution="merge-duplicates" if table=="papers" else "ignore-duplicates"
        headers={**self.headers,"Prefer":f"resolution={resolution},return=representation"}
        params={"on_conflict":conflict,"select":conflict}
        for attempt in range(4):
            try:
                with requests.post(self.url+"/rest/v1/"+table,headers=headers,params=params,json=rows,timeout=(10,60)) as response:
                    response.raise_for_status()
                    return len(response.json())
            except requests.HTTPError as error:
                if error.response.status_code not in (408,429,500,502,503,504,520,522,524):raise
            except (requests.ConnectionError,requests.Timeout,ValueError):pass
            if attempt==3:raise RuntimeError("Catalog checkpoint unavailable")
            time.sleep(2**(attempt+1))

    def update(self,key,values):
        patch_fields(self.url+"/rest/v1/catalog_backfill_jobs",headers=self.headers,
                     params={"job_key":"eq."+key},data={**values,"updated_at":datetime.now(timezone.utc).isoformat()})

    def adopt_query(self,query,metadata):
        # One atomic metadata-only update also adopts every existing UID shard.
        # Snapshot IDs, progress, status, retries and original timestamps survive.
        allowed={"journal_id","query_version","registry_version","priority"}
        if set(metadata)!=allowed:
            raise ValueError("Only registry metadata may be adopted")
        patch_fields(self.url+"/rest/v1/catalog_backfill_jobs",headers=self.headers,
                     params={"query":"eq."+query,"start_date":"eq."+AUTOMATIC_START_DATE},data=metadata)

    def next_job(self):
        now=datetime.now(timezone.utc).isoformat()
        rows=self.read("catalog_backfill_jobs",{"select":"*","status":"in.(pending,active,error)",
            "start_date":"eq."+AUTOMATIC_START_DATE,
            "registry_version":"eq."+REGISTRY_VERSION,
            "or":f"(retry_after.is.null,retry_after.lte.{now})",
            "order":"priority.asc,status.asc,lower_uid.desc,updated_at.asc,job_key","limit":1})
        return rows[0] if rows else None

    def ensure_capacity(self):
        status=self.read("rpc/catalog_storage_status",{})
        if status["database_bytes"]>=status["budget_bytes"]:
            raise StorageCapacityReached("Database storage budget reached; checkpoint retained")


def pubmed_search(job):
    time.sleep(.4)
    return get_json(PUBMED_BASE+"/esearch.fcgi",headers={},params={"db":"pubmed","term":search_term(job),
        "retmax":PAGE_LIMIT,"retmode":"json","tool":"uro_daily_pick","email":PUBMED_EMAIL})["esearchresult"]


def registry_metadata(job):
    return {key:job[key] for key in ("journal_id","query_version","registry_version","priority")}


def seed_registry_jobs(store,entries=None):
    """Initialize new scope without resetting any existing checkpoint.

    Query content is the migration boundary: identical queries reuse their
    progress; changed queries start pending, with old records retained as history.
    Newly added journals precede rechecks of previously configured journals.
    """
    entries=journal_entries() if entries is None else entries
    jobs=[job_for(entry.query,journal_id=entry.id,
                  priority=0 if entry.legacy_query is None else 10) for entry in entries]
    if not jobs:return
    if len({job["job_key"] for job in jobs})!=len(jobs):
        raise ValueError("Journal registry contains duplicate queries")
    old=store.read("catalog_backfill_jobs",{
        "select":"job_key,journal_id,query_version,registry_version,priority",
        "job_key":"in.("+",".join(job["job_key"] for job in jobs)+")","limit":len(jobs)})
    by_key={job["job_key"]:job for job in old}
    store.insert("catalog_backfill_jobs",jobs,"job_key")
    for job in jobs:
        existing=by_key.get(job["job_key"])
        metadata=registry_metadata(job)
        if existing is not None and any(existing.get(key)!=value for key,value in metadata.items()):
            store.adopt_query(job["query"],metadata)


def seed_existing_catalog(store):
    """Audit the date-eligible existing catalog; preserve older stored records."""
    job=job_for("Existing catalog citation audit v1",journal_id="existing-catalog-audit",priority=20)
    existing=store.read("catalog_backfill_jobs",{"select":"job_key,journal_id,query_version,registry_version,priority",
                       "job_key":"eq."+job["job_key"],"limit":1})
    if existing:
        metadata=registry_metadata(job)
        if any(existing[0].get(key)!=value for key,value in metadata.items()):
            store.adopt_query(job["query"],metadata)
        return
    ids=[]
    while True:
        page=store.read("papers",{"select":"pmid","pub_date":"gte."+AUTOMATIC_START_DATE,"order":"id","offset":len(ids),"limit":1000})
        ids.extend(row["pmid"] for row in page)
        if len(page)<1000:break
    # These identifiers are already known locally; no ESearch pagination limit
    # applies. The committed snapshot is reused after every interruption.
    store.insert("catalog_backfill_jobs",[{**job,"status":"active","pmids":ids,"source_count":len(ids)}],"job_key")


def pubmed_details(ids):
    time.sleep(.4)
    for attempt in range(4):
        try:
            with requests.get(PUBMED_BASE+"/efetch.fcgi",params={"db":"pubmed","id":",".join(ids),
                "retmode":"xml","tool":"uro_daily_pick","email":PUBMED_EMAIL},timeout=(10,60)) as response:
                response.raise_for_status()
                root=ET.fromstring(response.content)
            if root.find(".//ERROR") is not None:raise ValueError("PubMed detail error")
            return [parse_article(article) for article in root.findall(".//PubmedArticle")]
        except requests.HTTPError as error:
            if error.response.status_code not in (408,429,500,502,503,504):raise
        except (requests.ConnectionError,requests.Timeout,ET.ParseError):pass
        if attempt==3:raise RuntimeError("PubMed detail response unavailable")
        time.sleep(2**(attempt+1))


def process_job(store,job,deadline,search=pubmed_search,details=pubmed_details):
    if time.monotonic()>=deadline:return
    key=job["job_key"]
    ids=job.get("pmids")
    if ids is None:
        count,ids=validate_ids(search(job))
        if count>PAGE_LIMIT:
            store.insert("catalog_backfill_jobs",split_job(job,ids),"job_key")
            store.update(key,{"status":"split","source_count":count,"error_code":None,"retry_after":None})
            return
        store.update(key,{"status":"active","source_count":count,"pmids":ids,"error_code":None,"retry_after":None})
    offset=job.get("processed",0)
    missing=list(job.get("unavailable_pmids") or [])
    while offset<len(ids) and time.monotonic()<deadline:
        if offset%1000==0:store.ensure_capacity()
        requested=ids[offset:offset+100]
        articles=details(requested)
        valid=[p for p in articles if p.get("pmid") in requested and p.get("title")]
        found={p["pmid"] for p in valid}
        # Date corrections outside the search window are examined but not imported.
        # They are not missing metadata and must not trap a checkpoint in retries.
        eligible=[p for p in valid if automatic_paper(p)]
        for start in range(0,len(eligible),50):store.insert("papers",eligible[start:start+50],"pmid")
        missing=[pmid for pmid in missing if pmid not in found]
        missing.extend(pmid for pmid in requested if pmid not in found and pmid not in missing)
        if any(pmid not in found for pmid in requested):
            store.update(key,{"unavailable_pmids":missing})
            raise ValueError("Incomplete PubMed detail batch; retry without advancing checkpoint")
        offset+=len(requested)
        store.update(key,{"status":"done" if offset==len(ids) else "active","processed":offset,
            "unavailable_pmids":missing,"error_code":None,"retry_after":None})
        print(f"Catalog shard {key[:10]}: {offset}/{len(ids)} examined; {len(missing)} unavailable metadata",flush=True)
    if not ids:store.update(key,{"status":"done","processed":0})


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-seconds",type=int,default=1200)
    parser.add_argument("--seed-only",action="store_true",help="Initialize the registry checkpoints without PubMed requests or catalog scans")
    args=parser.parse_args()
    if not 60<=args.max_seconds<=3600:parser.error("Runtime must be 60..3600 seconds")
    store=Store()
    deadline=time.monotonic()+args.max_seconds
    seed_registry_jobs(store)
    if args.seed_only:
        report_status(store)
        return
    try:store.ensure_capacity()
    except StorageCapacityReached:
        print("::warning::Catalog paused at its storage budget; existing service and checkpoints are preserved")
        report_status(store)
        return
    seed_existing_catalog(store)
    failures=0
    while time.monotonic()<deadline:
        job=store.next_job()
        if not job:break
        try:process_job(store,job,deadline)
        except StorageCapacityReached:
            print("::warning::Catalog paused at its storage budget; resume after approved capacity adjustment")
            break
        except Exception as error:
            failures+=1
            store.update(job["job_key"],{"status":"error","error_code":type(error).__name__,
                "retry_after":(datetime.now(timezone.utc)+timedelta(minutes=15)).isoformat()})
            print(f"Catalog shard {job['job_key'][:10]}: {type(error).__name__}; checkpoint preserved",flush=True)
    report_status(store)
    if failures:print(f"::warning::{failures} catalog searches need retry; completed pages are preserved")


def report_status(store):
    status=store.read("rpc/catalog_backfill_status",{})
    print(json.dumps(status),flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"],"a",encoding="utf-8") as output:
            output.write("Catalog backfill from 2000-01-01\n\n```json\n"+json.dumps(status,indent=2)+"\n```\n")


if __name__=="__main__":main()
