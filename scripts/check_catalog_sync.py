"""Read-only cloud monitor; citation discovery is owned by the local controller."""
import os
from common import get_json, supabase_headers


def main():
    base = os.environ["SUPABASE_URL"].rstrip("/")
    status = get_json(base + "/rest/v1/rpc/catalog_backfill_status",
        headers=supabase_headers(os.environ["SUPABASE_SERVICE_KEY"]), params={})
    local = status.get("local_catalog") or {}
    if not local.get("available") or local.get("stale"):
        raise RuntimeError("Local catalog heartbeat is unavailable or stale; inspect the local scheduled task")
    print("Local citations:", local.get("local_papers", 0),
          "Service-synchronized:", local.get("synced_papers", 0),
          "Citation synchronization pending:", local.get("citation_pending", 0))
    if local.get("sync_state") == "capacity_blocked":
        print("::warning::Service storage budget reached. Local collection is independent; uploads remain queued.")
    elif local.get("sync_state") in {"offline", "error"}:
        raise RuntimeError("Catalog synchronization needs attention; local committed data is retained")


if __name__ == "__main__":
    main()
