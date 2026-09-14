"""Resumable all-time PubMed inventory. Only citation metadata goes to Supabase."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import time
from xml.etree import ElementTree as ET

import requests
from common import get_json, patch_fields, supabase_headers
from fetch_papers import URO_QUERIES, PUBMED_BASE, PUBMED_EMAIL, parse_article

PAGE_LIMIT = 9999


class StorageCapacityReached(Exception):
    pass


def job_for(query, lower=1, upper=None):
    identity=json.dumps([query,lower,upper],separators=(",",":"))
    return {"job_key":hashlib.sha256(identity.encode()).hexdigest(),"query":query,
            "lower_uid":lower,"upper_uid":upper}


def search_term(job):
    query="("+job["query"]+")"
    low,high=job["lower_uid"],job.get("upper_uid")
    if high is not None:
        return f"{query} AND {low}:{high}[UID]"
    return query if low==1 else f"{query} NOT 1:{low-1}[UID]"


def split_job(job, ids):
    low,high=job["lower_uid"],job.get("upper_uid")
    # The open-ended right branch keeps future/large PMIDs and undated records.
    ceiling=high if high is not None else max(int(pmid) for pmid in ids)
    pivot=(low+ceiling)//2
    if pivot<low or (high is not None and pivot>=high) or ceiling<=low:
        raise ValueError("Cannot partition oversized PubMed result")
    return [job_for(job["query"],pivot+1,high),job_for(job["query"],low,pivot)]


def validate_ids(result):
    if result.get("errorlist") or result.get("warninglist",{}).get("phrasesnotfound"):
        raise ValueError("PubMed did not recognize a configured search term")
    count=int(result["count"])
    ids=result.get("idlist",[])
    if any(not str(pmid).isdigit() for pmid in ids) or len(ids)!=len(set(ids)):
        raise ValueError("Invalid PubMed identifier response")
    if count<=PAGE_LIMIT and count!=len(ids):
        raise ValueError("Incomplete PubMed identifier snapshot")
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

    def next_job(self):
        now=datetime.now(timezone.utc).isoformat()
        rows=self.read("catalog_backfill_jobs",{"select":"*","status":"in.(pending,active,error)",
            "or":f"(retry_after.is.null,retry_after.lte.{now})",
            "order":"status.asc,lower_uid.desc,updated_at.asc,job_key","limit":1})
        return rows[0] if rows else None

    def ensure_capacity(self):
        status=self.read("rpc/catalog_storage_status",{})
        if status["database_bytes"]>=status["budget_bytes"]:
            raise StorageCapacityReached("Database storage budget reached; checkpoint retained")


def pubmed_search(job):
    time.sleep(.4)
    return get_json(PUBMED_BASE+"/esearch.fcgi",headers={},params={"db":"pubmed","term":search_term(job),
        "retmax":PAGE_LIMIT,"retmode":"json","tool":"uro_daily_pick","email":PUBMED_EMAIL})["esearchresult"]


def seed_existing_catalog(store):
    """Audit a durable snapshot of every existing PMID, including other journals."""
    job=job_for("Existing catalog citation audit v1")
    if store.read("catalog_backfill_jobs",{"select":"job_key","job_key":"eq."+job["job_key"],"limit":1}):
        return
    ids=[]
    while True:
        page=store.read("papers",{"select":"pmid","order":"id","offset":len(ids),"limit":1000})
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
        # No abstract/date/article-type filter: complete historical citation inventory.
        for start in range(0,len(valid),50):store.insert("papers",valid[start:start+50],"pmid")
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
    args=parser.parse_args()
    if not 60<=args.max_seconds<=3600:parser.error("Runtime must be 60..3600 seconds")
    store=Store()
    try:store.ensure_capacity()
    except StorageCapacityReached:
        print("::warning::Catalog paused at its storage budget; existing service and checkpoints are preserved")
        return
    seed_existing_catalog(store)
    store.insert("catalog_backfill_jobs",[job_for(q) for q in URO_QUERIES],"job_key")
    deadline=time.monotonic()+args.max_seconds
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
    status=store.read("rpc/catalog_backfill_status",{})
    print(json.dumps(status),flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"],"a",encoding="utf-8") as output:
            output.write("All-time catalog backfill\n\n```json\n"+json.dumps(status,indent=2)+"\n```\n")
    if failures:print(f"::warning::{failures} catalog searches need retry; completed pages are preserved")


if __name__=="__main__":main()
