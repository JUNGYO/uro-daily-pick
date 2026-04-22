"""
Uro Daily Pick - Paper Classification
Uses PubMed MeSH terms + PublicationType + title/abstract patterns.

Performance notes:
- Supabase Free tier PostgREST is slow at returning large payloads.
- We therefore do NOT fetch `abstract` from Supabase.
- Abstract is fetched fresh from PubMed in the same XML call as MeSH.
"""
import os
import json
import time
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from xml.etree import ElementTree as ET

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

# ── HTTP session with retry/backoff ──
_session = requests.Session()
_session.mount("https://", HTTPAdapter(max_retries=Retry(
    total=5,
    backoff_factor=2,              # 2s → 4s → 8s → 16s → 32s
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=["GET", "POST", "PATCH"],
)))

# ── MeSH → study_type mapping ──
MESH_STUDY_TYPE = {
    "randomized controlled trial": "rct",
    "randomized controlled trials as topic": "rct",
    "clinical trial, phase ii": "rct",
    "clinical trial, phase iii": "rct",
    "clinical trial, phase iv": "rct",
    "controlled clinical trial": "rct",
    "retrospective studies": "retrospective",
    "cohort studies": "retrospective",
    "medical records": "retrospective",
    "registries": "retrospective",
    "prospective studies": "prospective",
    "follow-up studies": "prospective",
    "longitudinal studies": "prospective",
    "meta-analysis": "meta_analysis",
    "meta-analysis as topic": "meta_analysis",
    "systematic review": "meta_analysis",
    "systematic reviews as topic": "meta_analysis",
    "animals": "basic_research",
    "mice": "basic_research",
    "rats": "basic_research",
    "cell line, tumor": "basic_research",
    "cell line": "basic_research",
    "xenograft model antitumor assays": "basic_research",
    "tumor microenvironment": "basic_research",
    "signal transduction": "basic_research",
    "gene expression regulation, neoplastic": "basic_research",
    "apoptosis": "basic_research",
    "cell proliferation": "basic_research",
    "biomarkers, tumor": "biomarker",
    "biomarkers": "biomarker",
    "prognosis": "biomarker",
    "liquid biopsy": "biomarker",
    "circulating tumor dna": "biomarker",
    "circulating tumor cells": "biomarker",
    "prostate-specific antigen": "biomarker",
    "genomics": "biomarker",
    "proteomics": "biomarker",
    "transcriptome": "biomarker",
    "machine learning": "ai_ml",
    "deep learning": "ai_ml",
    "artificial intelligence": "ai_ml",
    "neural networks, computer": "ai_ml",
    "robotic surgical procedures": "surgical",
    "laparoscopy": "surgical",
    "minimally invasive surgical procedures": "surgical",
    "nephrectomy": "surgical",
    "prostatectomy": "surgical",
    "cystectomy": "surgical",
    "magnetic resonance imaging": "imaging",
    "tomography, x-ray computed": "imaging",
    "ultrasonography": "imaging",
    "positron-emission tomography": "imaging",
    "radiomics": "imaging",
    "incidence": "epidemiology",
    "prevalence": "epidemiology",
    "risk factors": "epidemiology",
    "health disparities": "epidemiology",
    "survival rate": "epidemiology",
    "practice guideline": "guideline",
    "guideline": "guideline",
    "case reports": "case_report",
}

