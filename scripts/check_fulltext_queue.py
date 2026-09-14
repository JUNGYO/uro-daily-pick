"""Cloud queue health: read metadata only; full texts and inference stay on Z8/Spark."""
from datetime import datetime, timezone
import os
from common import get_json, supabase_headers


def assess(status, now):
    workers=status.get("workers") or []
    if not workers:
        raise ValueError("No institution worker is registered")
    times=[datetime.fromisoformat(w["last_seen_at"].replace("Z","+00:00")) for w in workers if w.get("last_seen_at")]
    if not times:
        raise ValueError("Registered institution worker has never connected")
    hours=(now-max(times)).total_seconds()/3600
    if hours>24:
        raise ValueError("Z8 has not connected for more than 24 hours; inspect its scheduled task and Spark tunnel")
    warnings=["Z8 is offline or awaiting its next run; saved summaries remain available"] if hours>2 else []
    if any(w.get("state")=="error" for w in workers):
        warnings.append("Z8 reported an execution error; inspect worker.log and Spark availability")
    return warnings


def main():
    url,key=os.environ.get("SUPABASE_URL"),os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_KEY required")
    status=get_json(url+"/rest/v1/rpc/fulltext_queue_status",headers=supabase_headers(key))
    try:
        warnings=assess(status,datetime.now(timezone.utc))
    except ValueError as error:
        raise SystemExit(str(error)) from None
    for warning in warnings: print("::warning::"+warning)
    print(f"Z8 bodies: {status.get('local_bodies',0)}; ready summaries: {status.get('ready_summaries',0)}; "
          f"cloud bodies awaiting verified archival: {status.get('cloud_bodies',0)}")
    print("Per-article queue states:",status.get("attempts",{}))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"],"a",encoding="utf-8") as output:
            output.write(f"Z8/Spark queue: {status.get('ready_summaries',0)} ready summaries; "
                         f"{status.get('local_bodies',0)} bodies stored on Z8.\n\n")
            output.write("Unavailable articles remain queued; they do not invalidate completed summaries.\n")


if __name__ == "__main__":
    main()
