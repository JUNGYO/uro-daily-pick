"""Bounded collection concurrency; original persistence and queue writes stay on the caller."""
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from collections import deque
from http.client import IncompleteRead
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

    def block(self, url):
        with self.lock:
            self.blocked.add(source_key(url))

    def __call__(self, url, deadline):
        key = source_key(url)
        while True:
            with self.lock:
                now = self.clock()
                if now >= deadline:
                    raise TimeoutError("Collection time budget expired")
                if key in self.blocked:
                    raise SourcePaused("Source paused for this run")
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
            if self.unknown_source_blocked:
                raise SourcePaused("Unknown browser source paused for this run")
            source = _browser_source(paper)
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


def _acquire_api(paper, cache, deadline, deps, gate):
    """Network and parsing only. No persistence, SQLite, or service-side writes."""
    if deps["clock"]() >= deadline:
        return {"deferred": True}
    try:
        for kind, saved in cache:
            if kind == "source":
                document = deps["parsed_result"](paper, saved)
                if document is None:
                    return {"status": saved.get("status", "parse_failed"), "reason": saved.get("reason", "validation_failed")}
                return {"document": document, "raw": saved["html"].encode(), "suffix": ".html", "persist": True}
            identity = saved["paper"] if kind == "archive" else saved
            if deps["cached_paper_matches"](identity, paper):
                document = deps["verify_cached_body"](saved["document"])
                return {"document": document, "persist": kind == "archive"}
        api_deadline = min(deadline, deps["clock"]() + 120)
        providers = [deps["fetch_oa"]]
        if deps["elsevier_enabled"]:
            providers.append(deps["fetch_elsevier"])
        for provider in providers:
            try:
                content, url = provider(str(paper["pmid"]), deadline=api_deadline, request_gate=gate)
                document = deps["parse_document"](content)
                if len(document["content_text"]) < 2000 or len(document["sections"]) < 2:
                    raise ValueError("Incomplete OA body")
                return {"document": {**document, "source_url": url}, "raw": content, "suffix": ".xml", "persist": True}
            except HTTPError as error:
                if error.code in (403, 429):
                    gate.block(error.url)
            except SourcePaused:
                # An API rejection must not starve a different authorized source.
                continue
            except (deps["unavailable"], URLError, TimeoutError, ValueError, IncompleteRead, ConnectionError, ssl.SSLError):
                if deps["clock"]() >= deadline:
                    return {"deferred": True}
        return {"browser": True}
    except (SourcePaused, TimeoutError):
        return {"deferred": True}
    except (ValueError, KeyError, TypeError):
        return {"status": "parse_failed", "reason": "validation_failed"}
    except (OSError, IncompleteRead):
        return {"status": "retryable_error", "reason": "collection_unavailable"}


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
    except (SourcePaused, TimeoutError):
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
    gate = SourceGate(deps["clock"], deps["sleep"])
    browser = _SharedBrowser(directory, node, deadline, deps, gate)
    counts = {"completed": 0, "failed": 0, "deferred": 0}
    print(f"Collection workers: api={max(1, min(3, max_workers))}, browser=1; publisher navigation serialized", flush=True)
    seen, pending = set(), {}
    iterator = iter(papers)
    exhausted = False

    def finish(paper, outcome):
        pmid = str(paper["pmid"])
        if outcome.get("deferred"):
            counts["deferred"] += 1
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
                if outcome.get("persist"):
                    counts["completed"] += 1
                    print(f"PMID {pmid}: original stored locally; queued for Spark summary", flush=True)
                return
        status = outcome.get("status")
        if status not in {"access_required", "challenge", "unsupported", "parse_failed", "retryable_error"}:
            status = "parse_failed"
        deps["record_collection_attempt"](db, pmid, status, outcome.get("reason"), now=deps["wall_clock"]())
        service.status("running", pmid, status)
        counts["failed"] += 1
        reason = outcome.get("reason", "validation_failed")
        reason = reason if isinstance(reason, str) and re.fullmatch(r"[a-z0-9_]{1,80}", reason) else "unspecified"
        print(f"PMID {pmid}: {status}, {reason}", flush=True)

    browser_backlog, browser_pending = deque(), {}
    try:
        with ThreadPoolExecutor(max_workers=max(1, min(3, max_workers)), thread_name_prefix="literature-oa") as pool, \
                ThreadPoolExecutor(max_workers=1, thread_name_prefix="literature-browser") as browser_pool:
            while pending or browser_pending or browser_backlog or not exhausted:
                if deps["clock"]() >= deadline:
                    exhausted = True
                    counts["deferred"] += len(browser_backlog)
                    browser_backlog.clear()
                while not exhausted and len(pending) < max(1, min(3, max_workers)):
                    if deps["clock"]() >= deadline:
                        exhausted = True
                        break
                    try:
                        paper = next(iterator)
                    except StopIteration:
                        exhausted = True
                        break
                    pmid = str(paper.get("pmid", ""))
                    if not re.fullmatch(r"\d{1,12}", pmid) or pmid in seen:
                        continue
                    seen.add(pmid)
                    prior = db.execute("SELECT next_retry FROM collection_attempts WHERE pmid=?", (pmid,)).fetchone()
                    if prior and prior[0] > deps["wall_clock"]():
                        counts["deferred"] += 1
                        continue
                    try:
                        cache = _read_cache(directory, paper)
                    except (OSError, ValueError):
                        finish(paper, {"status": "parse_failed", "reason": "cache_validation_failed"})
                        continue
                    if deps["clock"]() >= deadline:
                        counts["deferred"] += 1
                        exhausted = True
                        break
                    pending[pool.submit(_acquire_api, paper, cache, deadline, deps, gate)] = paper
                if browser_backlog and not browser_pending and deps["clock"]() < deadline:
                    paper = browser_backlog.popleft()
                    browser_pending[browser_pool.submit(_acquire_browser, paper, deadline, deps, browser)] = paper
                if not pending and not browser_pending:
                    break
                completed, _ = wait([*pending, *browser_pending], timeout=.1, return_when=FIRST_COMPLETED)
                for future in completed:
                    paper = pending.pop(future) if future in pending else browser_pending.pop(future)
                    try:
                        outcome = future.result()
                    except Exception:
                        outcome = {"status": "retryable_error", "reason": "collection_unavailable"}
                    if outcome.get("browser"):
                        if len(browser_backlog) < 64 and deps["clock"]() < deadline:
                            browser_backlog.append(paper)
                        else:
                            # The catalog record remains due; no failure/backoff is written.
                            counts["deferred"] += 1
                    else:
                        finish(paper, outcome)
    finally:
        browser.close()
    return counts
