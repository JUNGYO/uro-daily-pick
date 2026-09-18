"""
Uro Daily Pick - Paper Classification
Uses PubMed MeSH terms + PublicationType + title/abstract patterns.
No LLM needed — MeSH terms are curated by NLM experts.
"""
import os
import re
import time
from collections import Counter, deque
import requests
from common import supabase_headers
from common import get_json, strings

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
PAGE_SIZE = 100
WRITE_BATCH_SIZE = 25
SPLIT_ERROR_CODES = {"57014", "40P01"}

# ── MeSH → study_type mapping ──
MESH_STUDY_TYPE = {
    # RCT / Clinical trials
    "randomized controlled trial": "rct",
    # Retrospective
    "retrospective studies": "retrospective",
    # Prospective
    "prospective studies": "prospective",
    # Meta / Systematic review
    "meta-analysis": "meta_analysis",
    "systematic review": "meta_analysis",
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
    "rct": ["randomized trial", "randomised trial", "randomly assigned", "randomly allocated", "randomized controlled", "randomised controlled"],
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

    text = re.sub(r"\bnon[- ]?randomi[sz]ed\b", "nonrandom", text)

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
    headers = {**supabase_headers(SUPABASE_KEY)}
    return get_json(url, headers=headers, params=params)


def candidate_page(after_id, reclassify_all=False):
    """Read only one bounded source snapshot; never enumerate the whole catalog."""
    rows = sb_get("rpc/classification_candidates", {
        "p_after_id": str(after_id), "p_limit": str(PAGE_SIZE),
        "p_reclassify_all": str(reclassify_all).lower(),
    })
    if not isinstance(rows, list) or len(rows) > PAGE_SIZE:
        raise ValueError("Invalid classification candidate page")
    previous = after_id
    for row in rows:
        if (not isinstance(row, dict) or type(row.get("id")) is not int
                or row["id"] <= previous
                or not isinstance(row.get("classification_source_hash"), str)
                or re.fullmatch(r"[0-9a-f]{64}", row["classification_source_hash"]) is None):
            raise ValueError("Invalid classification snapshot or cursor")
        previous = row["id"]
    return rows


class ClassificationSaveError(RuntimeError):
    """A sanitized failed write; only confirmed transaction errors permit splitting."""

    def __init__(self, message, *, code=None):
        super().__init__(message)
        self.code = code


def save_classifications(results):
    """Retry identical, source-bound assignments safely after an uncertain commit."""
    url = f"{SUPABASE_URL}/rest/v1/rpc/apply_paper_classifications"
    headers = {**supabase_headers(SUPABASE_KEY), "Content-Type": "application/json"}
    payload = {"p_results": results}
    for attempt in range(4):
        response = None
        category, code = "unknown", None
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=(10, 45))
            if response.status_code >= 400:
                category = f"HTTP {response.status_code}"
                if response.status_code not in (408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524):
                    raise RuntimeError(f"Classification save rejected ({category})")
                try:
                    error = response.json()
                except ValueError:
                    error = None
                candidate = error.get("code") if isinstance(error, dict) else None
                if isinstance(candidate, str) and re.fullmatch(r"[0-9A-Z]{5}|PGRST[0-9]{3}", candidate):
                    code = candidate
            else:
                outcome = response.json()
                if (not isinstance(outcome, dict)
                        or any(type(outcome.get(key)) is not int or outcome[key] < 0 for key in ("updated", "stale"))
                        or outcome["updated"] + outcome["stale"] != len(results)):
                    raise RuntimeError("Invalid classification save acknowledgement")
                return outcome
        except requests.Timeout:
            category = "timeout"
        except requests.ConnectionError:
            category = "connection"
        except ValueError:
            category = "invalid_json"
        finally:
            if response is not None:
                response.close()
        if attempt == 3 or (code in SPLIT_ERROR_CODES and attempt >= 1):
            detail = category + (f" code {code}" if code is not None else "")
            raise ClassificationSaveError(
                f"Classification save failed after {attempt + 1} attempts ({detail})", code=code,
            ) from None
        time.sleep(min(2 ** (attempt + 1), 8))


