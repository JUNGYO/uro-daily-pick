"""
Uro Daily Pick — PubMed paper fetcher
Fetches urology papers and inserts into Supabase.
Run daily via GitHub Actions or manually.
"""
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from xml.etree import ElementTree as ET

import requests
from catalog_policy import PUBMED_DATE_RANGE, automatic_paper
from common import supabase_headers
from classify_papers import classify
from common import get_json
from journal_registry import JOURNALS, REGISTRY_VERSION, build_journal_queries

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
PUBMED_EMAIL = os.environ.get("NCBI_EMAIL", "")

# Daily discovery and historical backfill share the reviewed journal identities.
URO_JOURNALS = [j.display_name for j in JOURNALS if j.group == "urology"]
ONCO_JOURNALS = [j.display_name for j in JOURNALS if j.group == "oncology"]
GENERAL_JOURNALS = [j.display_name for j in JOURNALS if j.group == "general"]

URO_QUERIES = build_journal_queries()


class StorageCapacityReached(Exception):
    pass


def ensure_catalog_capacity():
    status = get_json(f"{SUPABASE_URL}/rest/v1/rpc/catalog_storage_status",
                      headers=supabase_headers(SUPABASE_KEY), params={})
    if int(status["database_bytes"]) >= int(status["budget_bytes"]):
        raise StorageCapacityReached("Database storage budget reached; existing records preserved")


