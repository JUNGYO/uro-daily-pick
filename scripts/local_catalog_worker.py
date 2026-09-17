"""Local-first PubMed inventory; cloud limits never pause local discovery."""
import argparse
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import ssl
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

import catalog_backfill as backfill
from journal_registry import REGISTRY_VERSION, journal_entries
from local_catalog import LocalCatalog


class CatalogDeadlineExpired(TimeoutError):
    """Cooperative yield: committed PMID snapshots remain immediately resumable."""


def _pubmed_request(endpoint, params, deadline, limit, parse):
    """Use OS-trusted HTTPS, matching the existing local worker's TLS policy.

    Windows corporate/institutional roots are available through Python's default
    SSL context; requests' bundled CA set can omit them. Verification remains
    mandatory and no persistent certificate or proxy configuration is changed.
    """
    context = ssl.create_default_context()
    if context.verify_mode != ssl.CERT_REQUIRED or not context.check_hostname:
        raise ValueError("PubMed requires verified HTTPS")
    url = backfill.PUBMED_BASE + "/" + endpoint + "?" + urlencode(params)
    for attempt in range(4):
        if deadline - time.monotonic() <= .4:
            raise CatalogDeadlineExpired("Local catalog request budget expired")
        time.sleep(.4)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise CatalogDeadlineExpired("Local catalog request budget expired")
        try:
            request = Request(url, headers={"Accept": "application/json" if endpoint == "esearch.fcgi" else "application/xml",
                                           "Connection": "close", "User-Agent": "uro_daily_pick/1.0"})
            with urlopen(request, context=context, timeout=min(45, remaining)) as response:
                data = response.read(limit + 1)
            if len(data) > limit:
                raise ValueError("PubMed response exceeds metadata size limit")
            if time.monotonic() >= deadline:
                raise CatalogDeadlineExpired("Local catalog response budget expired")
            return parse(data)
        except HTTPError as error:
            status = error.code
            error.close()
            if status not in {408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524}:
                raise
        except CatalogDeadlineExpired:
            raise
        except (URLError, TimeoutError, ConnectionError, ssl.SSLError):
            pass
        if attempt == 3:
            raise RuntimeError("PubMed metadata request unavailable") from None
        pause = min(2 ** (attempt + 1), 8)
        if deadline - time.monotonic() <= pause + .4:
            raise CatalogDeadlineExpired("Local catalog retry budget expired")
        time.sleep(pause)


def pubmed_search(job, deadline):
    return _pubmed_request("esearch.fcgi", {
        "db": "pubmed", "term": backfill.search_term(job), "retmax": backfill.PAGE_LIMIT,
        "retmode": "json", "tool": "uro_daily_pick", "email": backfill.PUBMED_EMAIL,
    }, deadline, 16 * 1024**2, lambda data: json.loads(data)["esearchresult"])


def pubmed_details(ids, deadline):
    def parse(data):
        root = ET.fromstring(data)
        if root.find(".//ERROR") is not None:
            raise ValueError("PubMed detail error")
        return [backfill.parse_article(article) for article in root.findall(".//PubmedArticle")]
    return _pubmed_request("efetch.fcgi", {
        "db": "pubmed", "id": ",".join(ids), "retmode": "xml",
        "tool": "uro_daily_pick", "email": backfill.PUBMED_EMAIL,
    }, deadline, 32 * 1024**2, parse)


@contextmanager
def phase_lock(directory, name="catalog"):
    """Non-blocking process lock, released by the OS even after a crash."""
    if not name or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789-" for ch in name):
        raise ValueError("Invalid phase lock name")
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / (name + ".lock")).open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        acquired = False
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except OSError:
            pass
        try:
            yield acquired
        finally:
            if acquired:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class LocalStore:
    """Adapter for the proven PMID-sharded catalog_backfill process_job."""
    def __init__(self, catalog):
        self.catalog = catalog

    def read(self, table, params):
        if table != "catalog_backfill_jobs":
            raise ValueError("Unsupported local checkpoint read")
        rows = [json.loads(row[0]) for row in self.catalog.db.execute("SELECT data FROM catalog_jobs")]
        key = params.get("job_key", "")
        if key.startswith("eq."):
            rows = [row for row in rows if row["job_key"] == key[3:]]
        elif key.startswith("in.("):
            keys = set(key[4:-1].split(","))
            rows = [row for row in rows if row["job_key"] in keys]
        return rows[:int(params.get("limit", len(rows)))]

    def insert(self, table, rows, conflict):
        self.ensure_capacity()
        if table == "papers" and conflict == "pmid":
            return self.catalog.upsert_papers(rows)
        if table != "catalog_backfill_jobs" or conflict != "job_key":
            raise ValueError("Unsupported local checkpoint insert")
        added = 0
        with self.catalog._write():
            for row in rows:
                job = {"status": "pending", "processed": 0, "updated_at": _now(), **row}
                cursor = self.catalog.db.execute("INSERT OR IGNORE INTO catalog_jobs VALUES(?,?)",
                    (job["job_key"], json.dumps(job, separators=(",", ":"))))
                added += cursor.rowcount
        return added

    def update(self, key, values):
        with self.catalog._write():
            prior = self.catalog.db.execute("SELECT data FROM catalog_jobs WHERE job_key=?", (key,)).fetchone()
            if prior is None:
                raise ValueError("Unknown local catalog checkpoint")
            job = {**json.loads(prior[0]), **values, "updated_at": _now()}
            self.catalog.db.execute("UPDATE catalog_jobs SET data=? WHERE job_key=?",
                                    (json.dumps(job, separators=(",", ":")), key))

    def adopt_query(self, query, metadata):
        if set(metadata) != {"journal_id", "query_version", "registry_version", "priority"}:
            raise ValueError("Only registry metadata may be adopted")
        with self.catalog._write():
            rows = self.catalog.db.execute("SELECT job_key,data FROM catalog_jobs").fetchall()
            for row in rows:
                job = json.loads(row["data"])
                if job["query"] == query and job.get("start_date") == backfill.AUTOMATIC_START_DATE:
                    job.update(metadata)
                    self.catalog.db.execute("UPDATE catalog_jobs SET data=? WHERE job_key=?",
                                            (json.dumps(job, separators=(",", ":")), row["job_key"]))

    def ensure_capacity(self):
        self.catalog.ensure_capacity()

    def next_job(self, recent=False):
        now = _now()
        rows = [row for row in self.read("catalog_backfill_jobs", {})
                if row.get("registry_version") == REGISTRY_VERSION
                and row.get("status") in {"pending", "active", "error"}
                and (not row.get("retry_after") or row["retry_after"] <= now)
                and row.get("journal_id", "").startswith("recent:") == recent]
        rows.sort(key=lambda row: (row.get("priority", 20), row.get("status", ""),
                                  -row.get("lower_uid", 1), row.get("updated_at", ""), row["job_key"]))
        return rows[0] if rows else None


