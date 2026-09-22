"""Durable local citation inventory and metadata-only publication outbox.

Original bodies belong in the document archive, never in this database or its
publication payloads. SQLite commits are independent of cloud availability.
"""
from datetime import datetime, timezone
from contextlib import contextmanager
import json
from pathlib import Path
import shutil
import sqlite3
import time

from catalog_policy import automatic_paper

CITATION_FIELDS = (
    "pmid", "title", "abstract", "authors", "journal", "pub_date", "mesh_terms",
    "keywords", "doi", "paper_type", "pub_types", "study_type", "volume", "issue",
    "pages", "publication_types", "integrity_status", "related_notices",
    "integrity_checked_at",
)
REMOTE_FIELDS = ("id", "fulltext_available", "summary_basis", "summary_source_hash",
                 "summarized_at", "summary_model", "summary_ko", "structured_data",
                 "qa_data", "evidence", "research_details", "clinical_relevance")
SUMMARY_FIELDS = ("summary_ko", "structured_data", "clinical_relevance", "qa_data",
                  "summary_model", "summary_source_hash", "evidence", "research_details")
RAW_FIELDS = {"content_text", "full_text", "fulltext", "raw_body", "body", "html",
              "pdf", "document", "sections", "raw_response", "p_token", "token",
              "api_key", "p_worker_id"}
DEFAULT_RESERVE_BYTES = 5 * 1024**3


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _pmid(value):
    value = str(value)
    if not value.isdigit() or int(value) <= 0:
        raise ValueError("Invalid PMID")
    return value


def _no_raw(value):
    if isinstance(value, dict):
        if set(value) & RAW_FIELDS:
            raise ValueError("Only citation or derived metadata may be staged")
        for item in value.values():
            _no_raw(item)
    elif isinstance(value, list):
        for item in value:
            _no_raw(item)


def _publication(kind, payload):
    if kind not in {"original", "summary"}:
        raise ValueError("Unsupported outbox kind")
    required = {"p_pmid", "p_doi", "p_title", "p_source"}
    if kind == "summary":
        required.add("p_summary")
    if not isinstance(payload, dict) or set(payload) != required:
        raise ValueError("Invalid publication fields")
    _pmid(payload["p_pmid"])
    source_fields = {"content_hash", "characters", "section_count", "source_url"}
    if kind == "original":
        source_fields.add("summary_source_hash")
    if not isinstance(payload["p_source"], dict) or set(payload["p_source"]) != source_fields:
        raise ValueError("Only acquisition metadata may be staged")
    if kind == "summary":
        summary = payload["p_summary"]
        base = set(SUMMARY_FIELDS) - {"evidence", "research_details"}
        if not isinstance(summary, dict) or set(summary) not in (base, set(SUMMARY_FIELDS)):
            raise ValueError("Only derived summary fields may be staged")
        if "evidence" in summary:
            from evidence import validate_metadata
            validate_metadata(summary["evidence"], summary["research_details"])
    _no_raw(payload)
    return _json(payload)


