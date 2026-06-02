"""
Uro Daily Pick - Korean Summary Generator
Uses Gemini 2.5 Pro to generate 3-line Korean summaries.
"""
import os
import json
import time
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"

_session = requests.Session()
_session.mount("https://", HTTPAdapter(max_retries=Retry(
    total=5,
    backoff_factor=2,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=["GET", "POST", "PATCH"],
)))

# Force a fresh TCP connection on every request; prevents Supabase Free tier
# PostgREST from hanging when we reuse a kept-alive connection.
BASE_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Connection": "close",
}

PROMPT = """You are a medical research summarizer for Korean urologists.

TASK: Analyze the following paper and respond in EXACTLY this JSON format (no markdown, no code fences):

{{
  "summary_ko": "sentence1\\nsentence2\\nsentence3",
  "structured": {{
    "study_design": "e.g. RCT, retrospective cohort, meta-analysis",
    "sample_size": "e.g. 1,234 patients or N/A",
    "key_finding": "one-line key result with numbers",
    "population": "e.g. mCRPC patients, localized RCC"
  }},
  "clinical_relevance": 1-5,
  "qa": [
    {{"q": "key clinical question in Korean", "a": "concise answer in Korean with data"}}
  ]
}}

RULES for summary_ko (3 Korean sentences, separated by \\n):
- Sentence 1: 연구 배경과 목적
- Sentence 2: 주요 방법론과 결과 (include specific numbers)
- Sentence 3: 임상적 의의와 결론
- Write in Korean, keep medical terms in English (prostate, RCC, PSA, HR, OS)
- Include numbers from abstract (HR 0.72, p=0.003, 5-year OS 85%)

RULES for clinical_relevance (integer 1-5):
- 5 = Practice-changing (new standard of care)
- 4 = High relevance (strong evidence, likely to influence practice)
- 3 = Moderate (useful data, incremental advance)
- 2 = Low (early/preclinical, niche population)
- 1 = Minimal (case report, editorial, commentary)

RULES for qa (1 question-answer pair):
- Ask the most clinically important question a urologist would have
- Answer concisely in Korean with specific data from the paper

Title: {title}

Abstract: {abstract}

JSON response:"""


def sb_get(path, params, max_attempts=4):
    """GET with retry on empty body / 5xx (Free tier PostgREST glitch)."""
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            r = _session.get(url, headers=BASE_HEADERS, params=params, timeout=90)
            if r.status_code != 200:
                last_err = f"HTTP {r.status_code}: {r.text[:200]}"
            elif not r.text.strip():
                last_err = "empty response body"
            else:
                return r.json()
        except (requests.RequestException, ValueError) as e:
            last_err = f"{type(e).__name__}: {e}"
        print(f"  sb_get {path} retry {attempt}/{max_attempts} ({last_err})")
        time.sleep(2 ** attempt)
    raise RuntimeError(f"sb_get {path} failed after {max_attempts} attempts: {last_err}")


