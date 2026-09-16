"""Bounded collection concurrency; original persistence and queue writes stay on the caller."""
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from collections import deque
from http.client import IncompleteRead
import hashlib
import json
import os
from pathlib import Path
import re
import ssl
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit


class SourcePaused(RuntimeError):
    """A source rejected access earlier in this run; do not issue another request."""
    def __init__(self, message, *, retry_after=86400):
        super().__init__(message)
        self.retry_after = max(1, retry_after)


def _paper_identity(paper):
    """Bind negative lookups and pending routes to the catalog identity, not just PMID."""
    value = [str(paper.get("doi") or "").strip().lower(),
             " ".join(str(paper.get("title") or "").split())]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


def _prepare_probe_state(db, papers):
    with db:
        db.execute("""CREATE TABLE IF NOT EXISTS collection_source_probes(
            pmid TEXT NOT NULL, provider TEXT NOT NULL, identity TEXT NOT NULL,
            status TEXT NOT NULL, next_probe REAL NOT NULL, checked_at REAL NOT NULL, pmcid TEXT,
            PRIMARY KEY(pmid,provider))""")
        db.execute("""CREATE TABLE IF NOT EXISTS collection_browser_pending(
            pmid TEXT PRIMARY KEY, identity TEXT NOT NULL, queued_at REAL NOT NULL)""")
    identities = {str(paper.get("pmid")): _paper_identity(paper) for paper in papers}
    probes, pending, invalid = {}, [], set()
    for pmid, provider, identity, status, next_probe, checked_at, pmcid in db.execute(
            "SELECT pmid,provider,identity,status,next_probe,checked_at,pmcid FROM collection_source_probes"):
        if pmid not in identities:
            continue
        if identity != identities[pmid]:
            invalid.add(pmid)
            continue
        probes.setdefault(pmid, {})[provider] = {"status": status, "next_probe": next_probe,
                                               "checked_at": checked_at, "pmcid": pmcid}
    for pmid, identity, queued_at in db.execute(
            "SELECT pmid,identity,queued_at FROM collection_browser_pending ORDER BY queued_at,pmid"):
        if pmid not in identities:
            continue
        if identity != identities[pmid]:
            invalid.add(pmid)
        else:
            pending.append(pmid)
    if invalid:
        with db:
            for pmid in invalid:
                db.execute("DELETE FROM collection_source_probes WHERE pmid=?", (pmid,))
                db.execute("DELETE FROM collection_browser_pending WHERE pmid=?", (pmid,))
                db.execute("DELETE FROM collection_attempts WHERE pmid=?", (pmid,))
                db.execute("DELETE FROM collection_retry_metadata WHERE pmid=?", (pmid,))
                probes.pop(pmid, None)
        pending = [pmid for pmid in pending if pmid not in invalid]
    return probes, pending


def _providers_due(probes, enabled, now):
    return any(provider not in probes or probes[provider]["next_probe"] <= now
               for provider in enabled)


def source_key(url):
    host = urlsplit(url).hostname or "unknown"
    if host in {"doi.org", "dx.doi.org"}:
        return "doi.org"
    if host in {"linkinghub.elsevier.com", "sciencedirect.com", "www.sciencedirect.com"}:
        return "elsevier-web"
    if host in {"link.springer.com", "nature.com", "www.nature.com"}:
        return "springer-nature"
    if host.endswith("onlinelibrary.wiley.com"):
        return "wiley"
    return host


