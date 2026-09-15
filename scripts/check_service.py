"""Read-only deployment preflight: database contracts and pipeline freshness. No sends or writes."""
import argparse
from datetime import datetime, timezone
import os
import requests
from common import supabase_headers


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-age-hours", type=int, default=48)
    args = parser.parse_args()
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_KEY required")
    headers = {**supabase_headers(key)}
    try:
        response = requests.get(f"{url}/rest/v1/", headers={**headers,"Accept":"application/openapi+json"}, timeout=30)
        response.raise_for_status()
        paths = response.json().get("paths", {})
        required = ["/rpc/set_paper_feedback", "/rpc/delete_own_account", "/rpc/replace_daily_recommendations",
                    "/rpc/fulltext_queue_status", "/rpc/publish_institution_summary", "/rpc/catalog_backfill_status", "/email_deliveries",
                    "/rpc/search_papers", "/rpc/reader_paper", "/rpc/reader_daily", "/rpc/update_reader_state", "/rpc/preview_papers",
                    "/rpc/search_notifications", "/rpc/project_papers", "/rpc/project_members", "/rpc/admin_integrity_review", "/rpc/admin_summary_issues"]
        missing = [path for path in required if path not in paths]
        if missing:
            raise SystemExit("Missing database contracts: " + ", ".join(missing))
        response = requests.get(f"{url}/rest/v1/papers", headers=headers, params={
            "select":"fetched_at,summary_basis,summary_model,fulltext_storage", "order":"fetched_at.desc", "limit":"1"}, timeout=30)
        response.raise_for_status()
        rows = response.json()
        if not rows:
            raise SystemExit("Paper catalog is empty; run the fetch pipeline")
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(rows[0]["fetched_at"].replace("Z", "+00:00"))).total_seconds()/3600
        if age > args.max_age_hours:
            raise SystemExit(f"Latest paper is {age:.1f} hours old; inspect scheduled fetch logs")
        print(f"Database contracts present. Latest fetched paper: {age:.1f} hours ago.")
        print("Auth redirects, sender verification, backups, and real delivery require staging validation.")
    except (requests.RequestException, ValueError, KeyError) as error:
        raise SystemExit(f"Preflight failed: {type(error).__name__}. No changes were made.") from None


if __name__ == "__main__":
    main()