def supabase_request(method, path, data=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {
        **supabase_headers(SUPABASE_KEY),
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    if method == "GET":
        headers["Prefer"] = ""
        return requests.get(url, headers=headers, params=data, timeout=30)
    elif method == "POST":
        headers["Prefer"] = "resolution=ignore-duplicates,return=representation"
        return requests.post(url, headers=headers, params={"on_conflict": "pmid", "select": "pmid"}, json=data, timeout=30)
    return None


def search_pmids(query, max_results=100, days_back=7):
    date_from = (datetime.now() - timedelta(days=days_back)).strftime("%Y/%m/%d")
    date_to = datetime.now().strftime("%Y/%m/%d")
    params = {
        "db": "pubmed", "term": query, "retmax": max_results,
        "sort": "relevance", "datetype": "edat",
        "mindate": date_from, "maxdate": date_to,
        "retmode": "json", "email": PUBMED_EMAIL,
    }
    pmids = []
    while True:
        params["retstart"] = len(pmids)
        r = requests.get(f"{PUBMED_BASE}/esearch.fcgi", params=params, timeout=30)
        r.raise_for_status()
        result = r.json()["esearchresult"]
        warnings = result.get("warninglist") or {}
        if result.get("errorlist") or any(warnings.get(k) for k in (
                "phrasesnotfound", "quotedphrasesnotfound", "phrasesignored")):
            raise ValueError("PubMed did not recognize a configured search term")
        page = result.get("idlist", [])
        if any(not str(p).isdigit() or int(p) < 1 for p in page) or len(set(pmids + page)) != len(pmids) + len(page):
            raise ValueError("Invalid or duplicate PubMed identifiers")
        total = int(result.get("count", len(page)))
        if total < 0 or len(pmids) + len(page) > total:
            raise ValueError("Inconsistent PubMed search count")
        if total > 9999:
            raise ValueError("PubMed result exceeds 9,999; narrow the date window")
        pmids.extend(page)
        if len(pmids) >= total:
            return pmids
        if not page:
            raise ValueError("Incomplete PubMed search response")
        time.sleep(0.4)



def fetch_details(pmids):
    if not pmids:
        return []
    if len(pmids) > 100:
        result = []
        for start in range(0, len(pmids), 100):
            result.extend(fetch_details(pmids[start:start + 100]))
            time.sleep(0.4)
        return result
    params = {
        "db": "pubmed", "id": ",".join(pmids),
        "retmode": "xml", "email": PUBMED_EMAIL,
    }
    r = requests.get(f"{PUBMED_BASE}/efetch.fcgi", params=params, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    if root.tag == "ERROR" or root.find(".//ERROR") is not None:
        raise ValueError("PubMed metadata returned an error")
    papers = [parse_article(a) for a in root.findall(".//PubmedArticle")]
    if any(not p["title"].strip() for p in papers):
        raise ValueError("PubMed metadata is missing a required title")
    received = [p["pmid"] for p in papers]
    if len(received) != len(set(received)) or set(received) != set(pmids):
        raise ValueError("PubMed metadata does not match requested identifiers")
    return papers


def classify_study_type(title, abstract, pub_types):
    """Use the same conservative classifier during ingestion and backfill."""
    return classify([], pub_types, title, abstract)[0]


def parse_article(article):
    pmid = (article.findtext(".//PMID") or "").strip()
    title_el = article.find(".//ArticleTitle")
    title = "".join(title_el.itertext()) if title_el is not None else ""
    abstract_parts = article.findall(".//AbstractText")
    abstract = " ".join("".join(a.itertext()) for a in abstract_parts)
    authors = []
    for au in article.findall(".//Author"):
        last = au.findtext("LastName", "")
        first = au.findtext("ForeName", "")
        if last:
            authors.append(f"{last} {first}".strip())
    journal = article.findtext(".//Journal/Title", "")
    pub_el = article.find(".//PubDate")
    pub_date = None
    if pub_el is not None:
        y = pub_el.findtext("Year", "")
        m = pub_el.findtext("Month", "01")
        d = pub_el.findtext("Day", "01")
        # Month might be text like "Mar"
        month_map = {"jan":"01","feb":"02","mar":"03","apr":"04","may":"05","jun":"06",
                     "jul":"07","aug":"08","sep":"09","oct":"10","nov":"11","dec":"12"}
        if m.lower() in month_map:
            m = month_map[m.lower()]
        if not y:
            medline=pub_el.findtext("MedlineDate","")
            year=re.search(r"\b(\d{4})\b",medline)
            y=year.group(1) if year else ""
            for name,number in month_map.items():
                if re.search(r"\b"+name,medline,re.I):m=number;break
        try:
            pub_date = date(int(y),int(m),int(d)).isoformat()
        except (ValueError, TypeError):
            pub_date = f"{y}-01-01" if y.isdigit() and 1<=int(y)<=9999 else None

    mesh_terms = [mh.findtext("DescriptorName", "") for mh in article.findall(".//MeshHeading")]
    keywords = [kw.text for kw in article.findall(".//Keyword") if kw.text]
    doi = ""
    for aid in article.findall(".//ArticleId"):
        if aid.get("IdType") == "doi":
            doi = aid.text or ""
            break

    # PubMed publication types
    pub_types = [pt.text for pt in article.findall(".//PublicationType") if pt.text]
    pub_types_lower = [p.lower() for p in pub_types]

    # Legacy paper_type
    paper_type = "article"
    title_lower = title.lower()
    if any(s in title_lower for s in ["review", "guideline", "meta-analysis", "systematic review"]):
        paper_type = "review"
    elif any(s in title_lower for s in ["reply to", "letter to the editor", "research letter", "letter:", "re:", "comment on", "erratum", "corrigendum", "retraction", "correspondence"]):
        paper_type = "letter"
    elif any(pt.lower() in ("letter", "comment", "editorial") for pt in pub_types):
        paper_type = "letter"
    elif "editorial" in title_lower or "Editorial" in [pt for pt in pub_types]:
        paper_type = "editorial"

    # Study type classification
    study_type = classify_study_type(title_lower, abstract.lower(), pub_types_lower)

    notices=[]
    for node in article.findall('.//CommentsCorrections'):
        linked=(node.findtext('PMID') or '').strip()
        relation=node.get('RefType','')
        if linked.isdigit() and relation in ('RetractionIn','RetractionOf','ErratumIn','ErratumFor','ExpressionOfConcernIn','ExpressionOfConcernFor'):
            notices.append({'pmid':linked,'relation':relation})
    relations={n['relation'] for n in notices}
    integrity=('retracted' if 'retracted publication' in pub_types_lower or 'RetractionIn' in relations else
               'concern' if 'ExpressionOfConcernIn' in relations else 'corrected' if 'ErratumIn' in relations else 'current')
    return {
        "pmid": pmid, "title": title, "abstract": abstract,
        "authors": authors, "journal": journal, "pub_date": pub_date,
        "mesh_terms": mesh_terms, "keywords": keywords, "doi": doi,
        "paper_type": paper_type, "pub_types": pub_types, "study_type": study_type,
        "volume":article.findtext('.//JournalIssue/Volume',''),"issue":article.findtext('.//JournalIssue/Issue',''),
        "pages":article.findtext('.//Pagination/MedlinePgn',''),"publication_types":pub_types,
        "integrity_status":integrity,"related_notices":notices,"integrity_checked_at":datetime.now(timezone.utc).isoformat(),
    }


def get_existing_pmids(candidates=None):
    """Look up only discovered IDs; retain full enumeration for explicit callers."""
    if candidates is not None:
        candidates = list(dict.fromkeys(candidates))
        if any(not str(p).isdigit() for p in candidates):
            raise ValueError("Invalid PubMed identifiers")
        found = set()
        for start in range(0, len(candidates), 200):
            page = get_json(f"{SUPABASE_URL}/rest/v1/papers", headers=supabase_headers(SUPABASE_KEY),
                            params={"select": "pmid", "pmid": "in.(" + ",".join(candidates[start:start+200]) + ")"})
            found.update(row["pmid"] for row in page)
        return found
    found = set()
    offset = 0
    while True:
        page = get_json(f"{SUPABASE_URL}/rest/v1/papers", headers={
            **supabase_headers(SUPABASE_KEY)}, params={
            "select": "pmid", "order": "id", "limit": "500", "offset": str(offset)})
        found.update(row["pmid"] for row in page)
        offset += len(page)
        if len(page) < 500:
            return found


def insert_papers(papers):
    """Batch insert papers into Supabase."""
    if not papers:
        return 0
    # Insert in batches of 50
    count = 0
    for i in range(0, len(papers), 50):
        batch = papers[i:i+50]
        ensure_catalog_capacity()
        r = supabase_request("POST", "papers", batch)
        r.raise_for_status()
        if r.status_code in (200, 201):
            count += len(r.json())
        else:
            print(f"  Insert error: {r.status_code} {r.text[:200]}")
    return count


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise SystemExit("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY required")

    print(f"=== Uro Daily Pick - Paper Fetch ===")
    print(f"Time: {datetime.now().isoformat()}")

    try:
        ensure_catalog_capacity()
    except StorageCapacityReached:
        print("::warning::Daily discovery paused at its database storage budget; no new papers requested")
        return

    existing = set()
    print(f"Journal scope: {REGISTRY_VERSION} ({len(URO_QUERIES)} journals)")

    total_new = 0
    failed_queries = 0

    for query in URO_QUERIES:
        short = query[:50]
        try:
            pmids = search_pmids(f'({query}) AND {PUBMED_DATE_RANGE}', max_results=200, days_back=7)
            existing.update(get_existing_pmids(pmids))
            new_pmids = [p for p in pmids if p not in existing]
            if new_pmids:
                time.sleep(0.4)  # NCBI rate limit
                details = fetch_details(new_pmids)
                valid = [d for d in details if d["pmid"] and d["title"] and automatic_paper(d)]
                inserted = insert_papers(valid)
                total_new += inserted
                existing.update(d["pmid"] for d in valid)
                print(f"  [{short}...] {len(pmids)} found, {inserted} inserted")
            else:
                print(f"  [{short}...] {len(pmids)} found, 0 new")
        except StorageCapacityReached:
            print("::warning::Daily discovery paused at its database storage budget; committed batches preserved")
            if failed_queries:
                raise SystemExit(f"ERROR: {failed_queries} PubMed queries failed before the capacity pause")
            return
        except Exception as e:
            failed_queries += 1
            print(f"  [{short}...] ERROR: {e}")
        finally:
            time.sleep(0.4)

    print(f"Total new: {total_new}")
    if failed_queries:
        raise SystemExit(f"ERROR: {failed_queries} PubMed queries failed; downstream steps must wait")
    print("Done.")


if __name__ == "__main__":
    main()