class SourceGate:
    def __init__(self, clock=time.monotonic, sleep=time.sleep):
        self.clock, self.sleep = clock, sleep
        self.lock = threading.Lock()
        self.last_started = {}
        self.blocked = set()
        self.blocked_until = {}

    def block(self, url, *, retry_seconds=86400):
        with self.lock:
            key = source_key(url)
            self.blocked.add(key)
            self.blocked_until[key] = max(self.blocked_until.get(key, 0), self.clock() + retry_seconds)

    def __call__(self, url, deadline):
        key = source_key(url)
        while True:
            with self.lock:
                now = self.clock()
                if now >= deadline:
                    raise TimeoutError("Collection time budget expired")
                if key in self.blocked:
                    raise SourcePaused("Source paused for this run", retry_after=self.blocked_until[key] - now)
                delay = self.last_started.get(key, now - 1) + 1 - now
                if delay <= 0:
                    self.last_started[key] = now
                    return
            self.sleep(min(delay, max(0, deadline - now), .1))


def _dependencies(overrides):
    import fulltext
    import institution_worker as worker
    deps = {name: getattr(worker, name) for name in (
        "Browser", "cached_paper_matches", "verify_cached_body", "parsed_result",
        "save_json", "prepare_collection_attempts", "record_collection_attempt")}
    deps.update(fetch_oa=worker.fetch_oa, fetch_elsevier=fulltext.fetch_elsevier,
                parse_document=fulltext.parse_document, unavailable=fulltext.FulltextUnavailable,
                clock=time.monotonic, wall_clock=time.time, sleep=time.sleep,
                 elsevier_enabled=bool(os.environ.get("ELSEVIER_API_KEY")))
    if worker.fetch_oa is fulltext.fetch_oa and (not overrides or "fetch_oa" not in overrides):
        from oa_discovery import discover_oa_batch, fetch_discovered_oa
        deps.update(discover_oa_batch=discover_oa_batch, fetch_discovered_oa=fetch_discovered_oa)
    deps.update(overrides or {})
    return deps


def _browser_source(paper):
    doi = str(paper.get("doi") or "").lower()
    if doi.startswith("10.1016/"):
        return "https://www.sciencedirect.com/"
    if doi.startswith(("10.1007/", "10.1038/")):
        return "https://link.springer.com/"
    if doi.startswith(("10.1002/", "10.1111/")):
        return "https://onlinelibrary.wiley.com/"
    if doi.startswith("10.1001/"):
        return "https://jamanetwork.com/"
    if doi.startswith("10.1136/"):
        return "https://www.bmj.com/"
    return "https://doi.org/"


class _SharedBrowser:
    def __init__(self, directory, node, deadline, deps, gate):
        self.directory, self.node, self.deadline = directory, node, deadline
        self.deps, self.gate = deps, gate
        self.lock = threading.Lock()
        self.browser = None
        self.unknown_source_blocked = False

    def read(self, paper):
        # One complete request/response owns the existing JSON-lines transport.
        while not self.lock.acquire(timeout=.1):
            if self.deps["clock"]() >= self.deadline:
                raise TimeoutError("Collection time budget expired")
        try:
            remaining = self.deadline - self.deps["clock"]()
            if remaining <= 1:
                raise TimeoutError("Collection time budget expired")
            source = _browser_source(paper)
            if self.unknown_source_blocked and source_key(source) == "doi.org":
                raise SourcePaused("Unknown browser source paused for this run")
            self.gate(source, self.deadline)
            if self.browser is None:
                self.browser = self.deps["Browser"](self.node, self.directory)
            budget = int(min(240, max(0, self.deadline - self.deps["clock"]())) * 1000)
            if budget < 1000:
                raise TimeoutError("Collection time budget expired")
            try:
                result = self.browser.read(paper, budget_ms=budget)
            except (OSError, ValueError):
                # Browser.read already bounds a stalled response and may kill it.
                self.browser.close()
                self.browser = None
                return {"status": "retryable_error", "reason": "browser_response_unavailable"}
            if result.get("status") == "challenge" or result.get("reason") in {"http_403", "http_429"}:
                actual = result.get("url") or source
                self.gate.block(actual)
                self.gate.block(source)
                if source_key(source) == "doi.org":
                    self.unknown_source_blocked = True
            return result
        finally:
            self.lock.release()

    def close(self):
        if self.browser is not None:
            self.browser.close()