def _now():
    return datetime.now(timezone.utc).isoformat()


def seed_recent_jobs(store, today=None, entries=None):
    """Daily overlapping EDAT/MDAT discovery survives completed historical snapshots.

    A gap longer than the normal 30-day overlap expands from the last completed
    poll, so offline weeks cannot silently lose newly indexed/updated records.
    """
    today = today or datetime.now(timezone.utc).date()
    entries = journal_entries() if entries is None else entries
    start = today - timedelta(days=30)
    last = store.catalog.get_meta("recent_completed_through")
    if last:
        start = min(start, date.fromisoformat(last) - timedelta(days=7))
    stamp = today.isoformat()
    jobs = []
    for entry in entries:
        interval = f'{start:%Y/%m/%d}:{today:%Y/%m/%d}'
        query = f'({entry.query}) AND ({interval}[EDAT] OR {interval}[MDAT])'
        job = backfill.job_for(query, journal_id=f"recent:{stamp}:{entry.id}", priority=-10)
        jobs.append(job)
    store.insert("catalog_backfill_jobs", jobs, "job_key")
    store.catalog.set_meta("recent_seeded_through", stamp)
    return jobs


def _record_completed_recent(store):
    groups = {}
    for job in store.read("catalog_backfill_jobs", {}):
        identity = job.get("journal_id", "")
        if identity.startswith("recent:") and job.get("registry_version") == REGISTRY_VERSION:
            groups.setdefault(identity.split(":")[1], []).append(job)
    for stamp in sorted(groups):
        jobs = groups[stamp]
        expected = len(journal_entries())
        if (len({job["journal_id"] for job in jobs}) == expected
                and all(job["status"] in {"done", "split"} for job in jobs)):
            previous = store.catalog.get_meta("recent_completed_through", "")
            if stamp > previous:
                store.catalog.set_meta("recent_completed_through", stamp)


def _process_until(store, deadline, recent):
    while time.monotonic() < deadline:
        store.ensure_capacity()
        job = store.next_job(recent=recent)
        if job is None:
            break
        try:
            backfill.process_job(store, job, deadline,
                search=lambda item: pubmed_search(item, deadline),
                details=lambda ids: pubmed_details(ids, deadline))
        except CatalogDeadlineExpired:
            return
        except backfill.StorageCapacityReached:
            raise
        except Exception as error:
            store.update(job["job_key"], {"status": "error", "error_code": type(error).__name__,
                "retry_after": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()})
            print(f"Local catalog shard {job['job_key'][:10]}: {type(error).__name__}; checkpoint retained", flush=True)


def run_catalog(directory, deadline):
    with phase_lock(directory, "catalog") as acquired:
        if not acquired:
            print("Local catalog is already running", flush=True)
            return {"state": "already_running"}
        with LocalCatalog(directory) as catalog:
            store = LocalStore(catalog)
            state = "idle"
            catalog.set_meta("catalog_started_at", _now())
            try:
                store.ensure_capacity()
                backfill.seed_registry_jobs(store)
                seed_recent_jobs(store)
                remaining = max(0, deadline - time.monotonic())
                recent_deadline = min(deadline, time.monotonic() + min(300, remaining / 3))
                _process_until(store, recent_deadline, recent=True)
                _record_completed_recent(store)
                _process_until(store, deadline, recent=False)
                state = "running" if store.next_job() or store.next_job(recent=True) else "complete"
            except backfill.StorageCapacityReached:
                state = "disk_paused"
                print("Local catalog paused at its disk reserve; saved citations and checkpoints retained", flush=True)
            finally:
                result = {"state": state, "registry_version": REGISTRY_VERSION, **catalog.stats()}
                catalog.set_meta("catalog_status", {**result, "checked_at": _now()})
                print("Local catalog: " + json.dumps(result), flush=True)
            return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--max-seconds", type=int, default=3300)
    args = parser.parse_args()
    if not 60 <= args.max_seconds <= 3600:
        parser.error("Runtime must be 60..3600 seconds")
    run_catalog(args.state_dir, time.monotonic() + args.max_seconds)


if __name__ == "__main__":
    main()
