"""Import a bounded batch of Europe PMC open-access articles into private storage."""
from datetime import datetime, timedelta, timezone
import os
import time
from urllib.error import HTTPError

import requests

from common import get_json, paginate, supabase_headers
from fulltext import FulltextUnavailable, fetch_oa, parse_document, publish


def select_candidates(papers, records, now, limit):
    recent = now - timedelta(days=7)
    skip = {r["paper_id"] for r in records if r["status"] == "ready"
            or datetime.fromisoformat(r["fetched_at"].replace("Z", "+00:00")) >= recent}
    return [p for p in papers if p["id"] not in skip][:limit]


def record_unavailable(url, headers, paper_id, reason):
    # Only refresh failed rows. A concurrent successful import must remain intact.
    data = {"status": "failed", "source": "europe_pmc_oa", "error": reason,
            "fetched_at": datetime.now(timezone.utc).isoformat()}
    response = requests.patch(f"{url}/rest/v1/paper_fulltexts", headers=headers,
        params={"paper_id": f"eq.{paper_id}", "status": "eq.failed"}, json=data, timeout=30)
    response.raise_for_status()
    response = requests.post(f"{url}/rest/v1/paper_fulltexts",
        headers={**headers, "Prefer": "resolution=ignore-duplicates,return=minimal"},
        params={"on_conflict": "paper_id"}, json={"paper_id": paper_id, **data}, timeout=30)
    response.raise_for_status()


def main():
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_KEY required")
    limit = int(os.environ.get("FULLTEXT_BATCH_SIZE") or "20")
    if not 1 <= limit <= 100:
        raise SystemExit("FULLTEXT_BATCH_SIZE must be between 1 and 100")
    headers = supabase_headers(key)
    now = datetime.now(timezone.utc)
    get = lambda path, params: get_json(f"{url}/rest/v1/{path}", headers=headers, params=params)
    papers = paginate(get, "papers", {"select": "id,pmid", "abstract": "neq.",
        "fetched_at": f"gte.{(now - timedelta(days=30)).isoformat()}", "order": "fetched_at.desc,id"}, size=100)
    records = paginate(get, "paper_fulltexts", {"select": "paper_id,status,fetched_at", "order": "paper_id"}, size=100)
    candidates = select_candidates(papers, records, now, limit)
    imported = unavailable = failed = 0
    for paper in candidates:
        try:
            content, source_url = fetch_oa(str(paper["pmid"]))
            parsed = parse_document(content)
            publish(str(paper["pmid"]), parsed, source_url, "europe_pmc_oa")
            imported += 1
        except FulltextUnavailable:
            record_unavailable(url, headers, paper["id"], "No Europe PMC open-access full text")
            unavailable += 1
        except HTTPError as error:
            if error.code in (404, 410):
                record_unavailable(url, headers, paper["id"], "Provider document not available")
                unavailable += 1
            else:
                failed += 1
        except ValueError:
            record_unavailable(url, headers, paper["id"], "Document did not pass parsing validation")
            unavailable += 1
        except (OSError, requests.RequestException):
            failed += 1
        time.sleep(0.5)
    print(f"Full texts: {imported} imported, {unavailable} unavailable, {failed} failed, {len(candidates)} attempted")
    if failed:
        raise SystemExit("Full-text provider or database requests failed; inspect provider availability")


if __name__ == "__main__":
    main()
