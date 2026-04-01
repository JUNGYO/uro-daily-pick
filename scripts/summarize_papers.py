"""
Uro Daily Pick - Korean Summary Generator
Uses Gemini 2.5 Flash to generate 3-line Korean summaries.
"""
import os
import time
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://vwdcqzcoovczmtzdyzbc.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"

PROMPT = """You are a medical research summarizer for urologists.
Given a paper's title and abstract, write a concise Korean summary in exactly 3 sentences.
- First sentence: study objective/background
- Second sentence: key methodology or findings
- Third sentence: clinical significance or conclusion

Rules:
- Write in Korean (한국어)
- Use medical terminology as-is (e.g., prostate, RCC, BCG)
- Be precise about numbers and statistics
- No markdown, no bullet points, just 3 plain sentences

Title: {title}
Abstract: {abstract}"""


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
    resp = requests.post(f"{GEMINI_URL}?key={GEMINI_API_KEY}",
        headers={"Content-Type": "application/json"},
        json={"contents": [{"role": "user", "parts": [{"text": prompt}]}],
              "generationConfig": {"maxOutputTokens": 300, "temperature": 0.3}},
        timeout=30)

    if resp.status_code == 429 or resp.status_code == 503:
        return None  # rate limited, retry later
    if resp.status_code != 200:
        return None
    try:
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError):
        return None


def main():
    if not SUPABASE_KEY or not GEMINI_API_KEY:
        print("ERROR: SUPABASE_SERVICE_KEY and GEMINI_API_KEY required")
        return

    # Get papers without Korean summary
    papers = sb_get("papers", {
        "select": "id,pmid,title,abstract,summary_ko",
        "or": "(summary_ko.eq.,summary_ko.is.null)",
        "order": "fetched_at.desc",
        "limit": "100",
    })

    print(f"=== Summarizing {len(papers)} papers ===")

    done = 0
    for i, p in enumerate(papers):
        if p.get("summary_ko"):
            continue
        if not p.get("abstract"):
            sb_patch(p["id"], {"summary_ko": ""})
            continue

        summary = summarize(p["title"], p["abstract"])
        if summary:
            sb_patch(p["id"], {"summary_ko": summary})
            done += 1
            print(f"  [{i+1}/{len(papers)}] {p['pmid']}: {summary[:60]}...")
        else:
            print(f"  [{i+1}/{len(papers)}] {p['pmid']}: FAILED (rate limit?)")

        time.sleep(4)  # ~15 RPM

    print(f"Done. Summarized {done}/{len(papers)}.")


if __name__ == "__main__":
    main()