def sb_patch(paper_id, data):
    url = f"{SUPABASE_URL}/rest/v1/papers?id=eq.{paper_id}"
    headers = {**BASE_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"}
    return _session.patch(url, headers=headers, json=data, timeout=60)


def summarize(title, abstract):
    prompt = PROMPT.format(title=title or "Untitled", abstract=(abstract or "No abstract.")[:3000])
    try:
        resp = requests.post(f"{GEMINI_URL}?key={GEMINI_API_KEY}",
            headers={"Content-Type": "application/json"},
            json={"contents": [{"role": "user", "parts": [{"text": prompt}]}],
                  "generationConfig": {"maxOutputTokens": 8192, "temperature": 0.5}},
            timeout=120)
    except requests.exceptions.RequestException as e:
        print(f"    REQUEST ERROR: {e}")
        return None

    if resp.status_code != 200:
        print(f"    API ERROR {resp.status_code}: {resp.text[:300]}")
        return None
    try:
        data = resp.json()
        if not data.get("candidates"):
            print(f"    NO CANDIDATES: {json.dumps(data)[:300]}")
            return None
        parts = data["candidates"][0]["content"]["parts"]
        # 2.5 Pro may have thinking part first, then text part
        for part in reversed(parts):
            if "text" in part and part.get("thought") is not True:
                return part["text"].strip()
        # Fallback: last part with text
        for part in reversed(parts):
            if "text" in part:
                return part["text"].strip()
        return None
    except (KeyError, IndexError) as e:
        print(f"    PARSE ERROR: {e} — {resp.text[:200]}")
        return None


def main():
    if not SUPABASE_KEY or not GEMINI_API_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY and GEMINI_API_KEY required")
        return

    def needs_update(p):
        s = p.get("summary_ko")
        if not s:
            return True
        lines = [l for l in s.strip().split('\n') if l.strip()]
        if len(lines) < 3:
            return True
        # Re-summarize if missing structured/qa data
        if not p.get("qa_data") or p.get("qa_data") == "[]":
            return True
        if not p.get("clinical_relevance") or p.get("clinical_relevance") == 0:
            return True
        return False

    # Phase 1: lightweight metadata fetch (no abstract column) to find candidates.
    # The previous single-shot query that included abstract was hitting Cloudflare 522
    # because Supabase Free tier couldn't return ~400KB in time.
    metadata = []
    page_size = 100
    for page in range(10):
        chunk = sb_get("papers", {
            "select": "id,pmid,title,summary_ko,qa_data,clinical_relevance",
            "order": "fetched_at.desc",
            "limit": str(page_size),
            "offset": str(page * page_size),
        })
        if not chunk:
            break
        metadata.extend(chunk)
        if len(chunk) < page_size:
            break
        time.sleep(0.3)

    candidates = [p for p in metadata if needs_update(p)]
    print(f"=== {len(candidates)} of {len(metadata)} papers need summary ===")

    # Phase 2: fetch abstracts only for candidates, in small batches.
    abstract_map = {}
    batch = 20
    for i in range(0, len(candidates), batch):
        ids = [str(p["id"]) for p in candidates[i:i+batch]]
        rows = sb_get("papers", {
            "select": "id,abstract",
            "id": f"in.({','.join(ids)})",
        })
        for r in rows:
            abstract_map[r["id"]] = r.get("abstract") or ""
        time.sleep(0.2)

    papers = [{**p, "abstract": abstract_map.get(p["id"], "")} for p in candidates]
    papers = [p for p in papers if p.get("abstract")]
    print(f"=== Summarizing {len(papers)} papers (skipping {len(candidates) - len(papers)} without abstract) ===")

    done = 0
    failed = 0

    for i, p in enumerate(papers):
        if not p.get("abstract"):
            sb_patch(p["id"], {"summary_ko": ""})
            continue

        raw = summarize(p["title"], p["abstract"])
        if not raw:
            time.sleep(3)
            raw = summarize(p["title"], p["abstract"])
        if not raw:
            time.sleep(5)
            raw = summarize(p["title"], p["abstract"])

        if raw:
            # Parse JSON response
            patch_data = {}
            try:
                # Strip markdown code fences if present
                cleaned = raw.strip()
                if cleaned.startswith("```"):
                    cleaned = "\n".join(cleaned.split("\n")[1:])
                if cleaned.endswith("```"):
                    cleaned = cleaned[:-3]
                parsed = json.loads(cleaned.strip())
                patch_data["summary_ko"] = parsed.get("summary_ko", "")
                if parsed.get("structured"):
                    patch_data["structured_data"] = json.dumps(parsed["structured"], ensure_ascii=False)
                if parsed.get("clinical_relevance"):
                    patch_data["clinical_relevance"] = int(parsed["clinical_relevance"])
                if parsed.get("qa"):
                    patch_data["qa_data"] = json.dumps(parsed["qa"], ensure_ascii=False)
            except (json.JSONDecodeError, ValueError):
                # Fallback: treat as plain text summary
                patch_data["summary_ko"] = raw
                print(f"  [{i+1}/{len(papers)}] {p['pmid']}: JSON parse failed, saved as plain text")

            summary_ko = patch_data.get("summary_ko", "")
            lines = [l for l in summary_ko.strip().split('\n') if l.strip()]
            if len(lines) != 3 and summary_ko:
                print(f"  [{i+1}/{len(papers)}] {p['pmid']}: MALFORMED ({len(lines)} lines)")

            sb_patch(p["id"], patch_data)
            done += 1
            print(f"  [{i+1}/{len(papers)}] {p['pmid']}: OK (cr={patch_data.get('clinical_relevance','?')})")
        else:
            failed += 1
            print(f"  [{i+1}/{len(papers)}] {p['pmid']}: FAILED after 3 attempts")

        time.sleep(1)

    print(f"Done. Summarized {done}/{len(papers)}. Failed: {failed}")


if __name__ == "__main__":
    main()