class LocalCatalog:
    def __init__(self, directory, *, reserve_bytes=DEFAULT_RESERVE_BYTES):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.reserve_bytes = max(0, int(reserve_bytes))
        self.db = sqlite3.connect(self.directory / "catalog.sqlite3", timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA busy_timeout=30000")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS catalog_papers(
                pmid TEXT PRIMARY KEY, citation TEXT NOT NULL, version INTEGER NOT NULL,
                synced_version INTEGER NOT NULL DEFAULT 0, remote_state TEXT NOT NULL DEFAULT '{}',
                local_state TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS catalog_outbox(
                pmid TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
                version INTEGER NOT NULL, pending INTEGER NOT NULL DEFAULT 1,
                next_retry REAL NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL,
                PRIMARY KEY(pmid,kind));
            CREATE TABLE IF NOT EXISTS catalog_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS catalog_jobs(job_key TEXT PRIMARY KEY,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS catalog_citation_retry(
                pmid TEXT PRIMARY KEY,version INTEGER NOT NULL,next_retry REAL NOT NULL,error TEXT);
            CREATE INDEX IF NOT EXISTS catalog_outbox_ready
                ON catalog_outbox(kind,updated_at,pmid) WHERE pending=1;
            CREATE INDEX IF NOT EXISTS catalog_pending_citations
                ON catalog_papers(updated_at,pmid) WHERE version!=synced_version;
        """)
        self.db.commit()

    def close(self):
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    @contextmanager
    def _write(self):
        # Serialize read-modify-write revisions across independent local phases.
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.db.rollback()
            raise
        else:
            self.db.commit()

    def ensure_capacity(self):
        if shutil.disk_usage(self.directory).free < self.reserve_bytes:
            from catalog_backfill import StorageCapacityReached
            raise StorageCapacityReached("Local disk reserve reached; checkpoints retained")

    def upsert_papers(self, rows, synced=False):
        """Persist one atomic page; cloud pulls never overwrite a pending local revision."""
        self.ensure_capacity()
        changes = 0
        with self._write():
            for paper in rows:
                if not isinstance(paper, dict) or set(paper) - set(CITATION_FIELDS) - set(REMOTE_FIELDS):
                    raise ValueError("Unexpected citation fields")
                citation = {key: paper[key] for key in CITATION_FIELDS if key in paper and paper[key] is not None}
                citation["pmid"] = pmid = _pmid(citation.get("pmid"))
                if not isinstance(citation.get("title"), str) or not citation["title"].strip():
                    raise ValueError("Citation title required")
                if not automatic_paper(citation):
                    continue
                prior = self.db.execute("SELECT * FROM catalog_papers WHERE pmid=?", (pmid,)).fetchone()
                remote = json.loads(prior["remote_state"]) if prior else {}
                local = json.loads(prior["local_state"]) if prior else {}
                old = json.loads(prior["citation"]) if prior else {}
                if synced:
                    remote.update({key: paper[key] for key in REMOTE_FIELDS if key in paper})
                pending = prior is not None and prior["version"] != prior["synced_version"]
                merged = old if synced and pending else {**old, **citation}
                # PubMed parsing stamps every response. A repeated check alone
                # must not enqueue an unchanged citation or bloat cloud storage.
                if old and {k: v for k, v in merged.items() if k != "integrity_checked_at"} == {
                        k: v for k, v in old.items() if k != "integrity_checked_at"}:
                    merged = dict(merged)
                    if "integrity_checked_at" in old:
                        merged["integrity_checked_at"] = old["integrity_checked_at"]
                    else:
                        merged.pop("integrity_checked_at", None)
                changed = merged != old
                version = (prior["version"] if prior else 0) + int(changed)
                synced_version = prior["synced_version"] if prior else 0
                if synced and not pending:
                    synced_version = version
                if changed and old and any(merged.get(k) != old.get(k) for k in ("title", "doi")):
                    local.update(fulltext_available=False, acquired_source_hash=None,
                                 summary_model=None, summary_source_hash=None, summarized_at=None,
                                 local_original=False, local_summary=False)
                    self.db.execute("""UPDATE catalog_outbox SET next_retry=?,error='local_identity_changed'
                        WHERE pmid=? AND pending=1""", (time.time() + 365 * 86400, pmid))
                self.db.execute("""INSERT INTO catalog_papers VALUES(?,?,?,?,?,?,?)
                    ON CONFLICT(pmid) DO UPDATE SET citation=excluded.citation,version=excluded.version,
                    synced_version=excluded.synced_version,remote_state=excluded.remote_state,
                    local_state=excluded.local_state,updated_at=excluded.updated_at""",
                    (pmid, _json(merged), version, synced_version, _json(remote), _json(local), _now()))
                changes += int(changed)
        return changes

    @staticmethod
    def _candidate(row):
        return {**json.loads(row["citation"]), **json.loads(row["remote_state"]),
                **json.loads(row["local_state"])}

    def candidates(self, pmid=None, include_summary=False):
        query = "SELECT * FROM catalog_papers"
        params = ()
        if pmid is not None:
            query += " WHERE pmid=?"
            params = (_pmid(pmid),)
        rows = [self._candidate(row) for row in self.db.execute(query, params)]
        rows = [row for row in rows if automatic_paper(row)
                and (not include_summary or row.get("fulltext_available"))]
        rows.sort(key=lambda row: (row.get("pub_date") or "", row["pmid"]), reverse=True)
        return rows

    def get_papers(self, pmids):
        ids = list(dict.fromkeys(_pmid(pmid) for pmid in pmids))
        result = []
        for start in range(0, len(ids), 200):
            batch = ids[start:start + 200]
            placeholders = ",".join("?" for _ in batch)
            result.extend(self._candidate(row) for row in self.db.execute(
                f"SELECT * FROM catalog_papers WHERE pmid IN ({placeholders})", batch))
        return result

    def worker_candidates(self, pmid=None, include_summary=False):
        """Project only worker fields in SQLite, avoiding full abstracts in memory."""
        fields = ("id", "pmid", "doi", "title", "pub_date", "paper_type", "fulltext_available",
                  "summary_basis", "summary_source_hash", "summarized_at", "summary_model",
                  "summary_ko", "structured_data", "qa_data", "acquired_source_hash")
        columns = []
        for field in fields:
            path = "$." + field
            columns.append(f"CASE WHEN json_type(local_state,'{path}') IS NOT NULL THEN json_extract(local_state,'{path}') "
                           f"WHEN json_type(remote_state,'{path}') IS NOT NULL THEN json_extract(remote_state,'{path}') "
                           f"ELSE json_extract(citation,'{path}') END AS {field}")
        query = "SELECT " + ",".join(columns) + " FROM catalog_papers"
        params = ()
        if pmid is not None:
            query += " WHERE pmid=?"
            params = (_pmid(pmid),)
        rows = []
        for raw in self.db.execute(query, params):
            row = dict(raw)
            if row.get("fulltext_available") is not None:
                row["fulltext_available"] = bool(row["fulltext_available"])
            if not automatic_paper(row) or (include_summary and not row.get("fulltext_available")):
                continue
            for field in ("structured_data", "qa_data"):
                if isinstance(row[field], str):
                    try:
                        row[field] = json.loads(row[field])
                    except ValueError:
                        pass
            rows.append(row)
        rows.sort(key=lambda row: (row.get("pub_date") or "", row["pmid"]), reverse=True)
        return rows

    def pending_citations(self, limit=50):
        rows = self.db.execute("""SELECT p.* FROM catalog_papers p LEFT JOIN catalog_citation_retry r
            ON r.pmid=p.pmid AND r.version=p.version WHERE p.version != p.synced_version
            AND (r.next_retry IS NULL OR r.next_retry<=?)
            ORDER BY CASE WHEN json_extract(p.remote_state,'$.id') IS NULL THEN 1 ELSE 0 END,
            p.updated_at,p.pmid LIMIT ?""", (time.time(), max(0, int(limit))))
        return [{"paper": json.loads(row["citation"]), "version": row["version"]} for row in rows]

    def citation_is_synced(self, pmid):
        row = self.db.execute("SELECT version,synced_version FROM catalog_papers WHERE pmid=?", (_pmid(pmid),)).fetchone()
        return bool(row and row["version"] == row["synced_version"])

    def ack_citation(self, pmid, version, remote_id=None):
        with self._write():
            row = self.db.execute("SELECT * FROM catalog_papers WHERE pmid=? AND version=?", (_pmid(pmid), version)).fetchone()
            if row is None:
                return False
            remote = json.loads(row["remote_state"])
            if remote_id is not None:
                remote["id"] = remote_id
            self.db.execute("UPDATE catalog_papers SET synced_version=version,remote_state=? WHERE pmid=? AND version=?",
                            (_json(remote), str(pmid), version))
            self.db.execute("DELETE FROM catalog_citation_retry WHERE pmid=?", (str(pmid),))
            self.db.execute("UPDATE catalog_outbox SET next_retry=0,error=NULL WHERE pmid=? AND pending=1 AND error='citation_pending'", (str(pmid),))
            return True

    def defer_citation(self, pmid, version, retry_after, error):
        pmid = _pmid(pmid)
        with self._write():
            row = self.db.execute("SELECT 1 FROM catalog_papers WHERE pmid=? AND version=? AND version!=synced_version",
                                  (pmid, version)).fetchone()
            if row is None:
                return False
            self.db.execute("""INSERT INTO catalog_citation_retry VALUES(?,?,?,?) ON CONFLICT(pmid)
                DO UPDATE SET version=excluded.version,next_retry=excluded.next_retry,error=excluded.error""",
                (pmid, version, float(retry_after), str(error)[:160]))
            return True

    def enqueue(self, kind, payload):
        encoded = _publication(kind, payload)
        self.ensure_capacity()
        pmid = _pmid(payload["p_pmid"])
        with self._write():
            row = self.db.execute("SELECT * FROM catalog_papers WHERE pmid=?", (pmid,)).fetchone()
            if row is None:
                raise ValueError("Citation must be stored before publication")
            citation = json.loads(row["citation"])
            if (payload["p_title"] != citation["title"] or
                    (payload.get("p_doi") or "").lower() != (citation.get("doi") or "").lower()):
                raise ValueError("Publication identity differs from local citation")
            prior = self.db.execute("SELECT * FROM catalog_outbox WHERE pmid=? AND kind=?", (pmid, kind)).fetchone()
            # Identical retries remain one durable event; a deferred rejected event
            # becomes eligible after explicit regeneration enqueues it again.
            version = (prior["version"] if prior else 0) + 1
            self.db.execute("""INSERT INTO catalog_outbox VALUES(?,?,?,?,1,0,NULL,?)
                ON CONFLICT(pmid,kind) DO UPDATE SET payload=excluded.payload,version=excluded.version,
                pending=1,next_retry=0,error=NULL,updated_at=excluded.updated_at""",
                (pmid, kind, encoded, version, _now()))
            local = json.loads(row["local_state"])
            if kind == "original":
                source_hash = payload["p_source"]["summary_source_hash"]
                if local.get("summary_source_hash") != source_hash:
                    local.update(summary_model=None, summary_source_hash=None, summarized_at=None, local_summary=False)
                    self.db.execute("""UPDATE catalog_outbox SET next_retry=?,error='local_source_changed'
                        WHERE pmid=? AND kind='summary' AND pending=1
                        AND json_extract(payload,'$.p_summary.summary_source_hash') != ?""",
                        (time.time() + 365 * 86400, pmid, source_hash))
                local.update(fulltext_available=True, acquired_source_hash=source_hash,
                             local_original=True, acquired_at=_now())
            else:
                source_hash = payload["p_summary"]["summary_source_hash"]
                if local.get("acquired_source_hash") and local["acquired_source_hash"] != source_hash:
                    raise ValueError("Summary does not match local acquired original")
                local.update(payload["p_summary"])
                local.update(fulltext_available=True, summary_basis="fulltext", summarized_at=_now(),
                             acquired_source_hash=source_hash, local_original=True, local_summary=True)
            self.db.execute("UPDATE catalog_papers SET local_state=? WHERE pmid=?", (_json(local), pmid))
            return version

    def observe_local_source(self, pmid, source_hash, *, expected_title=None, expected_doi=None):
        """Index a caller-verified legacy original without manufacturing a cloud receipt."""
        pmid = _pmid(pmid)
        if not isinstance(source_hash, str) or len(source_hash) != 64:
            raise ValueError("A verified source hash is required")
        with self._write():
            row = self.db.execute("SELECT citation,local_state FROM catalog_papers WHERE pmid=?", (pmid,)).fetchone()
            if row is None:
                raise ValueError("Unknown local citation")
            citation = json.loads(row["citation"])
            if expected_title is not None and (citation.get("title") != expected_title or
                    (citation.get("doi") or "").lower() != (expected_doi or "").lower()):
                return False
            local = json.loads(row["local_state"])
            if local.get("acquired_source_hash") not in (None, source_hash):
                local.update(summary_model=None, summary_source_hash=None, summarized_at=None, local_summary=False)
            self.db.execute("""UPDATE catalog_outbox SET next_retry=?,error='local_source_changed'
                WHERE pmid=? AND pending=1 AND (CASE kind WHEN 'original'
                THEN json_extract(payload,'$.p_source.summary_source_hash')
                ELSE json_extract(payload,'$.p_summary.summary_source_hash') END) != ?""",
                (time.time() + 365 * 86400, pmid, source_hash))
            local.update(fulltext_available=True, acquired_source_hash=source_hash, local_original=True)
            self.db.execute("UPDATE catalog_papers SET local_state=? WHERE pmid=?", (_json(local), pmid))
            return True

    def observe_local_summary(self, pmid, summary, *, expected_title=None, expected_doi=None):
        """Index caller-validated legacy derived fields; this does not acknowledge an outbox."""
        pmid = _pmid(pmid)
        if not isinstance(summary, dict) or set(summary) - set(SUMMARY_FIELDS):
            raise ValueError("Only derived summary fields may be observed")
        _no_raw(summary)
        with self._write():
            row = self.db.execute("SELECT citation,local_state FROM catalog_papers WHERE pmid=?", (pmid,)).fetchone()
            if row is None:
                raise ValueError("Unknown local citation")
            citation = json.loads(row["citation"])
            if expected_title is not None and (citation.get("title") != expected_title or
                    (citation.get("doi") or "").lower() != (expected_doi or "").lower()):
                return False
            local = json.loads(row["local_state"])
            if not local.get("acquired_source_hash") or summary.get("summary_source_hash") != local["acquired_source_hash"]:
                raise ValueError("Summary does not match verified local original")
            pending = self.db.execute("SELECT 1 FROM catalog_outbox WHERE pmid=? AND kind='summary' AND pending=1", (pmid,)).fetchone()
            if pending:
                return False
            local.update(summary)
            local.update(local_summary=True, summary_basis="fulltext", summarized_at=_now())
            self.db.execute("UPDATE catalog_papers SET local_state=? WHERE pmid=?", (_json(local), pmid))
            return True

    def outbox_batch(self, limit=50):
        rows = self.db.execute("""SELECT pmid,kind,payload,version FROM (
            SELECT *,row_number() OVER(PARTITION BY kind ORDER BY next_retry,updated_at,pmid) position
            FROM catalog_outbox WHERE pending=1 AND next_retry<=?)
            ORDER BY position,CASE kind WHEN 'original' THEN 0 ELSE 1 END LIMIT ?""",
            (time.time(), max(0, int(limit))))
        return [{"pmid": row["pmid"], "kind": row["kind"], "payload": json.loads(row["payload"]),
                 "version": row["version"]} for row in rows]

    def has_pending_event(self, pmid, kind):
        return self.db.execute("SELECT 1 FROM catalog_outbox WHERE pmid=? AND kind=? AND pending=1",
                               (_pmid(pmid), kind)).fetchone() is not None

    def ready_outbox_batch(self, limit=50):
        """Reserve room for new completions, old backlog and summary prerequisites.

        Blocked citations/summaries do not consume the bounded publication batch.
        All reads are metadata-only; no document archive scan is required.
        """
        limit = max(0, int(limit))
        if not limit:
            return []
        now = time.time()
        eligible = """FROM catalog_outbox o JOIN catalog_papers p ON p.pmid=o.pmid
            WHERE o.pending=1 AND o.next_retry<=? AND p.version=p.synced_version
            AND o.kind=? AND (o.kind='original' OR NOT EXISTS (
                SELECT 1 FROM catalog_outbox parent WHERE parent.pmid=o.pmid
                AND parent.kind='original' AND parent.pending=1))"""
        selected = {}
        def take(kind, order, count, extra="", extra_params=()):
            rows = self.db.execute("SELECT o.pmid,o.kind,o.payload,o.version " + eligible + extra
                + " ORDER BY " + order + " LIMIT ?", (now, kind, *extra_params, count))
            for row in rows:
                if len(selected) >= limit:
                    break
                selected.setdefault((row['pmid'], row['kind']), {
                    'pmid': row['pmid'], 'kind': row['kind'],
                    'payload': json.loads(row['payload']), 'version': row['version']})
        quota = max(1, limit // 5)
        # A freshly completed summary need not wait for the entire original backlog.
        take('original', 'o.updated_at,o.pmid', quota, """ AND EXISTS (
            SELECT 1 FROM catalog_outbox child WHERE child.pmid=o.pmid
            AND child.kind='summary' AND child.pending=1
            AND (child.next_retry<=? OR child.error='original_pending'))""", (now,))
        for kind in ('summary', 'original'):
            take(kind, 'o.updated_at DESC,o.pmid', quota)
            take(kind, 'o.updated_at,o.pmid', quota)
        for kind in ('summary', 'original'):
            take(kind, 'o.updated_at,o.pmid', limit)
        return list(selected.values())

    def ack_outbox(self, pmid, kind, version):
        with self._write():
            cursor = self.db.execute("""UPDATE catalog_outbox SET pending=0,next_retry=0,error=NULL
                WHERE pmid=? AND kind=? AND version=? AND pending=1""", (_pmid(pmid), kind, version))
            if cursor.rowcount and kind == 'original':
                self.db.execute("UPDATE catalog_outbox SET next_retry=0,error=NULL WHERE pmid=? AND kind='summary' AND pending=1 AND error='original_pending'", (str(pmid),))
            return bool(cursor.rowcount)

    def defer_outbox(self, pmid, kind, version, retry_after, error):
        with self._write():
            cursor = self.db.execute("""UPDATE catalog_outbox SET next_retry=?,error=?
                WHERE pmid=? AND kind=? AND version=? AND pending=1""",
                (float(retry_after), str(error)[:160], _pmid(pmid), kind, version))
            return bool(cursor.rowcount)

    def invalidate_summary(self, pmid, version):
        with self._write():
            event = self.db.execute("SELECT version FROM catalog_outbox WHERE pmid=? AND kind='summary' AND version=? AND pending=1",
                                    (_pmid(pmid), version)).fetchone()
            row = self.db.execute("SELECT local_state FROM catalog_papers WHERE pmid=?", (str(pmid),)).fetchone()
            if event is None or row is None:
                return False
            local = json.loads(row["local_state"])
            local.update(summary_model=None, summary_source_hash=None, summarized_at=None, local_summary=False)
            self.db.execute("UPDATE catalog_papers SET local_state=? WHERE pmid=?", (_json(local), str(pmid)))
            return True

    def get_meta(self, key, default=None):
        row = self.db.execute("SELECT value FROM catalog_meta WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set_meta(self, key, value):
        with self._write():
            self.db.execute("INSERT INTO catalog_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                            (str(key), _json(value)))

    def stats(self):
        result = dict(self.db.execute("""SELECT count(*) local_papers,
            coalesce(sum(version=synced_version),0) synced_papers,
            coalesce(sum(version!=synced_version),0) citation_pending,
            coalesce(sum(json_extract(local_state,'$.local_original')=1),0) local_originals,
            coalesce(sum(json_extract(local_state,'$.local_summary')=1
              AND json_extract(local_state,'$.summary_source_hash')=json_extract(local_state,'$.acquired_source_hash')
              AND json_extract(local_state,'$.summarized_at') IS NOT NULL),0) local_summaries
            FROM catalog_papers""").fetchone())
        for kind in ("original", "summary"):
            name = "pending_originals" if kind == "original" else "pending_summaries"
            result[name] = self.db.execute("SELECT count(*) FROM catalog_outbox WHERE kind=? AND pending=1", (kind,)).fetchone()[0]
        return result