def _read_cache(directory, paper):
    """Only the coordinator reads files; worker threads receive in-memory inputs."""
    pmid = str(paper["pmid"])
    entries = []
    for kind, path in (
        ("document", directory / "documents" / (pmid + ".json")),
        ("archive", directory / "cloud-archive" / (pmid + ".json")),
        ("source", directory / "sources" / (pmid + ".browser.json")),
    ):
        if path.exists():
            entries.append((kind, json.loads(path.read_text(encoding="utf-8"))))
    return entries


def _acquire_api(paper, cache, deadline, deps, gate, probes=None):
    """Network and parsing only. No persistence, SQLite, or service-side writes."""
    probes = probes or {}
    updates, stats = [], {"provider_probes": 0, "cached_no_copy": 0, "cached_location": 0, "cached_retry": 0,
                          "provider_errors": 0, "source_paused": 0, "api_http_403": 0,
                          "api_http_429": 0, "api_http_other": 0, "api_parse_errors": 0, "api_network_errors": 0}
    def result(outcome):
        return {**outcome, "probe_updates": updates, "probe_stats": stats}
    def update(provider, status, delay, *, clear_location=False):
        now = deps["wall_clock"]()
        updates.append({"provider": provider, "status": status, "next_probe": now + delay,
                        "checked_at": now, "pmcid": None if clear_location else probes.get(provider, {}).get("pmcid")})
    if deps["clock"]() >= deadline:
        return result({"deferred": True})
    try:
        for kind, saved in cache:
            if kind == "source":
                document = deps["parsed_result"](paper, saved)
                if document is None:
                    return result({"status": saved.get("status", "parse_failed"), "reason": saved.get("reason", "validation_failed")})
                return result({"document": document, "raw": saved["html"].encode(), "suffix": ".html", "persist": True})
            identity = saved["paper"] if kind == "archive" else saved
            if deps["cached_paper_matches"](identity, paper):
                document = deps["verify_cached_body"](saved["document"])
                return result({"document": document, "persist": kind == "archive"})
        api_deadline = min(deadline, deps["clock"]() + 120)
        providers = [("oa", deps["fetch_oa"])]
        if deps["elsevier_enabled"]:
            providers.append(("elsevier", deps["fetch_elsevier"]))
        for name, provider in providers:
            prior = probes.get(name, {})
            if prior.get("next_probe", 0) > deps["wall_clock"]():
                stats["cached_no_copy" if prior.get("status") in {"unavailable", "not_indexed"} else "cached_retry"] += 1
                continue
            try:
                stats["provider_probes"] += 1
                if name == "oa" and prior.get("pmcid") and deps.get("fetch_discovered_oa"):
                    stats["cached_location"] += 1
                    content, url = deps["fetch_discovered_oa"](str(paper["pmid"]),
                        {str(paper["pmid"]): {"status": "available", "pmcid": prior["pmcid"],
                            "source_url": "https://www.ebi.ac.uk/europepmc/webservices/rest/" + prior["pmcid"] + "/fullTextXML"}},
                        deadline=api_deadline, request_gate=gate)
                else:
                    content, url = provider(str(paper["pmid"]), deadline=api_deadline, request_gate=gate)
                document = deps["parse_document"](content)
                if len(document["content_text"]) < 2000 or len(document["sections"]) < 2:
                    raise ValueError("Incomplete OA body")
                update(name, "downloaded", 0)
                return result({"document": {**document, "source_url": url}, "raw": content, "suffix": ".xml", "persist": True})
            except deps["unavailable"]:
                update(name, "unavailable", 7 * 86400)
            except HTTPError as error:
                stats["provider_errors"] += 1
                stats["api_http_" + str(error.code) if error.code in (403, 429) else "api_http_other"] += 1
                if error.code in (403, 429):
                    gate.block(error.url, retry_seconds=3600 if error.code == 429 else 86400)
                    stats["source_paused"] += 1
                update(name, "access_required" if error.code == 403 else "retryable_error",
                       86400 if error.code == 403 else 3600 if error.code == 429 else 900,
                       clear_location=error.code in (404, 410))
            except SourcePaused as error:
                # An API rejection must not starve a different authorized source.
                stats["source_paused"] += 1
                update(name, "source_paused", error.retry_after)
                continue
            except (URLError, TimeoutError, ValueError, IncompleteRead, ConnectionError, ssl.SSLError) as error:
                stats["provider_errors"] += 1
                stats["api_parse_errors" if isinstance(error, ValueError) else "api_network_errors"] += 1
                update(name, "parse_failed" if isinstance(error, ValueError) else "retryable_error", 900)
                if deps["clock"]() >= deadline:
                    return result({"deferred": True})
        return result({"browser": True})
    except (SourcePaused, TimeoutError):
        return result({"deferred": True})
    except (ValueError, KeyError, TypeError):
        return result({"status": "parse_failed", "reason": "validation_failed"})
    except (OSError, IncompleteRead):
        return result({"status": "retryable_error", "reason": "collection_unavailable"})


