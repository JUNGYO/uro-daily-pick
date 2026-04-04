"""
Uro Daily Pick - Korean Summary Generator
Uses Gemini 2.5 Pro to generate 3-line Korean summaries.
"""
import os
import time
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"

PROMPT = """You are a medical research summarizer for Korean urologists.

TASK: Summarize the following paper in Korean. Write EXACTLY 3 sentences, each on its own line.

Sentence 1: 연구 배경과 목적 (Background and objective)
Sentence 2: 주요 방법론과 결과 (Key methods and findings — include specific numbers/statistics)
Sentence 3: 임상적 의의와 결론 (Clinical significance and conclusion)

RULES:
- Write everything in Korean (한국어)
- Keep medical terms in English where natural (e.g., prostate, RCC, BCG, PSA, PFS, OS)
- Include specific numbers from the abstract (e.g., HR 0.72, p=0.003, 5-year OS 85%)
- Write 3 full sentences, each 30-60 characters long
- No bullet points, no numbering, just 3 plain sentences separated by newlines

Title: {title}

Abstract: {abstract}

Korean 3-sentence summary:"""


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

    # Get papers with abstract but without Korean summary (or needing re-summarize)
    papers = sb_get("papers", {
        "select": "id,pmid,title,abstract,summary_ko",
        "abstract": "neq.",
        "order": "fetched_at.desc",
        "limit": "200",
    })

    done = 0
    failed = 0
    def needs_summary(s):
        """Check if summary is missing or truncated (< 3 lines)."""
        if not s:
            return True
        lines = [l for l in s.strip().split('\n') if l.strip()]
        return len(lines) < 3

    papers = [p for p in papers if needs_summary(p.get("summary_ko"))]
    print(f"=== Summarizing {len(papers)} papers ===")

    for i, p in enumerate(papers):
        if not p.get("abstract"):
            sb_patch(p["id"], {"summary_ko": ""})
            continue

        summary = summarize(p["title"], p["abstract"])
        if not summary:
            time.sleep(3)
            summary = summarize(p["title"], p["abstract"])  # retry once
        if not summary:
            time.sleep(5)
            summary = summarize(p["title"], p["abstract"])  # retry twice

        if summary:
            lines = [l for l in summary.strip().split('\n') if l.strip()]
            if len(lines) != 3:
                print(f"  [{i+1}/{len(papers)}] {p['pmid']}: MALFORMED ({len(lines)} lines, expected 3)")
            sb_patch(p["id"], {"summary_ko": summary})
            done += 1
            print(f"  [{i+1}/{len(papers)}] {p['pmid']}: {summary[:60]}...")
        else:
            failed += 1
            print(f"  [{i+1}/{len(papers)}] {p['pmid']}: FAILED after 3 attempts")

        time.sleep(1)

    print(f"Done. Summarized {done}/{len(papers)}. Failed: {failed}")


if __name__ == "__main__":
    main()