def run_classification(*, max_seconds=600, after_id=0, reclassify_all=False):
    deadline = time.monotonic() + max_seconds
    cursor, processed, updated, stale = after_id, 0, 0, 0
    type_counts = Counter()
    complete = False
    write_size = WRITE_BATCH_SIZE
    while time.monotonic() < deadline:
        papers = candidate_page(cursor, reclassify_all)
        if not papers:
            complete = True
            break
        results = []
        for paper in papers:
            study_type, _ = classify(strings(paper.get("mesh_terms")), strings(paper.get("pub_types")),
                                     paper.get("title"), paper.get("abstract"))
            results.append({"id": paper["id"], "source_hash": paper["classification_source_hash"],
                            "study_type": study_type})
        pending = deque(results[start:start + write_size] for start in range(0, len(results), write_size))
        budget_reached = False
        while pending:
            if time.monotonic() >= deadline:
                budget_reached = True
                break
            batch = pending.popleft()
            # A previous transaction may have reduced the cap for this run.
            if len(batch) > write_size:
                chunks = [batch[start:start + write_size] for start in range(0, len(batch), write_size)]
                pending.extendleft(reversed(chunks))
                continue
            try:
                outcome = save_classifications(batch)
            except ClassificationSaveError as error:
                if error.code not in SPLIT_ERROR_CODES or len(batch) == 1:
                    print(f"Classification stopped after {processed} acknowledged records; cursor {cursor}", flush=True)
                    raise
                middle = len(batch) // 2
                left, right = batch[:middle], batch[middle:]
                write_size = min(write_size, len(right))
                pending.extendleft((right, left))
                print(f"Classification transaction {error.code}: retrying {len(batch)} records in smaller batches; "
                      f"cursor {cursor}", flush=True)
                continue
            except RuntimeError:
                print(f"Classification stopped after {processed} acknowledged records; cursor {cursor}", flush=True)
                raise
            # Advance only after each sub-batch is acknowledged. Source changes
            # and untouched rows remain pending for the next run.
            cursor = batch[-1]["id"]
            processed += len(batch)
            updated += outcome["updated"]
            stale += outcome["stale"]
            type_counts.update(result["study_type"] for result in batch)
            print(f"Classification batch: {outcome['updated']} saved, {outcome['stale']} source changes deferred; "
                  f"{processed} processed, cursor {cursor}", flush=True)
        if budget_reached:
            break
    return {"processed": processed, "updated": updated, "stale": stale, "cursor": cursor,
            "complete": complete, "types": dict(type_counts)}


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise SystemExit("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY required")

    try:
        max_seconds = int(os.environ.get("CLASSIFICATION_MAX_SECONDS", "600"))
        after_id = int(os.environ.get("CLASSIFICATION_AFTER_ID", "0"))
        if not 1 <= max_seconds <= 3600 or not 0 <= after_id <= 9223372036854775807:
            raise ValueError
    except ValueError:
        raise SystemExit("Invalid classification time budget or resume cursor") from None
    reclassify_all = os.environ.get("RECLASSIFY_ALL") == "true"
    if after_id and not reclassify_all:
        raise SystemExit("CLASSIFICATION_AFTER_ID is only for an explicit RECLASSIFY_ALL pass")
    print("=== Classifying stored citation metadata in resumable batches ===", flush=True)
    result = run_classification(max_seconds=max_seconds, after_id=after_id, reclassify_all=reclassify_all)
    status = ("eligible pass complete." if result["complete"] else
              "time budget reached; resume this explicit pass at the saved cursor." if reclassify_all else
              "time budget reached; unfinished records remain pending.")
    message = f"Classification: {result['updated']} saved, {result['stale']} source changes deferred; {status}"
    print(message, flush=True)
    if reclassify_all and not result["complete"]:
        print(f"Resume this explicit pass with RECLASSIFY_ALL=true CLASSIFICATION_AFTER_ID={result['cursor']}", flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write(message + "\n")


if __name__ == "__main__":
    main()
