"""Repair historical keyword explanations without deleting recommendations or feedback."""
import os
import json
from common import get_json, paginate, strings, supabase_headers
from keywords import keyword_matches
import requests


def paper_matches(paper, term):
    normalized = term.strip().lower()
    metadata = strings(paper.get("keywords")) + strings(paper.get("mesh_terms"))
    return bool(normalized) and (
        keyword_matches(paper.get("title"), term) or keyword_matches(paper.get("abstract"), term)
        or any(value.strip().lower() == normalized for value in metadata))


def repair_reasons(paper, reasons):
    terms = [term for term in strings(reasons.get("matched_terms")) if paper_matches(paper, term)]
    study_label = (paper.get("study_type") or "").replace("_", " ").lower()
    def valid(item):
        label = item.get("label") if isinstance(item, dict) else None
        if not isinstance(label, str):
            return False
        label = label.strip()
        if label.startswith("Alert: ") and item.get("type") in {"keyword", "alert"}:
            value = label[7:].strip()
            if item.get("alert_type") in {"journal", "author"}:
                text = (paper.get("journal") or "") if item["alert_type"] == "journal" else " ".join(strings(paper.get("authors")))
                return bool(value) and value.lower() in text.lower()
            if item.get("alert_type") == "keyword":
                return keyword_matches(paper.get("title"), value) or keyword_matches(paper.get("abstract"), value)
            values = [paper.get("title"), paper.get("abstract"), paper.get("journal"), *strings(paper.get("authors"))]
            return any(keyword_matches(text, value) for text in values)
        return item.get("type") != "keyword" or label.lower() == study_label or paper_matches(paper, label)
    return {**reasons, "matched_terms": terms,
            "reasons": [item for item in reasons.get("reasons", []) if valid(item)]}


def main():
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_KEY required")
    headers = supabase_headers(key)
    rows = paginate(lambda path, params: get_json(f"{url}/rest/v1/{path}", headers=headers, params=params),
        "recommendations", {"select": "id,reasons,paper:papers(title,abstract,keywords,mesh_terms,study_type,authors,journal)", "order": "id"})
    changed = 0
    for row in rows:
        if not row.get("paper") or not isinstance(row.get("reasons"), dict):
            continue
        repaired = repair_reasons(row["paper"], row["reasons"])
        if repaired == row["reasons"]:
            continue
        # Optimistic check: leave a concurrently regenerated row intact.
        response = requests.patch(f"{url}/rest/v1/recommendations", headers={**headers, "Prefer": "return=representation"},
            params={"id": f"eq.{row['id']}", "reasons": "eq." + json.dumps(row["reasons"])},
            json={"reasons": repaired}, timeout=30)
        response.raise_for_status()
        changed += len(response.json())
    print(f"Keyword explanations: {changed} repaired, {len(rows)} checked; recommendation IDs and feedback preserved")


if __name__ == "__main__":
    main()
