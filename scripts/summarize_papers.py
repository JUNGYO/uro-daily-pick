"""
Uro Daily Pick - Korean Summary Generator
Uses Gemini 2.5 Pro to generate 3-line Korean summaries.
"""
import os
import json
import time
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"

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


def sb_get(path, params):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    return requests.get(url, headers=headers, params=params, timeout=30).json()


def sb_patch(paper_id, data):
    url = f"{SUPABASE_URL}/rest/v1/papers?id=eq.{paper_id}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
               "Content-Type": "application/json", "Prefer": "return=minimal"}
    return requests.patch(url, headers=headers, json=data, timeout=30)


def summarize(title, abstract):
    prompt = PROMPT.format(title=title or "Untitled", abstract=(abstract or "No abstract.")[:3000])
    try:
        resp = requests.post(f"{GEMINI_URL}?key={GEMINI_API_KEY}",
            headers={"Content-Type": "application/json"},
            json={"contents": [{"role": "user", "parts": [{"text": prompt}]}],
                  "generationConfig": {"maxOutputTokens": 8192, "temperature": 0.5},
                  "thinkingConfig": {"thinkingBudget": 0}},
            timeout=120)
    except requests.exceptions.RequestException:
        return None

    if resp.status_code == 429 or resp.status_code == 503:
        return None  # rate limited, retry later
    if resp.status_code != 200:
        return None
    try:
        parts = resp.json()["candidates"][0]["content"]["parts"]
        # 2.5 Pro may have thinking part first, then text part
        for part in reversed(parts):
            if "text" in part and part.get("thought") is not True:
                return part["text"].strip()
        # Fallback: last part with text
        for part in reversed(parts):
            if "text" in part:
                return part["text"].strip()
        return None
    except (KeyError, IndexError):
        return None


def main():
    if not SUPABASE_KEY or not GEMINI_API_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY and GEMINI_API_KEY required")
        return

    # Get papers with abstract — re-summarize if missing qa_data or summary
    papers = sb_get("papers", {
        "select": "id,pmid,title,abstract,summary_ko,qa_data,clinical_relevance",
        "abstract": "neq.",
        "order": "fetched_at.desc",
        "limit": "200",
    })

    done = 0
    failed = 0
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

    papers = [p for p in papers if needs_update(p)]
    print(f"=== Summarizing {len(papers)} papers ===")

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
