"""
Uro Daily Pick — PubMed paper fetcher
Fetches urology papers and inserts into Supabase.
Run daily via GitHub Actions or manually.
"""
import os
import time
from datetime import datetime, timedelta
from xml.etree import ElementTree as ET

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://vwdcqzcoovczmtzdyzbc.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
PUBMED_EMAIL = "uro-daily-pick@example.com"

# Urology-focused base queries
URO_QUERIES = [
    '"Urology"[MeSH] OR "Urologic Neoplasms"[MeSH]',
    '"Prostatic Neoplasms"[MeSH] OR "prostate cancer"',
    '"Urinary Bladder Neoplasms"[MeSH] OR "bladder cancer"',
    '"Kidney Neoplasms"[MeSH] OR "renal cell carcinoma"',
    '"Robotic Surgical Procedures"[MeSH] AND "Urology"[MeSH]',
    '"Prostatic Hyperplasia"[MeSH] OR "BPH"',
    '"Urinary Incontinence"[MeSH]',
    '"Erectile Dysfunction"[MeSH]',
    '"Kidney Transplantation"[MeSH]',
    '"Urolithiasis"[MeSH] OR "kidney stones"',
]


def supabase_request(method, path, data=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    if method == "GET":
        headers["Prefer"] = ""
        return requests.get(url, headers=headers, params=data, timeout=30)
    elif method == "POST":
        headers["Prefer"] = "resolution=ignore-duplicates,return=minimal"
        return requests.post(url, headers=headers, json=data, timeout=30)
    return None


def search_pmids(query, max_results=100, days_back=7):
    date_from = (datetime.now() - timedelta(days=days_back)).strftime("%Y/%m/%d")
    date_to = datetime.now().strftime("%Y/%m/%d")
    params = {
        "db": "pubmed", "term": query, "retmax": max_results,
        "sort": "relevance", "datetype": "pdat",
        "mindate": date_from, "maxdate": date_to,
        "retmode": "json", "email": PUBMED_EMAIL,
    }
    r = requests.get(f"{PUBMED_BASE}/esearch.fcgi", params=params, timeout=15)
    r.raise_for_status()
    return r.json().get("esearchresult", {}).get("idlist", [])


def fetch_details(pmids):
    if not pmids:
        return []
    params = {
        "db": "pubmed", "id": ",".join(pmids),
        "retmode": "xml", "email": PUBMED_EMAIL,
    }
    r = requests.get(f"{PUBMED_BASE}/efetch.fcgi", params=params, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    return [parse_article(a) for a in root.findall(".//PubmedArticle")]


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
        try:
            pub_date = f"{y}-{int(m):02d}-{int(d):02d}"
        except (ValueError, TypeError):
            pub_date = f"{y}-01-01" if y else None

    mesh_terms = [mh.findtext("DescriptorName", "") for mh in article.findall(".//MeshHeading")]
    keywords = [kw.text for kw in article.findall(".//Keyword") if kw.text]
    doi = ""
    for aid in article.findall(".//ArticleId"):
        if aid.get("IdType") == "doi":
            doi = aid.text or ""
            break

    paper_type = "article"
    title_lower = title.lower()
    if any(s in title_lower for s in ["review", "guideline", "meta-analysis", "systematic review"]):
        paper_type = "review"
    elif any(s in title_lower for s in ["reply to", "letter to the editor", "re:", "comment on", "erratum", "corrigendum", "retraction"]):
        paper_type = "letter"

    return {
        "pmid": pmid, "title": title, "abstract": abstract,
        "authors": authors, "journal": journal, "pub_date": pub_date,
        "mesh_terms": mesh_terms, "keywords": keywords, "doi": doi,
        "paper_type": paper_type,
    }


def get_existing_pmids():
    """Get all PMIDs already in DB."""
    r = supabase_request("GET", "papers", {"select": "pmid"})
    if r.status_code == 200:
        return set(row["pmid"] for row in r.json())
    return set()


def insert_papers(papers):
    """Batch insert papers into Supabase."""
    if not papers:
        return 0
    # Insert in batches of 50
    count = 0
    for i in range(0, len(papers), 50):
        batch = papers[i:i+50]
        r = supabase_request("POST", "papers", batch)
        if r.status_code in (200, 201):
            count += len(batch)
        else:
            print(f"  Insert error: {r.status_code} {r.text[:200]}")
    return count


def main():
    if not SUPABASE_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY not set")
        return

    print(f"=== Uro Daily Pick - Paper Fetch ===")
    print(f"Time: {datetime.now().isoformat()}")

    existing = get_existing_pmids()
    print(f"Existing papers in DB: {len(existing)}")

    total_new = 0
    all_new_papers = []

    for query in URO_QUERIES:
        short = query[:50]
        try:
            pmids = search_pmids(query, max_results=50, days_back=7)
            new_pmids = [p for p in pmids if p not in existing]
            if new_pmids:
                time.sleep(0.4)  # NCBI rate limit
                details = fetch_details(new_pmids)
                valid = [d for d in details if d["pmid"] and d["title"]]
                all_new_papers.extend(valid)
                existing.update(d["pmid"] for d in valid)
                print(f"  [{short}...] {len(pmids)} found, {len(valid)} new")
            else:
                print(f"  [{short}...] {len(pmids)} found, 0 new")
            time.sleep(0.4)
        except Exception as e:
            print(f"  [{short}...] ERROR: {e}")

    if all_new_papers:
        count = insert_papers(all_new_papers)
        total_new = count
        print(f"\nInserted: {count} papers")
    else:
        print("\nNo new papers to insert")

    print(f"Total new: {total_new}")
    print("Done.")


if __name__ == "__main__":
    main()
