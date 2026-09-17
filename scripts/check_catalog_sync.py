"""Read-only synchronization heartbeat monitor, without catalog aggregate scans."""
from datetime import datetime
import os

import requests

from common import get_json, supabase_headers


COUNTS = ("local_papers", "synced_papers", "citation_pending", "local_originals",
          "local_summaries", "pending_originals", "pending_summaries")
STATES = {"idle", "syncing", "capacity_blocked", "offline", "error"}


def validate_health(status):
    """Fail closed on missing, stale or invalid reports; never infer data progress."""
    if not isinstance(status, dict) or type(status.get("available")) is not bool:
        raise ValueError("Invalid synchronization health response")
    if not status["available"]:
        raise ValueError("Local synchronization report is unavailable; inspect the scheduled task")
    for field in ("report_stale", "sync_stale"):
        if type(status.get(field)) is not bool:
            raise ValueError("Invalid synchronization freshness response")
    if status["report_stale"]:
        raise ValueError("Local synchronization report is stale; inspect the scheduled task")
    if status["sync_stale"]:
        raise ValueError("Last successful synchronization cycle is missing or stale")
    for field in ("reported_at", "last_sync_at"):
        try:
            stamp = datetime.fromisoformat(status[field].replace("Z", "+00:00"))
            if stamp.utcoffset() is None:
                raise ValueError
        except (AttributeError, KeyError, TypeError, ValueError):
            raise ValueError("Invalid synchronization timestamp") from None
    for field in COUNTS:
        if type(status.get(field)) is not int or not 0 <= status[field] <= 1_000_000_000:
            raise ValueError("Invalid synchronization counts")
    if (status["synced_papers"] + status["citation_pending"] != status["local_papers"]
            or status["pending_originals"] > status["local_originals"]
            or status["pending_summaries"] > status["local_papers"]
            or status["local_originals"] > status["local_papers"]
            or status["local_summaries"] > status["local_papers"]):
        raise ValueError("Inconsistent synchronization counts")
    registry = status.get("registry_version")
    if not isinstance(registry, str) or not 1 <= len(registry) <= 100:
        raise ValueError("Invalid synchronization registry")
    state = status.get("sync_state")
    if not isinstance(state, str) or state not in STATES:
        raise ValueError("Unknown synchronization state")
    if state in {"offline", "error"}:
        raise ValueError("Catalog synchronization needs attention; local committed data is retained")
    return status


def main():
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not base or not key:
        raise SystemExit("Catalog synchronization health failed: SUPABASE_URL and SUPABASE_SERVICE_KEY are required")
    try:
        status = get_json(base + "/rest/v1/rpc/catalog_sync_health",
                          headers=supabase_headers(key), params={})
    except (requests.RequestException, ValueError):
        # Request exceptions can contain URLs, credentials or response bodies.
        # Preserve a failed exit without printing the exception or a traceback.
        raise SystemExit("Catalog synchronization health failed: cloud API request failed; "
                         "service health is unknown. Local files were not changed.") from None
    try:
        local = validate_health(status)
    except ValueError as error:
        # All validator messages are fixed local strings, never remote values.
        raise SystemExit("Catalog synchronization health failed: " + str(error)) from None
    print("Local citations:", local["local_papers"],
          "Current revisions synchronized:", local["synced_papers"],
          "Citation synchronization pending:", local["citation_pending"])
    print("Last successful synchronization cycle:", local["last_sync_at"])
    if local["sync_state"] == "capacity_blocked":
        print("::warning::Service storage budget reached. Local collection is independent; uploads remain queued.")


if __name__ == "__main__":
    main()