MESH_TAGS = {
    "prostatic neoplasms": "prostate", "prostate": "prostate", "prostatectomy": "prostate",
    "prostate-specific antigen": "prostate", "prostatic hyperplasia": "bph",
    "urinary bladder neoplasms": "bladder", "cystectomy": "bladder", "urinary bladder": "bladder",
    "kidney neoplasms": "kidney", "carcinoma, renal cell": "kidney", "nephrectomy": "kidney",
    "testicular neoplasms": "testicular",
    "adrenal cortex neoplasms": "adrenal",
    "urolithiasis": "stone", "kidney calculi": "stone",
    "urinary incontinence": "incontinence",
    "kidney transplantation": "transplant",
    "erectile dysfunction": "andrology", "infertility, male": "andrology",
    "immunotherapy": "immunotherapy", "immune checkpoint inhibitors": "immunotherapy",
    "molecular targeted therapy": "targeted_therapy",
    "radiotherapy": "radiation", "brachytherapy": "radiation",
    "drug therapy": "chemotherapy", "antineoplastic agents": "chemotherapy",
    "robotic surgical procedures": "robotic",
    "laparoscopy": "laparoscopic",
    "survival analysis": "survival", "survival rate": "survival",
    "quality of life": "quality_of_life",
    "mass screening": "screening", "early detection of cancer": "screening",
    "diagnosis": "diagnosis",
    "cost-benefit analysis": "cost_effectiveness",
}

STUDY_TYPE_PRIORITY = [
    "rct", "meta_analysis", "guideline", "case_report",
    "ai_ml", "imaging", "biomarker", "surgical",
    "basic_research", "prospective", "retrospective",
    "epidemiology", "review",
]

TITLE_PATTERNS = {
    "rct": ["randomized", "randomised", "phase ii", "phase iii", "phase 2 ", "phase 3 ", "double-blind", "placebo-controlled"],
    "meta_analysis": ["systematic review", "meta-analysis", "meta analysis", "prisma"],
    "retrospective": ["retrospective", "chart review", "database analysis", "registry"],
    "prospective": ["prospective cohort", "prospective study", "prospectively"],
    "basic_research": ["in vitro", "in vivo", "cell line", "mouse model", "xenograft", "knockout mice", "western blot", "signaling pathway"],
    "biomarker": ["biomarker", "prognostic marker", "predictive marker", "liquid biopsy", "circulating tumor"],
    "ai_ml": ["machine learning", "deep learning", "artificial intelligence", "neural network", "convolutional", "large language model"],
    "surgical": ["surgical technique", "operative outcome", "robotic-assisted", "robot-assisted"],
    "imaging": ["mri ", "ct scan", "radiomics", "imaging study"],
    "epidemiology": ["incidence", "prevalence", "population-based", "nationwide", "trends in"],
    "guideline": ["guideline", "consensus statement"],
    "case_report": ["case report", "case series", "a rare case"],
    "review": ["a review", "narrative review", "current update", "state of the art"],
}


def classify(mesh_terms, pub_types, title, abstract):
    """Classify a paper using MeSH + PubType + text patterns."""
    mesh_lower = [m.lower() for m in (mesh_terms or [])]
    pub_lower = [p.lower() for p in (pub_types or [])]
    text = f"{(title or '').lower()} {(abstract or '').lower()}"

    candidates = set()
    for term in mesh_lower + pub_lower:
        if term in MESH_STUDY_TYPE:
            candidates.add(MESH_STUDY_TYPE[term])

    if not candidates:
        for stype, patterns in TITLE_PATTERNS.items():
            if any(p in text for p in patterns):
                candidates.add(stype)

    study_type = "other"
    for st in STUDY_TYPE_PRIORITY:
        if st in candidates:
            study_type = st
            break

    tags = set()
    for term in mesh_lower:
        for mesh_key, tag in MESH_TAGS.items():
            if mesh_key in term:
                tags.add(tag)
                break

    if study_type == "other" and "review" in pub_lower:
        study_type = "review"

    return study_type, sorted(tags)


def sb_get(path, params):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    return _session.get(url, headers=headers, params=params, timeout=90).json()


def sb_patch(paper_id, data):
    url = f"{SUPABASE_URL}/rest/v1/papers?id=eq.{paper_id}"
    headers = {
        "apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json", "Prefer": "return=minimal",
    }
    return _session.patch(url, headers=headers, json=data, timeout=60)


