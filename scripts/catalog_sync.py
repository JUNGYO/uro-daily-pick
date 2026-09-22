"""Independently synchronize local citation revisions and derived events.

No original bytes are read here. Acknowledgements apply only to the revision sent;
an interrupted upload is replayed against PMID-idempotent database functions.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import time

from catalog_policy import AUTOMATIC_START_DATE
from journal_registry import REGISTRY_VERSION
from local_catalog import LocalCatalog, CITATION_FIELDS

CAPACITY_RETRY_SECONDS = 600


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def worker_rpc(service, name, **values):
    if name not in {"sync_institution_catalog", "report_institution_catalog", "sync_institution_events"}:
        raise ValueError("Unsupported catalog RPC")
    return service.request("rpc/" + name,
        {"p_worker_id": service.config["id"], "p_token": service.token, **values})


def import_cloud_page(catalog, service, limit=250):
    """Seed existing citations durably; the cursor follows the committed page."""
    cursor = int(catalog.get_meta("cloud_import_cursor", 0))
    fields = sorted(set(CITATION_FIELDS) | {"id", "fulltext_available", "summary_basis",
        "summary_source_hash", "summarized_at", "summary_model", "summary_ko", "structured_data", "qa_data"})
    rows = service.request("papers", params={"select": ",".join(fields),
        "pub_date": "gte." + AUTOMATIC_START_DATE, "id": "gt." + str(cursor),
        "order": "id.asc", "limit": limit})
    if not isinstance(rows, list) or len(rows) > limit:
        raise ValueError("Invalid cloud catalog page")
    previous = cursor
    for row in rows:
        if not isinstance(row, dict) or type(row.get("id")) is not int or row["id"] <= previous:
            raise ValueError("Cloud catalog cursor did not advance")
        previous = row["id"]
    if rows:
        catalog.upsert_papers(rows, synced=True)
        observe_existing_documents(catalog, rows)
        catalog.set_meta("cloud_import_cursor", previous)
    catalog.set_meta("cloud_import_caught_up", len(rows) < limit)
    return len(rows)


def observe_existing_documents(catalog, imported):
    """Index verified legacy files without confusing cloud flags with local files."""
    from institution_worker import cached_paper_matches, verify_cached_body
    from local_summary import MODEL_LABEL, validate_cached_summary
    for paper in catalog.get_papers([row["pmid"] for row in imported]):
        try:
            document = None
            for folder in ("documents", "cloud-archive"):
                path = catalog.directory / folder / (paper["pmid"] + ".json")
                if not path.is_file():
                    continue
                saved = json.loads(path.read_text(encoding="utf-8"))
                identity = saved["paper"] if folder == "cloud-archive" else saved
                if cached_paper_matches(identity, paper):
                    document = verify_cached_body(saved["document"])
                    break
            if document is None:
                continue
            source_hash = hashlib.sha256(("fulltext\n" + paper["title"] + "\n" + document["content_text"]).encode()).hexdigest()
            if (not paper.get("fulltext_available")
                    or paper.get("acquired_source_hash") not in (None, source_hash)
                    or paper.get("summary_source_hash") not in (None, source_hash)):
                from local_service import LocalService
                LocalService(catalog.directory, catalog=catalog).register_original(paper, document)
            if not catalog.observe_local_source(paper["pmid"], source_hash,
                    expected_title=paper["title"], expected_doi=paper.get("doi")):
                continue
            summary_path = catalog.directory / "documents" / (paper["pmid"] + ".summary.json")
            if (paper.get("summary_source_hash") == source_hash and paper.get("summary_model") == MODEL_LABEL
                    and summary_path.is_file()):
                validated = validate_cached_summary(json.loads(summary_path.read_text(encoding="utf-8")), paper, document)
                catalog.observe_local_summary(paper["pmid"], validated,
                    expected_title=paper["title"], expected_doi=paper.get("doi"))
        except (OSError, ValueError, KeyError, TypeError):
            # Keep malformed/stale files for diagnosis; normal queues revalidate.
            continue


def capacity_cooldown_active(catalog):
    retry_at = catalog.get_meta("capacity_retry_at", 0)
    now = time.time()
    # A corrupt checkpoint or a clock adjustment must not defer work indefinitely.
    return type(retry_at) in (int, float) and now < retry_at <= now + CAPACITY_RETRY_SECONDS


def sync_citations(catalog, service, limit=50, *, batch=None):
    batch = catalog.pending_citations(limit=limit) if batch is None else batch
    if not batch:
        return {"accepted": 0, "capacity_blocked": False}
    known_ids = {paper["pmid"] for paper in catalog.get_papers(
        [item["paper"]["pmid"] for item in batch]) if type(paper.get("id")) is int and paper["id"] > 0}
    if capacity_cooldown_active(catalog):
        # pending_citations prioritizes cloud identities, so filtering this
        # bounded batch cannot leave an eligible existing update behind new rows.
        batch = [item for item in batch if item["paper"]["pmid"] in known_ids]
        if not batch:
            return {"accepted": 0, "capacity_blocked": True}
    new_pmids = {item["paper"]["pmid"] for item in batch} - known_ids
    try:
        result = worker_rpc(service, "sync_institution_catalog", p_papers=[item["paper"] for item in batch])
    except RuntimeError as error:
        if str(error) not in {"Service HTTP 400", "Service HTTP 409", "Service HTTP 422"}:
            raise
        if len(batch) == 1:
            item = batch[0]
            catalog.defer_citation(item["paper"]["pmid"], item["version"], time.time() + 86400, "metadata_rejected")
            return {"accepted": 0, "capacity_blocked": False}
        # Retain exceptional source records locally without stalling unrelated
        # valid citations or already-generated summary publications behind them.
        middle = len(batch) // 2
        first = sync_citations(catalog, service, batch=batch[:middle])
        second = sync_citations(catalog, service, batch=batch[middle:])
        return {"accepted": first["accepted"] + second["accepted"],
                "capacity_blocked": first["capacity_blocked"] or second["capacity_blocked"]}
    if (not isinstance(result, dict) or type(result.get("capacity_blocked")) is not bool
            or not isinstance(result.get("accepted"), list)):
        raise ValueError("Invalid catalog acknowledgement")
    sent = {str(item["paper"]["pmid"]): item for item in batch}
    accepted = set()
    for receipt in result["accepted"]:
        pmid = str(receipt.get("pmid", "")) if isinstance(receipt, dict) else ""
        if pmid not in sent or pmid in accepted or type(receipt.get("id")) is not int or receipt["id"] < 1:
            raise ValueError("Catalog acknowledgement does not match the sent batch")
        accepted.add(pmid)
    # Validate the entire acknowledgement before committing any sent revision.
    for receipt in result["accepted"]:
        item = sent[str(receipt["pmid"])]
        catalog.ack_citation(str(receipt["pmid"]), item["version"], receipt["id"])
    if result["capacity_blocked"]:
        catalog.set_meta("capacity_retry_at", time.time() + CAPACITY_RETRY_SECONDS)
    elif new_pmids and new_pmids <= accepted:
        # Existing-record updates can succeed while new admission remains paused.
        catalog.set_meta("capacity_retry_at", None)
    return {"accepted": len(accepted), "capacity_blocked": result["capacity_blocked"]}


def reject_summary(directory, catalog, event):
    if not catalog.invalidate_summary(event["pmid"], event["version"]):
        return
    from summary_queue import prepare_summary_attempts, record_summary_attempt
    with sqlite3.connect(Path(directory) / "queue.sqlite3", timeout=20) as db:
        prepare_summary_attempts(db)
        source_hash = event["payload"].get("p_summary", {}).get("summary_source_hash", "")
        record_summary_attempt(db, event["pmid"], source_hash, "publication_rejected", time.time())


def publish_events(directory, catalog, service, events):
    from local_catalog import _publication
    for event in events:
        _publication(event['kind'], event['payload'])
    receipts = worker_rpc(service, 'sync_institution_events', p_events=events)
    sent = {(e['pmid'], e['kind'], e['version']): e for e in events}
    seen = set()
    if not isinstance(receipts, list) or len(receipts) != len(events):
        raise ValueError('Incomplete publication acknowledgement')
    for receipt in receipts:
        if (not isinstance(receipt, dict) or set(receipt) != {'pmid', 'kind', 'version', 'status'}
                or type(receipt['version']) is not int or receipt['status'] not in {'accepted', 'rejected'}):
            raise ValueError('Invalid publication acknowledgement')
        identity = (receipt['pmid'], receipt['kind'], receipt['version'])
        if identity not in sent or identity in seen:
            raise ValueError('Publication acknowledgement does not match sent revision')
        seen.add(identity)
    completed = 0
    for receipt in receipts:
        event = sent[(receipt['pmid'], receipt['kind'], receipt['version'])]
        if receipt['status'] == 'accepted':
            completed += int(catalog.ack_outbox(event['pmid'], event['kind'], event['version']))
        else:
            if event['kind'] == 'summary':
                reject_summary(directory, catalog, event)
            catalog.defer_outbox(event['pmid'], event['kind'], event['version'],
                time.time() + 3600, 'publication_rejected')
    return completed


def sync_events(directory, catalog, service, deadline, limit=50):
    completed = 0
    batch = []
    for event in catalog.ready_outbox_batch(limit=limit):
        if time.monotonic() >= deadline:
            break
        if not catalog.citation_is_synced(event["pmid"]):
            catalog.defer_outbox(event["pmid"], event["kind"], event["version"],
                time.time() + 120, "citation_pending")
            continue
        if event["kind"] not in {"original", "summary"}:
            raise ValueError("Unknown derived outbox event")
        papers = catalog.get_papers([event["pmid"]])
        payload = event["payload"]
        if (not papers or payload["p_title"] != papers[0]["title"]
                or (payload.get("p_doi") or "").lower() != (papers[0].get("doi") or "").lower()):
            catalog.defer_outbox(event["pmid"], event["kind"], event["version"],
                time.time() + 3600, "citation_changed")
            continue
        staged_hash = (payload["p_source"].get("summary_source_hash") if event["kind"] == "original"
                       else payload["p_summary"].get("summary_source_hash"))
        if papers[0].get("acquired_source_hash") and papers[0]["acquired_source_hash"] != staged_hash:
            catalog.defer_outbox(event["pmid"], event["kind"], event["version"],
                time.time() + 3600, "source_changed")
            continue
        if event["kind"] == "summary" and catalog.has_pending_event(event["pmid"], "original"):
            catalog.defer_outbox(event["pmid"], event["kind"], event["version"],
                time.time() + 60, "original_pending")
            continue
        batch.append(event)
        if len(batch) >= 10:
            completed += publish_events(directory, catalog, service, batch)
            batch = []
    if batch and time.monotonic() < deadline:
        completed += publish_events(directory, catalog, service, batch)
    return completed


def report(catalog, service, state, *, sync_at=None):
    names = ("local_papers", "synced_papers", "citation_pending", "local_originals",
             "local_summaries", "pending_originals", "pending_summaries")
    stats = catalog.stats()
    status = {name: int(stats[name]) for name in names}
    status.update(sync_state=state, last_sync_at=sync_at or catalog.get_meta("last_sync_at"),
                  registry_version=REGISTRY_VERSION)
    heartbeat = catalog.get_meta("worker_status", {})
    service.status(heartbeat.get("state", "running"))
    worker_rpc(service, "report_institution_catalog", p_status=status)
    return status


def failure_details(error, stage):
    """Use an allowlist, never the exception message or a request's contents."""
    stages = {"initialization", "catalog_import", "citation_sync", "derived_sync", "status_report"}
    stage = stage if stage in stages else "initialization"
    categories = {"http", "timeout", "tls", "network"}
    category = getattr(error, "category", None)
    if not isinstance(category, str) or category not in categories:
        category = ("timeout" if isinstance(error, TimeoutError) else
                    "storage" if isinstance(error, sqlite3.Error) else
                    "invalid_response" if isinstance(error, (ValueError, KeyError, TypeError)) else
                    "os_error" if isinstance(error, OSError) else "service")
    detail = {"stage": stage, "category": category, "at": timestamp()}
    status = getattr(error, "http_status", None)
    if type(status) is int and 100 <= status <= 599:
        detail["http_status"] = status
    return detail


