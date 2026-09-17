"""Fair, resumable first-summary and refresh scheduling over verified local originals."""
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
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
                validate_draft_summary=local_summary.validate_draft_summary,
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


def run_summary_queue(directory, deadline, service, db, papers, *, dependencies=None, per_paper_seconds=420,
                      concurrency=1, refresh=None, refresh_seconds=60):
    """Infer on at most two threads; only the caller owns DB, final files and cloud writes.

    Default to one: the existing server benchmark serialized concurrent requests.
    Increase only after measuring server-side throughput, not merely client overlap.
    """
    if type(concurrency) is not int or not 1 <= concurrency <= 2:
        raise ValueError("Summary concurrency must be one or two")
    deps = _dependencies(dependencies)
    directory = Path(directory)
    spool = directory / "documents"
    spool.mkdir(exist_ok=True)
    prepare_summary_attempts(db)
    per_paper_seconds = min(420, max(30, per_paper_seconds))
    counts = dict(completed=0, first_completed=0, updated=0, failed=0, yielded=0, deferred=0)
    metadata = {row[0]: row[1:] for row in db.execute("SELECT pmid,source_hash,reason,consecutive_failures,attempted_at FROM summary_retry_metadata")}
    pending, active = [], {}
    seen, cache_checked, ready_cache_pmids = set(), set(), set()
    refresh_seconds = max(1, refresh_seconds)
    next_refresh = deps["clock"]() + refresh_seconds
    print(f"Summary queue: inference workers={concurrency}; first summaries before refreshes; "
          f"per-paper budget {per_paper_seconds}s", flush=True)
    old_service_deadline = getattr(service, "summary_deadline", None)

    def add_candidates(candidates):
        if not isinstance(candidates, (list, tuple)):
            raise ValueError("Summary candidates must be a list")
        local_pmids = {path.stem for folder in (spool, directory / "cloud-archive")
                       for path in folder.glob("*.json") if re.fullmatch(r"\d{1,12}", path.stem)}
        ready_cache_pmids.update(path.name.split(".")[0] for pattern in ("*.summary.json", "*.notes.draft.json")
                                for path in spool.glob(pattern))
        for paper in candidates:
            if not isinstance(paper, dict):
                continue
            pmid = str(paper.get("pmid", ""))
            if pmid in local_pmids and pmid not in seen:
                seen.add(pmid)
                pending.append({**paper, "pmid": pmid})
        pending.sort(key=lambda paper: str(paper.get("pub_date") or ""), reverse=True)
        pending.sort(key=lambda paper: (_cloud_ready(paper), metadata.get(paper["pmid"], (None, None, None, 0))[3]))

    def record(context, reason):
        record_summary_attempt(db, context["paper"]["pmid"], context["source_hash"], reason, deps["wall_clock"]())

    def report_failure(context):
        service.summary_deadline = context["deadline"]
        if deps["clock"]() >= context["deadline"] - 1:
            return
        try:
            service.status("running", context["paper"]["pmid"], "retryable_error")
        except (OSError, RuntimeError, ValueError):
            pass  # Local retry state already commits; a status outage cannot discard it.

    def log(context, message):
        elapsed = max(0, deps["clock"]() - context["started"])
        print(f"PMID {context['paper']['pmid']}: {message}; elapsed {elapsed:.1f}s", flush=True)

    def failed(context, error, operation):
        if isinstance(error, deps["SummaryPublicationRejected"]):
            quarantined = _quarantine_drafts(context["final"], context["draft"], deps)
            record(context, "publication_rejected")
            counts["failed"] += 1
            report_failure(context)
            action = "quarantined" if quarantined else "marked for invalidation"
            log(context, f"publication rejected; final drafts {action}, original retained")
        elif isinstance(error, deps["SummaryBudgetExpired"]):
            record(context, "budget_yield")
            counts["yielded"] += 1
            log(context, "summary budget yielded; evidence retained for a later turn")
        elif isinstance(error, (ValueError, KeyError, TypeError)):
            record(context, operation + "_validation")
            counts["failed"] += 1
            report_failure(context)
            log(context, f"{operation} validation failed ({_validation_label(error)}); progressive retry scheduled")
        elif isinstance(error, (OSError, RuntimeError)):
            record(context, operation + "_unavailable")
            counts["failed"] += 1
            report_failure(context)
            log(context, f"{operation} temporarily unavailable; progressive retry scheduled")
        else:
            raise error

    def prepare(paper):
        pmid = paper["pmid"]
        started = deps["clock"]()
        notes = spool / (pmid + ".notes.json")
        context = dict(paper=paper, source_hash="", started=started, deadline=min(deadline, started + per_paper_seconds),
                       final=spool / (pmid + ".summary.json"), notes=notes, draft=notes.with_suffix(".draft.json"),
                       tier=_cloud_ready(paper))
        operation = "original"
        try:
            prior = db.execute("SELECT status,next_retry FROM attempts WHERE pmid=?", [pmid]).fetchone()
            previous = metadata.get(pmid)
            if prior and prior[1] > deps["wall_clock"]() and (previous is None or not previous[0]):
                counts["deferred"] += 1
                return None
            document = _original(directory, paper, deps)
            if document is None:
                counts["deferred"] += 1
                return None
            context["document"] = document
            context["source_hash"] = hashlib.sha256(("fulltext\n" + paper["title"] + "\n" + document["content_text"]).encode()).hexdigest()
            if prior and prior[1] > deps["wall_clock"]() and (previous is None or previous[0] == context["source_hash"]):
                counts["deferred"] += 1
                return None
            operation = "summary"
            if previous and previous[1] == "publication_rejected":
                if not _quarantine_drafts(context["final"], context["draft"], deps):
                    raise deps["SummaryPublicationRejected"]("Final draft invalidation is pending")
            context["summary"] = None
            if context["final"].exists():
                try:
                    cached = json.loads(context["final"].read_text(encoding="utf-8"))
                    context["summary"] = deps["validate_cached_summary"](cached, paper, document)
                except (ValueError, KeyError, TypeError):
                    if not _quarantine_drafts(context["final"], context["draft"], deps):
                        raise deps["SummaryPublicationRejected"]("Final draft invalidation is pending")
            if context["summary"] is None and context["draft"].exists():
                try:
                    checkpoint = json.loads(context["draft"].read_text(encoding="utf-8"))
                    context["summary"] = deps["validate_draft_summary"](checkpoint, paper, document)
                    context["promoted_draft"] = True
                except (ValueError, KeyError, TypeError):
                    pass  # Retain invalid partial work for targeted model repair.
            return context
        except Exception as error:
            failed(context, error, operation)
            return None

    def infer(context):
        # ContextVars are not inherited by executor threads. Set the literature
        # scope here so every model request still uses the shared admission lock.
        with deps["literature_inference_scope"](directory):
            generated = deps["generate_summary"](context["paper"], context["document"],
                         deadline=context["deadline"] - PUBLICATION_RESERVE_SECONDS, cache_path=context["notes"])
        return deps["validate_cached_summary"](generated, context["paper"], context["document"])

    def publish(context, summary, generated=False):
        operation = "summary"
        try:
            if generated or context.get("promoted_draft"):
                deps["save_json"](context["final"], summary)
            operation = "publication"
            service.summary_deadline = context["deadline"]
            if deps["clock"]() >= context["deadline"] - 1:
                raise TimeoutError("Summary publication budget expired")
            service.rpc("publish_institution_summary", **deps["summary_payload"](context["paper"], context["document"], summary))
            record(context, "ready")
            counts["completed"] += 1
            first = not _cloud_ready(context["paper"], context["source_hash"])
            counts["first_completed" if first else "updated"] += 1
            if getattr(service, "publication_is_local", False):
                log(context, "first summary stored locally; sync pending" if first
                    else "existing summary refreshed locally; sync pending")
            else:
                log(context, "first summary published" if first else "existing summary refreshed")
        except Exception as error:
            failed(context, error, operation)

    def drain_completed():
        # Only this coordinator publishes and mutates final caches/retry state.
        for future in [item for item in active if item.done()]:
            context = active.pop(future)
            try:
                summary = future.result()
            except Exception as error:
                failed(context, error, "summary")
            else:
                publish(context, summary, generated=True)

    add_candidates(papers)
    try:
        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="literature-summary") as executor:
            while pending or active:
                drain_completed()
                now = deps["clock"]()
                can_start = now < deadline - PUBLICATION_RESERVE_SECONDS - MINIMUM_INFERENCE_SECONDS
                if refresh is not None and can_start and now >= next_refresh:
                    # A model may finish just after drain_completed(). Refresh
                    # must leave its publication reserve plus a safety second.
                    earliest_deadline = min([deadline] + [item["deadline"] for item in active.values()])
                    refresh_deadline = min(now + 30, earliest_deadline - PUBLICATION_RESERVE_SECONDS - 1)
                    if refresh_deadline - now >= 1:
                        next_refresh = now + refresh_seconds
                        prior_refresh_deadline = getattr(service, "summary_deadline", None)
                        service.summary_deadline = refresh_deadline
                        try:
                            add_candidates(refresh())
                        except (OSError, RuntimeError, ValueError):
                            print("Summary candidate refresh unavailable; existing queue retained", flush=True)
                        finally:
                            service.summary_deadline = prior_refresh_deadline
                    else:
                        # Keep draining active work; do not retry refresh every
                        # 250 ms while an expiring inference still owns a slot.
                        next_refresh = now + 1
                drain_completed()
                while pending:
                    if deps["clock"]() >= deadline - PUBLICATION_RESERVE_SECONDS - MINIMUM_INFERENCE_SECONDS:
                        break
                    tier = min([_cloud_ready(paper) for paper in pending] + [item["tier"] for item in active.values()])
                    eligible = [paper for paper in pending if _cloud_ready(paper) == tier]
                    if not eligible:
                        break  # Finish first summaries before admitting refreshes.
                    cached = next((paper for paper in eligible if paper["pmid"] not in cache_checked
                                   and paper["pmid"] in ready_cache_pmids), None)
                    if cached is None and len(active) >= concurrency:
                        break
                    paper = cached or eligible[0]
                    context = prepare(paper)
                    if cached is not None:
                        cache_checked.add(paper["pmid"])
                        if context is not None and context["summary"] is None:
                            continue  # Invalid cache returns to its ordinary fair position.
                    pending.remove(paper)
                    if context is None:
                        continue
                    if context["summary"] is not None:
                        publish(context, context["summary"])
                        break  # Recheck refresh and global deadlines after a cloud request.
                    else:
                        active[executor.submit(infer, context)] = context
                if active:
                    wait(active, timeout=.25, return_when=FIRST_COMPLETED)
                elif not can_start or not pending:
                    break
    finally:
        service.summary_deadline = old_service_deadline
    return counts