def _acquire_browser(paper, deadline, deps, browser):
    try:
        if deps["clock"]() >= deadline:
            return {"deferred": True}
        if str(paper.get("doi") or "").lower().startswith("10.1016/"):
            return {"status": "unsupported", "reason": "browser_automation_not_permitted"}
        result = browser.read(paper)
        document = deps["parsed_result"](paper, result)
        if document is None:
            return {"status": result.get("status", "parse_failed"), "reason": result.get("reason", "validation_failed")}
        return {"document": document, "raw": result["html"].encode(), "suffix": ".html", "persist": True}
    except SourcePaused:
        return {"deferred": True, "source_paused": True}
    except TimeoutError:
        return {"deferred": True}
    except (ValueError, KeyError, TypeError):
        return {"status": "parse_failed", "reason": "validation_failed"}
    except (OSError, IncompleteRead):
        return {"status": "retryable_error", "reason": "collection_unavailable"}


def _save_bytes(path, content):
    from institution_worker import atomic_replace
    temporary = path.with_suffix(path.suffix + ".pending")
    with temporary.open("wb") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    atomic_replace(temporary, path)


def run_collection(directory, node, deadline, service, db, papers, *, dependencies=None, max_workers=3):
    """Return completed/failed/deferred counts; deadline is an absolute monotonic time.

    At most three bounded API acquisitions and one browser request run. API
    slots never wait for the browser. Submissions stop at the deadline;
    already running bounded requests settle before the shared browser is closed.
    Results acquired before shutdown are committed even if the deadline just passed.
    """
    deps = _dependencies(dependencies)
    directory = Path(directory)
    spool = directory / "documents"
    spool.mkdir(exist_ok=True)
    deps["prepare_collection_attempts"](db)
    papers = list(papers)
    probes, pending_ids = _prepare_probe_state(db, papers)
    enabled = ("oa", "elsevier") if deps["elsevier_enabled"] else ("oa",)
    prior_retries = dict(db.execute("SELECT pmid,next_retry FROM collection_attempts"))
    receipt_retries = {row[0] for row in db.execute(
        "SELECT pmid FROM collection_retry_metadata WHERE reason='registration_failed'")
        if prior_retries.get(row[0], 0) <= deps["wall_clock"]()}
    def urgent(paper):
        pmid = str(paper.get("pmid"))
        oa = probes.get(pmid, {}).get("oa", {})
        return pmid in receipt_retries or (oa.get("status") == "available"
                                            and oa.get("next_probe", 0) <= deps["wall_clock"]())
    by_pmid = {str(paper.get("pmid")): paper for paper in papers}
    # The latest-first catalog remains the tie-breaker; an hourly restart cannot
    # put thousands of already-probed misses ahead of untouched older originals.
    papers.sort(key=lambda paper: (
        str(paper.get("pmid")) not in receipt_retries,
        not (probes.get(str(paper.get("pmid")), {}).get("oa", {}).get("status") == "available"
             and probes[str(paper.get("pmid"))]["oa"]["next_probe"] <= deps["wall_clock"]()),
        bool(probes.get(str(paper.get("pmid")))),
        min((row["checked_at"] for row in probes.get(str(paper.get("pmid")), {}).values()), default=0)))
    gate = SourceGate(deps["clock"], deps["sleep"])
    browser = _SharedBrowser(directory, node, deadline, deps, gate)
    counts = {"completed": 0, "failed": 0, "deferred": 0}
    stats = {"api_candidates": 0, "provider_probes": 0, "cached_no_copy": 0,
             "cached_location": 0, "cached_retry": 0, "provider_errors": 0, "source_paused": 0,
             "discovery_batches": 0, "discovery_papers": 0, "browser_attempts": 0,
             "api_http_403": 0, "api_http_429": 0, "api_http_other": 0, "api_parse_errors": 0, "api_network_errors": 0}
    print(f"Collection workers: api={max(1, min(3, max_workers))}, browser=1; publisher navigation serialized", flush=True)
    seen, pending = set(), {}
    iterator = deque(papers)
    exhausted = False
    browser_backlog, browser_pending, browser_enqueued = deque(), {}, set()
    for pmid in pending_ids:
        if prior_retries.get(pmid, 0) <= deps["wall_clock"]() and probes.get(pmid, {}).get("browser", {}).get("next_probe", 0) <= deps["wall_clock"]() and not _providers_due(
                probes.get(pmid, {}), enabled, deps["wall_clock"]()):
            browser_backlog.append(by_pmid[pmid])
            browser_enqueued.add(pmid)
            stats["cached_no_copy"] += sum(row["status"] in {"unavailable", "not_indexed"} for row in probes.get(pmid, {}).values())

    def record_probes(paper, updates):
        pmid, identity = str(paper["pmid"]), _paper_identity(paper)
        for update in updates:
            db.execute("INSERT OR REPLACE INTO collection_source_probes VALUES(?,?,?,?,?,?,?)",
                (pmid, update["provider"], identity, update["status"], update["next_probe"],
                 update["checked_at"], update.get("pmcid")))
            probes.setdefault(pmid, {})[update["provider"]] = dict(update)

    def enqueue_browser(paper):
        pmid = str(paper["pmid"])
        if probes.get(pmid, {}).get("browser", {}).get("next_probe", 0) > deps["wall_clock"]():
            counts["deferred"] += 1
            return False
        db.execute("INSERT OR IGNORE INTO collection_browser_pending VALUES(?,?,?)",
                   (pmid, _paper_identity(paper), deps["wall_clock"]()))
        if pmid not in browser_enqueued:
            # Only catalog references are queued, never documents or open requests.
            browser_backlog.append(paper)
            browser_enqueued.add(pmid)
            return True
        return False

    def clear_browser(pmid):
        db.execute("DELETE FROM collection_browser_pending WHERE pmid=?", (pmid,))

    def discover(prepared):
        if not deps.get("discover_oa_batch") or deps["clock"]() >= deadline:
            return
        candidates = [paper for paper, has_cache in prepared if not has_cache
            and not probes.get(str(paper["pmid"]), {}).get("oa", {}).get("pmcid")
            and _providers_due(probes.get(str(paper["pmid"]), {}), ("oa",), deps["wall_clock"]())]
        if not candidates:
            return
        stats["discovery_batches"] += 1
        stats["discovery_papers"] += len(candidates)
        try:
            locations = deps["discover_oa_batch"]([str(paper["pmid"]) for paper in candidates],
                deadline=min(deadline, deps["clock"]() + 120), request_gate=gate)
        except SourcePaused as error:
            stats["source_paused"] += 1
            now = deps["wall_clock"]()
            for paper in candidates:
                record_probes(paper, [{"provider": "oa", "status": "source_paused",
                    "next_probe": now + error.retry_after, "checked_at": now}])
            db.commit()
            return
        except (HTTPError, URLError, TimeoutError, ValueError, OSError, IncompleteRead) as error:
            stats["provider_errors"] += 1
            code = error.code if isinstance(error, HTTPError) else None
            stats[("api_http_" + str(code) if code in (403, 429) else "api_http_other") if code is not None
                  else "api_parse_errors" if isinstance(error, ValueError) else "api_network_errors"] += 1
            if code in (403, 429):
                gate.block(error.url, retry_seconds=3600 if code == 429 else 86400)
                stats["source_paused"] += 1
            now = deps["wall_clock"]()
            for paper in candidates:
                record_probes(paper, [{"provider": "oa", "status": "access_required" if code == 403 else "retryable_error",
                    "next_probe": now + (86400 if code == 403 else 3600 if code == 429 else 900), "checked_at": now}])
            db.commit()
            return
        now = deps["wall_clock"]()
        for paper in candidates:
            location = locations[str(paper["pmid"])]
            available = location["status"] == "available"
            not_indexed = location.get("reason") == "not_indexed"
            record_probes(paper, [{"provider": "oa", "status": "available" if available else "not_indexed" if not_indexed else "unavailable",
                "next_probe": now if available else now + (86400 if not_indexed else 7 * 86400), "checked_at": now,
                "pmcid": location.get("pmcid") if available else None}])
        db.commit()

    def finish(paper, outcome, *, browser_attempt=False):
        pmid = str(paper["pmid"])
        if outcome.get("deferred"):
            counts["deferred"] += 1
            if outcome.get("source_paused"):
                stats["source_paused"] += 1
            return
        if "document" in outcome:
            document = outcome["document"]
            if outcome.get("persist"):
                if "raw" in outcome:
                    _save_bytes(spool / (pmid + outcome["suffix"]), outcome["raw"])
                deps["save_json"](spool / (pmid + ".json"),
                                  {"doi": paper.get("doi"), "title": paper["title"], "document": document})
            try:
                if not paper.get("fulltext_available"):
                    service.register_original(paper, document)
            except Exception:
                # The verified local original remains available for a later receipt retry.
                outcome = {"status": "retryable_error", "reason": "registration_failed"}
            else:
                deps["record_collection_attempt"](db, pmid, "ready", now=deps["wall_clock"]())
                clear_browser(pmid)
                if outcome.get("persist"):
                    counts["completed"] += 1
                    print(f"PMID {pmid}: original stored locally; queued for Spark summary", flush=True)
                return
        status = outcome.get("status")
        if status not in {"access_required", "challenge", "unsupported", "parse_failed", "retryable_error"}:
            status = "parse_failed"
        now = deps["wall_clock"]()
        retry_at = deps["record_collection_attempt"](db, pmid, status, outcome.get("reason"), now=now)
        if browser_attempt:
            record_probes(paper, [{"provider": "browser", "status": status,
                "next_probe": retry_at, "checked_at": now}])
            # A browser-only failure must not postpone an independently eligible
            # API retry. The browser retains its own unchanged retry deadline.
            api_retries = [row["next_probe"] for name, row in probes.get(pmid, {}).items()
                           if name in enabled and now < row["next_probe"] < retry_at]
            if api_retries:
                db.execute("UPDATE collection_attempts SET next_retry=? WHERE pmid=?", (min(api_retries), pmid))
        clear_browser(pmid)
        service.status("running", pmid, status)
        counts["failed"] += 1
        reason = outcome.get("reason", "validation_failed")
        reason = reason if isinstance(reason, str) and re.fullmatch(r"[a-z0-9_]{1,80}", reason) else "unspecified"
        print(f"PMID {pmid}: {status}, {reason}", flush=True)

    prepared = deque()
    try:
        with ThreadPoolExecutor(max_workers=max(1, min(3, max_workers)), thread_name_prefix="literature-oa") as pool, \
                ThreadPoolExecutor(max_workers=1, thread_name_prefix="literature-browser") as browser_pool:
            while pending or browser_pending or browser_backlog or prepared or not exhausted:
                if deps["clock"]() >= deadline:
                    exhausted = True
                    counts["deferred"] += len(browser_backlog)
                    browser_backlog.clear()
                    counts["deferred"] += len(prepared)
                    prepared.clear()
                fill_batch = not prepared and not pending
                while fill_batch and not exhausted and len(prepared) < 50:
                    if deps["clock"]() >= deadline:
                        exhausted = True
                        break
                    try:
                        paper = iterator.popleft()
                    except IndexError:
                        exhausted = True
                        break
                    pmid = str(paper.get("pmid", ""))
                    if not re.fullmatch(r"\d{1,12}", pmid) or pmid in seen:
                        continue
                    if prepared and urgent(prepared[0][0]) and not urgent(paper):
                        iterator.appendleft(paper)
                        break
                    seen.add(pmid)
                    if pmid in browser_enqueued:
                        continue
                    if prior_retries.get(pmid, 0) > deps["wall_clock"]():
                        counts["deferred"] += 1
                        continue
                    has_cache = any(path.exists() for path in (
                        directory / "documents" / (pmid + ".json"),
                        directory / "cloud-archive" / (pmid + ".json"),
                        directory / "sources" / (pmid + ".browser.json")))
                    if deps["clock"]() >= deadline:
                        counts["deferred"] += 1
                        exhausted = True
                        break
                    prepared.append((paper, has_cache))
                if prepared and not pending:
                    discover(prepared)
                while prepared and len(pending) < max(1, min(3, max_workers)) and deps["clock"]() < deadline:
                    paper, _ = prepared.popleft()
                    try:
                        cache = _read_cache(directory, paper)
                    except (OSError, ValueError):
                        finish(paper, {"status": "parse_failed", "reason": "cache_validation_failed"})
                        continue
                    stats["api_candidates"] += 1
                    pending[pool.submit(_acquire_api, paper, cache, deadline, deps, gate,
                                        probes.get(str(paper["pmid"]), {}))] = paper
                if browser_backlog and not browser_pending and deps["clock"]() < deadline:
                    paper = browser_backlog.popleft()
                    stats["browser_attempts"] += 1
                    browser_pending[browser_pool.submit(_acquire_browser, paper, deadline, deps, browser)] = paper
                if not pending and not browser_pending:
                    if prepared or browser_backlog or not exhausted:
                        continue
                    break
                completed, _ = wait([*pending, *browser_pending], timeout=.1, return_when=FIRST_COMPLETED)
                for future in completed:
                    browser_attempt = future in browser_pending
                    paper = pending.pop(future) if not browser_attempt else browser_pending.pop(future)
                    try:
                        outcome = future.result()
                    except Exception:
                        outcome = {"status": "retryable_error", "reason": "collection_unavailable"}
                    record_probes(paper, outcome.get("probe_updates", []))
                    for key, value in outcome.get("probe_stats", {}).items():
                        stats[key] += value
                    if outcome.get("browser"):
                        queued = enqueue_browser(paper)
                        if queued and deps["clock"]() >= deadline:
                            browser_backlog.pop()
                            counts["deferred"] += 1
                    else:
                        finish(paper, outcome, browser_attempt=browser_attempt)
                # Persist source outcomes and browser routing together before the
                # next submission; do not fsync separately for every probe field.
                db.commit()
    finally:
        browser.close()
        stats["browser_pending"] = db.execute("SELECT count(*) FROM collection_browser_pending").fetchone()[0]
        print("Collection telemetry: " + json.dumps(stats, sort_keys=True), flush=True)
    return counts
