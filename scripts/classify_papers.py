"""
Uro Daily Pick - Paper Classification
Uses PubMed MeSH terms + PublicationType + title/abstract patterns.
No LLM needed — MeSH terms are curated by NLM experts.
"""
import os
import json
import time
import requests
from xml.etree import ElementTree as ET

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://vwdcqzcoovczmtzdyzbc.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

# ── MeSH → study_type mapping ──
MESH_STUDY_TYPE = {
    # RCT / Clinical trials
    "randomized controlled trial": "rct",
    "randomized controlled trials as topic": "rct",
    "clinical trial, phase ii": "rct",
    "clinical trial, phase iii": "rct",
    "clinical trial, phase iv": "rct",
    "controlled clinical trial": "rct",
    # Retrospective
    "retrospective studies": "retrospective",
    "cohort studies": "retrospective",  # often retrospective in practice
    "medical records": "retrospective",
    "registries": "retrospective",
    # Prospective
    "prospective studies": "prospective",
    "follow-up studies": "prospective",
    "longitudinal studies": "prospective",
    # Meta / Systematic review
    "meta-analysis": "meta_analysis",
    "meta-analysis as topic": "meta_analysis",
    "systematic review": "meta_analysis",
    "systematic reviews as topic": "meta_analysis",
    # Basic research
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
    # Biomarker
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
    # AI/ML
    "machine learning": "ai_ml",
    "deep learning": "ai_ml",
    "artificial intelligence": "ai_ml",
    "neural networks, computer": "ai_ml",
    # Surgical
    "robotic surgical procedures": "surgical",
    "laparoscopy": "surgical",
    "minimally invasive surgical procedures": "surgical",
    "nephrectomy": "surgical",
    "prostatectomy": "surgical",
    "cystectomy": "surgical",
    # Imaging
    "magnetic resonance imaging": "imaging",
    "tomography, x-ray computed": "imaging",
    "ultrasonography": "imaging",
    "positron-emission tomography": "imaging",
    "radiomics": "imaging",
    # Epidemiology
    "incidence": "epidemiology",
    "prevalence": "epidemiology",
    "risk factors": "epidemiology",
    "health disparities": "epidemiology",
    "survival rate": "epidemiology",
    # Review / Guideline
    "practice guideline": "guideline",
    "guideline": "guideline",
    # Case report
    "case reports": "case_report",
}

# ── MeSH → tags mapping ──
MESH_TAGS = {
    # Organ
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
    # Treatment
    "immunotherapy": "immunotherapy", "immune checkpoint inhibitors": "immunotherapy",
    "molecular targeted therapy": "targeted_therapy",
    "radiotherapy": "radiation", "brachytherapy": "radiation",
    "drug therapy": "chemotherapy", "antineoplastic agents": "chemotherapy",
    "robotic surgical procedures": "robotic",
    "laparoscopy": "laparoscopic",
    # Study focus
    "survival analysis": "survival", "survival rate": "survival",
    "quality of life": "quality_of_life",
    "mass screening": "screening", "early detection of cancer": "screening",
    "diagnosis": "diagnosis",
    "cost-benefit analysis": "cost_effectiveness",
}

# Priority order for study_type (first match wins)
STUDY_TYPE_PRIORITY = [
    "rct", "meta_analysis", "guideline", "case_report",
    "ai_ml", "imaging", "biomarker", "surgical",
    "basic_research", "prospective", "retrospective",
    "epidemiology", "review",
]

# Title/abstract fallback patterns
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

    # 1. Collect all possible study_types from MeSH + PubType
    candidates = set()
    for term in mesh_lower + pub_lower:
        if term in MESH_STUDY_TYPE:
            candidates.add(MESH_STUDY_TYPE[term])

    # 2. Text pattern fallback
    if not candidates:
        for stype, patterns in TITLE_PATTERNS.items():
            if any(p in text for p in patterns):
                candidates.add(stype)

    # 3. Pick by priority
    study_type = "other"
    for st in STUDY_TYPE_PRIORITY:
        if st in candidates:
            study_type = st
            break

    # 4. Extract tags from MeSH
    tags = set()
    for term in mesh_lower:
        for mesh_key, tag in MESH_TAGS.items():
            if mesh_key in term:
                tags.add(tag)
                break

    # 5. Check review from PubType (if not already classified higher)
    if study_type == "other" and "review" in pub_lower:
        study_type = "review"

    return study_type, sorted(tags)


def sb_get(path, params):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    return requests.get(url, headers=headers, params=params, timeout=30).json()


def sb_patch(paper_id, data):
    url = f"{SUPABASE_URL}/rest/v1/papers?id=eq.{paper_id}"
    headers = {
        "apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json", "Prefer": "return=minimal",
    }
    return requests.patch(url, headers=headers, json=data, timeout=30)


def fetch_pubmed_metadata(pmids):
    """Fetch MeSH + PublicationType from PubMed for given PMIDs."""
    if not pmids:
        return {}
    r = requests.get(f"{PUBMED_BASE}/efetch.fcgi", params={
        "db": "pubmed", "id": ",".join(pmids), "retmode": "xml", "email": "uro-daily-pick@example.com",
    }, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.content)

    result = {}
    for art in root.findall(".//PubmedArticle"):
        pmid = (art.findtext(".//PMID") or "").strip()
        mesh = [mh.findtext("DescriptorName", "") for mh in art.findall(".//MeshHeading")]
        ptypes = [pt.text for pt in art.findall(".//PublicationType") if pt.text]
        result[pmid] = {"mesh_terms": mesh, "pub_types": ptypes}
    return result


def main():
    if not SUPABASE_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY required")
        return

    # Get all papers
    papers = sb_get("papers", {
        "select": "id,pmid,title,abstract,mesh_terms,study_type",
        "order": "fetched_at.desc",
        "limit": "1000",
    })

    # Filter unclassified
    to_classify = [p for p in papers if not p.get("study_type") or p["study_type"] == "other"]
    print(f"=== Classifying {len(to_classify)} / {len(papers)} papers ===")

    if not to_classify:
        print("All papers already classified.")
        return

    # Fetch fresh MeSH from PubMed (in batches of 50)
    from collections import Counter
    type_counts = Counter()

    for i in range(0, len(to_classify), 50):
        batch = to_classify[i:i+50]
        pmids = [p["pmid"] for p in batch]

        print(f"\n  Fetching PubMed metadata for batch {i//50 + 1}...")
        meta = fetch_pubmed_metadata(pmids)
        time.sleep(0.5)

        for paper in batch:
            pmid = paper["pmid"]
            pm = meta.get(pmid, {})
            mesh = pm.get("mesh_terms") or paper.get("mesh_terms") or []
            ptypes = pm.get("pub_types", [])

            study_type, tags = classify(mesh, ptypes, paper.get("title"), paper.get("abstract"))

            sb_patch(paper["id"], {
                "study_type": study_type,
                "pub_types": json.dumps(tags),
                "mesh_terms": json.dumps(mesh),
            })

            type_counts[study_type] += 1
            print(f"    {pmid} -> {study_type:20s} | {tags}")

    print(f"\n=== Summary ===")
    for st, c in type_counts.most_common():
        print(f"  {c:3d}x {st}")
    print("Done.")


if __name__ == "__main__":
    main()
