"""Fair, resumable first-summary and refresh scheduling over verified local originals."""
import hashlib
import json
from pathlib import Path
import re
import time
import uuid

PUBLICATION_RESERVE_SECONDS = 15
MINIMUM_INFERENCE_SECONDS = 3


class SummaryPublicationRejected(ValueError):
    """The server rejected this publication; cached final drafts need revalidation."""


def _dependencies(overrides):
    import institution_worker as worker
    import local_summary
    deps = {name: getattr(worker, name) for name in (
        "cached_paper_matches", "verify_cached_body", "save_json", "atomic_replace",
        "generate_summary", "summary_payload", "literature_inference_scope",
        "SummaryPublicationRejected", "SummaryBudgetExpired")}
    deps.update(validate_cached_summary=getattr(local_summary, "validate_cached_summary", None),
                clock=time.monotonic, wall_clock=time.time)
    deps.update(overrides or {})
    if not callable(deps["validate_cached_summary"]):
        raise RuntimeError("Summary cache validation is unavailable")
    return deps


def prepare_summary_attempts(db):
    with db:
        db.execute("CREATE TABLE IF NOT EXISTS attempts(pmid TEXT PRIMARY KEY,status TEXT,next_retry REAL)")
        db.execute("""CREATE TABLE IF NOT EXISTS summary_retry_metadata(
            pmid TEXT PRIMARY KEY, source_hash TEXT NOT NULL, reason TEXT NOT NULL,
            consecutive_failures INTEGER NOT NULL, attempted_at REAL NOT NULL)""")


def record_summary_attempt(db, pmid, source_hash, reason, now):
    """Keep source-specific failure backoff separate from collection attempts."""
    with db:
        previous = db.execute("SELECT source_hash,reason,consecutive_failures FROM summary_retry_metadata WHERE pmid=?", [pmid]).fetchone()
        failures = 0
        retry_at = 0
        if reason == "budget_yield":
            retry_at = now + 60
        elif reason != "ready":
            same = previous and previous[0] == source_hash and previous[1] == reason
            failures = previous[2] + 1 if same else 1
            retry_at = now + (900, 3600, 21600, 86400)[min(failures, 4) - 1]
        db.execute("INSERT OR REPLACE INTO attempts VALUES(?,?,?)",
                   (pmid, "ready" if reason == "ready" else "retryable_error", retry_at))
        db.execute("INSERT OR REPLACE INTO summary_retry_metadata VALUES(?,?,?,?,?)",
                   (pmid, source_hash, reason, failures, now))
    return retry_at


def _cloud_ready(paper, source_hash=None):
    lines = [line for line in str(paper.get("summary_ko") or "").splitlines() if line.strip()]
    return (paper.get("fulltext_available") is True and paper.get("summary_basis") == "fulltext"
            and bool(re.fullmatch(r"[0-9a-f]{64}", str(paper.get("summary_source_hash") or "")))
            and (source_hash is None or paper["summary_source_hash"] == source_hash)
            and bool(paper.get("summarized_at")) and bool(paper.get("summary_model")) and len(lines) == 3)


def _validation_label(error):
    # Extract only fixed claim names, never an exception's article text or model output.
    claims = sorted(set(re.findall(r"\b(?:summary_[123]|qa_[123]|study_design|sample_size|key_finding|population|"
                                   r"intervention|comparator|follow_up|outcome|limitations)\b", str(error))))
    return "claims " + ",".join(claims) if claims else type(error).__name__


def _quarantine(path, deps):
    if path.exists():
        target = path.with_name(path.name + ".rejected-" + uuid.uuid4().hex)
        deps["atomic_replace"](path, target)


def _quarantine_drafts(final_path, draft_path, deps):
    try:
        _quarantine(final_path, deps)
        _quarantine(draft_path, deps)
        return True
    except OSError:
        # Keep the rejection marker until both files can be moved. Never replay them.
        return False


def _original(directory, paper, deps):
    pmid = str(paper["pmid"])
    for path, archive in ((directory / "documents" / (pmid + ".json"), False),
                          (directory / "cloud-archive" / (pmid + ".json"), True)):
        if not path.exists():
            continue
        saved = json.loads(path.read_text(encoding="utf-8"))
        if deps["cached_paper_matches"](saved["paper"] if archive else saved, paper):
            return deps["verify_cached_body"](saved["document"])
    return None