def run_sync(directory, deadline, *, service=None, catalog=None, sleep=time.sleep):
    """Return completed cycles; cloud failures stay inside this independent phase."""
    own_catalog = catalog is None
    catalog = catalog or LocalCatalog(directory)
    completed_cycles = 0
    next_import = next_report = 0
    reported_state = None
    try:
        while time.monotonic() < deadline:
            stage = "initialization"
            try:
                if service is None:
                    from institution_worker import Service
                    service = Service(Path(directory))
                service.sync_deadline = deadline
                # Bounded seeding leaves room for uploads and progress reporting.
                stage = "catalog_import"
                imported = 0
                for _ in range(2 if time.monotonic() >= next_import else 0):
                    if time.monotonic() >= deadline:
                        break
                    count = import_cloud_page(catalog, service)
                    imported += count
                    if count < 250:
                        next_import = time.monotonic() + 60
                        break
                accepted = 0
                # Keep the capacity state visible during admission cooldown while
                # allowing all normal batches of existing updates to continue.
                blocked = capacity_cooldown_active(catalog)
                stage = "citation_sync"
                for _ in range(2):
                    if time.monotonic() >= deadline:
                        break
                    result = sync_citations(catalog, service)
                    accepted += result["accepted"]
                    blocked = blocked or result["capacity_blocked"]
                    if result["capacity_blocked"] or not result["accepted"]:
                        break
                stage = "derived_sync"
                events = sync_events(directory, catalog, service, deadline)
                active = bool(imported or accepted or events)
                state = "capacity_blocked" if blocked else "syncing" if active else "idle"
                stage = "status_report"
                synced_at = timestamp()
                if time.monotonic() >= next_report or state != reported_state:
                    status = report(catalog, service, state, sync_at=synced_at)
                    next_report = time.monotonic() + 30
                    reported_state = state
                else:
                    status = None
                # A failed report must not make an offline worker look recently
                # synchronized. Publication acknowledgements remain durable.
                if status is not None:
                    catalog.set_meta("last_sync_at", synced_at)
                catalog.set_meta("sync_state", state)
                catalog.set_meta("sync_error", None)
                completed_cycles += 1
                print(f"Catalog sync: {imported} mirrored, {accepted} citation acknowledgements, "
                      f"{events} derived acknowledgements; {state}", flush=True)
                # Drain available work continuously; idle wake-up checks are local.
                pause = 0.1 if active else 2
            except (OSError, RuntimeError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
                reported_state = None
                detail = failure_details(error, stage)
                catalog.set_meta("sync_state", "offline")
                catalog.set_meta("sync_error", detail)
                print(f"Catalog sync deferred: {json.dumps(detail, sort_keys=True)}; committed local data retained", flush=True)
                pause = 60
            remaining = deadline - time.monotonic()
            if remaining > 0:
                sleep(min(pause, remaining))
        return completed_cycles
    finally:
        if own_catalog:
            catalog.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--max-seconds", type=int, default=3300)
    args = parser.parse_args()
    if not 60 <= args.max_seconds <= 3600:
        parser.error("Runtime must be 60..3600 seconds")
    from local_catalog_worker import phase_lock
    with phase_lock(args.state_dir, "catalog-sync") as acquired:
        if acquired:
            completed = run_sync(args.state_dir, time.monotonic() + args.max_seconds)
            if not completed:
                print("Catalog sync failed: no cycle completed; committed local data retained", flush=True)
                return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