def fetch_unclassified_papers(page_size=50, max_total=2000):
    """Fetch rows that still need classification, paginated.

    IMPORTANT: do NOT select `abstract` — on Supabase Free tier
    PostgREST is slow at serializing large text columns. We get
    abstract fresh from PubMed in fetch_pubmed_metadata().
    """
    papers = []
    offset = 0
    while offset < max_total:
        batch = sb_get("papers", {
            "select": "id,pmid,title,mesh_terms,study_type",
            "or": "(study_type.is.null,study_type.eq.other)",
            "order": "fetched_at.desc",
            "limit": str(page_size),
            "offset": str(offset),
        })
        if not batch:
            break
        papers.extend(batch)
        print(f"  ...fetched {len(papers)} rows so far")
        if len(batch) < page_size:
            break
        offset += page_size
    return papers


def fetch_pubmed_metadata(pmids):
    """Fetch MeSH + PublicationType + Abstract from PubMed for given PMIDs."""
    if not pmids:
        return {}
    r = _session.get(f"{PUBMED_BASE}/efetch.fcgi", params={
        "db": "pubmed", "id": ",".join(pmids), "retmode": "xml", "email": "uro-daily-pick@example.com",
    }, timeout=60)
    r.raise_for_status()
    root = ET.fromstring(r.content)

    result = {}
    for art in root.findall(".//PubmedArticle"):
        pmid = (art.findtext(".//PMID") or "").strip()
        mesh = [mh.findtext("DescriptorName", "") for mh in art.findall(".//MeshHeading")]
        ptypes = [pt.text for pt in art.findall(".//PublicationType") if pt.text]
        abstract_parts = [at.text or "" for at in art.findall(".//Abstract/AbstractText")]
        abstract = " ".join(p for p in abstract_parts if p).strip()
        result[pmid] = {
            "mesh_terms": mesh,
            "pub_types": ptypes,
            "abstract": abstract,
        }
    return result


def main():
    if not SUPABASE_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY required")
        return

    # Warm-up: free-tier PostgREST often has slow first response
    print("=== Warming up Supabase connection ===")
    try:
        sb_get("papers", {"select": "id", "limit": "1"})
        print("  Warm-up OK")
    except Exception as e:
        print(f"  Warm-up failed (continuing anyway): {e}")

    print("\n=== Fetching unclassified papers (no abstract) ===")
    to_classify = fetch_unclassified_papers(page_size=50, max_total=2000)
    print(f"=== Classifying {len(to_classify)} papers ===")

    if not to_classify:
        print("All papers already classified.")
        return

    from collections import Counter
    type_counts = Counter()
    failed = 0

    for i in range(0, len(to_classify), 50):
        batch = to_classify[i:i+50]
        pmids = [p["pmid"] for p in batch]

        print(f"\n  Fetching PubMed metadata for batch {i//50 + 1}...")
        try:
            meta = fetch_pubmed_metadata(pmids)
        except Exception as e:
            print(f"  PubMed fetch failed for batch {i//50 + 1}: {e}")
            meta = {}
        time.sleep(0.5)

        for paper in batch:
            pmid = paper["pmid"]
            pm = meta.get(pmid, {})
            mesh = pm.get("mesh_terms") or paper.get("mesh_terms") or []
            ptypes = pm.get("pub_types", [])
            abstract = pm.get("abstract", "")   # from PubMed, not Supabase

            study_type, tags = classify(mesh, ptypes, paper.get("title"), abstract)

            try:
                sb_patch(paper["id"], {
                    "study_type": study_type,
                    "pub_types": json.dumps(tags),
                    "mesh_terms": json.dumps(mesh),
                })
                type_counts[study_type] += 1
                print(f"    {pmid} -> {study_type:20s} | {tags}")
            except Exception as e:
                failed += 1
                print(f"    {pmid} -> UPDATE FAILED: {e}")

    print(f"\n=== Summary ===")
    for st, c in type_counts.most_common():
        print(f"  {c:3d}x {st}")
    if failed:
        print(f"  {failed} paper(s) failed to update")
    print("Done.")


if __name__ == "__main__":
    main()