def run_summary_queue(directory, deadline, service, db, papers, *, dependencies=None, per_paper_seconds=420):
    deps = _dependencies(dependencies)
    directory = Path(directory)
    spool = directory / "documents"
    spool.mkdir(exist_ok=True)
    prepare_summary_attempts(db)
    per_paper_seconds = min(420, max(30, per_paper_seconds))
    counts = dict(completed=0, first_completed=0, updated=0, failed=0, yielded=0, deferred=0)
    metadata = {row[0]: row[1:] for row in db.execute("SELECT pmid,source_hash,reason,consecutive_failures,attempted_at FROM summary_retry_metadata")}
    local_pmids = {path.stem for folder in (spool, directory / "cloud-archive")
                   for path in folder.glob("*.json") if re.fullmatch(r"\d{1,12}", path.stem)}
    # Publication recency is the tie-breaker within a first/refresh and attempt tier.
    ordered = sorted(papers, key=lambda paper: str(paper.get("pub_date") or ""), reverse=True)
    ordered.sort(key=lambda paper: (_cloud_ready(paper), metadata.get(str(paper.get("pmid")), (None, None, None, 0))[3]))
    print(f"Summary queue: first summaries before refreshes; per-paper budget {per_paper_seconds}s", flush=True)
    seen = set()
    old_service_deadline = getattr(service, "summary_deadline", None)

    def record(pmid, source_hash, reason):
        record_summary_attempt(db, pmid, source_hash, reason, deps["wall_clock"]())

    def report_failure(pmid):
        if deps["clock"]() >= service.summary_deadline - 1:
            return
        try:
            service.status("running", pmid, "retryable_error")
        except (OSError, RuntimeError, ValueError):
            pass  # Local retry state already commits; a status outage cannot discard it.

    try:
        for paper in ordered:
            if deps["clock"]() >= deadline - PUBLICATION_RESERVE_SECONDS - MINIMUM_INFERENCE_SECONDS:
                break
            pmid = str(paper.get("pmid", ""))
            if pmid not in local_pmids or pmid in seen:
                continue
            seen.add(pmid)
            source_hash = ""
            operation = "original"
            final_path = spool / (pmid + ".summary.json")
            notes_path = spool / (pmid + ".notes.json")
            draft_path = notes_path.with_suffix(".draft.json")
            paper_deadline = min(deadline, deps["clock"]() + per_paper_seconds)
            service.summary_deadline = paper_deadline
            try:
                prior = db.execute("SELECT status,next_retry FROM attempts WHERE pmid=?", [pmid]).fetchone()
                previous = metadata.get(pmid)
                if prior and prior[1] > deps["wall_clock"]() and (previous is None or not previous[0]):
                    counts["deferred"] += 1
                    continue
                document = _original(directory, paper, deps)
                if document is None:
                    counts["deferred"] += 1
                    continue
                source_hash = hashlib.sha256(("fulltext\n" + paper["title"] + "\n" + document["content_text"]).encode()).hexdigest()
                if prior and prior[1] > deps["wall_clock"]() and (previous is None or previous[0] == source_hash):
                    counts["deferred"] += 1
                    continue
                # Reserve time for persistence and a bounded publication request.
                inference_deadline = paper_deadline - PUBLICATION_RESERVE_SECONDS
                operation = "summary"
                summary = None
                if previous and previous[1] == "publication_rejected":
                    if not _quarantine_drafts(final_path, draft_path, deps):
                        raise deps["SummaryPublicationRejected"]("Final draft invalidation is pending")
                if final_path.exists():
                    try:
                        cached = json.loads(final_path.read_text(encoding="utf-8"))
                        summary = deps["validate_cached_summary"](cached, paper, document)
                    except (ValueError, KeyError, TypeError):
                        if not _quarantine_drafts(final_path, draft_path, deps):
                            raise deps["SummaryPublicationRejected"]("Final draft invalidation is pending")
                if summary is None:
                    with deps["literature_inference_scope"](directory):
                        generated = deps["generate_summary"](paper, document, deadline=inference_deadline, cache_path=notes_path)
                    summary = deps["validate_cached_summary"](generated, paper, document)
                    deps["save_json"](final_path, summary)
                operation = "publication"
                service.rpc("publish_institution_summary", **deps["summary_payload"](paper, document, summary))
                record(pmid, source_hash, "ready")
                counts["completed"] += 1
                first = not _cloud_ready(paper, source_hash)
                counts["first_completed" if first else "updated"] += 1
                print(f"PMID {pmid}: {'first summary published' if first else 'existing summary refreshed'}", flush=True)
            except deps["SummaryPublicationRejected"]:
                # Do not replay a definitively rejected final draft indefinitely.
                quarantined = _quarantine_drafts(final_path, draft_path, deps)
                record(pmid, source_hash, "publication_rejected")
                counts["failed"] += 1
                report_failure(pmid)
                action = "quarantined" if quarantined else "marked for invalidation"
                print(f"PMID {pmid}: publication rejected; final drafts {action}, original retained", flush=True)
            except deps["SummaryBudgetExpired"]:
                record(pmid, source_hash, "budget_yield")
                counts["yielded"] += 1
                print(f"PMID {pmid}: summary budget yielded; evidence retained for a later turn", flush=True)
                if deps["clock"]() >= deadline - PUBLICATION_RESERVE_SECONDS - MINIMUM_INFERENCE_SECONDS:
                    break
            except (ValueError, KeyError, TypeError) as error:
                record(pmid, source_hash, operation + "_validation")
                counts["failed"] += 1
                report_failure(pmid)
                print(f"PMID {pmid}: {operation} validation failed ({_validation_label(error)}); progressive retry scheduled", flush=True)
            except (OSError, RuntimeError):
                record(pmid, source_hash, operation + "_unavailable")
                counts["failed"] += 1
                report_failure(pmid)
                print(f"PMID {pmid}: {operation} temporarily unavailable; progressive retry scheduled", flush=True)
    finally:
        service.summary_deadline = old_service_deadline
    return counts
