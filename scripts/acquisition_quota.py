"""Durable, shared download limits with individually settled reservations.

Only explicit initialization creates the ledger. Missing/corrupt state blocks
downloads; restarts never reset usage. Only a recorded, confirmed failed request
can release its own reservation. Legacy or interrupted reservations stay charged.
"""
import argparse
from contextlib import contextmanager, closing
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid
from http.client import IncompleteRead
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

KST = timezone(timedelta(hours=9))
PUBLISHERS = {"springer-nature", "wiley", "elsevier", "jama", "bmj", "wolters-kluwer",
              "brazilian-society-of-urology", "cju-communications", "tech-science-press"}
PREFIXES = {"10.1007": "springer-nature", "10.1038": "springer-nature",
            "10.1186": "springer-nature",
            "10.1002": "wiley", "10.1111": "wiley", "10.1016": "elsevier",
            "10.1001": "jama", "10.1136": "bmj", "10.1097": "wolters-kluwer",
            "10.32604": "tech-science-press"}
_scope = ContextVar("acquisition_publisher_scope", default=())


class AcquisitionDeferred(RuntimeError):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def publisher_for_host(host):
    host = host.lower().rstrip(".")
    for group, domains in {
        "springer-nature": ("springer.com", "nature.com", "springernature.com", "springer-cdn.com"),
        "wiley": ("wiley.com",), "elsevier": ("elsevier.com", "sciencedirect.com", "els-cdn.com"),
        "jama": ("jamanetwork.com",), "bmj": ("bmj.com",),
        "wolters-kluwer": ("lww.com", "wolterskluwer.com"),
    }.items():
        if any(host == domain or host.endswith("." + domain) for domain in domains):
            return group
    return None


def paper_publishers(paper, source_url=""):
    # Prefixes are only additional conservative charging hints. Browser transport
    # also charges the actual destination, including redirects and CDN domains.
    doi = str(paper.get("doi") or "").strip().lower()
    groups = {PREFIXES.get(doi.split("/", 1)[0]), publisher_for_host(urlsplit(source_url).hostname or "")}
    # 10.1590 is shared by many SciELO publishers, so require IBJU's ISSN.
    # Publisher: https://www.scielo.br/j/ibju/
    if re.fullmatch(r"10\.1590/s1677-5538(?:\.|ibju)[.a-z0-9-]+", doi):
        groups.add("brazilian-society-of-urology")
    # CJU moved to Tech Science Press in 2025; legacy articles can lack a DOI.
    # Charge both historical/current publisher buckets conservatively, so an
    # uncertain publication date or archive transfer cannot grant extra quota.
    # https://canjurol.com/ ; https://www.techscience.com/CJU/append
    if str(paper.get("journal") or "").strip().lower() in {
            "the canadian journal of urology", "canadian journal of urology"}:
        groups.update(("cju-communications", "tech-science-press"))
    return sorted(group for group in groups if group)


@contextmanager
def download_scope(paper, source_url=""):
    token = _scope.set(tuple(paper_publishers(paper, source_url)))
    try:
        yield
    finally:
        _scope.reset(token)


def current_publishers():
    return list(_scope.get())


def policy_path():
    return os.environ.get("URO_ACQUISITION_POLICY")


def metadata_url(url):
    u = urlsplit(url)
    return (u.scheme == "https" and not u.username and not u.password and u.port in (None, 443) and (
        (u.hostname == "www.ebi.ac.uk" and u.path == "/europepmc/webservices/rest/search") or
        (u.hostname == "pmc-oa-opendata.s3.amazonaws.com" and
         (u.path == "/" or re.fullmatch(r"/PMC\d+\.\d+/PMC\d+\.\d+\.json", u.path)))))


def groups_for_url(url, expected=()):
    u = urlsplit(url)
    if u.scheme != "https" or u.username or u.password or u.port not in (None, 443):
        raise AcquisitionDeferred("quota_unsupported_source")
    actual = publisher_for_host(u.hostname or "")
    groups = set(expected)
    if not groups.issubset(PUBLISHERS):
        raise AcquisitionDeferred("quota_unknown_publisher")
    if actual:
        groups.add(actual)
    elif u.hostname in {"www.ebi.ac.uk", "europepmc.org", "pmc.ncbi.nlm.nih.gov",
                        "cdn.ncbi.nlm.nih.gov", "www.ncbi.nlm.nih.gov", "pmc-oa-opendata.s3.amazonaws.com"}:
        if not groups:
            raise AcquisitionDeferred("quota_unknown_publisher")
    else:
        raise AcquisitionDeferred("quota_unknown_publisher")
    return sorted(groups)


class Quota:
    def __init__(self, config_path, *, now=None):
        self.config_path = Path(config_path)
        self.now = now or (lambda: datetime.now(timezone.utc))

    def config(self):
        try:
            config = json.loads(self.config_path.read_text(encoding="utf-8"))
            start = datetime.fromisoformat(config["starts_at"])
            if (config.get("version") != 1 or config.get("timezone") != "Asia/Seoul"
                    or start.utcoffset() != timedelta(hours=9)
                    or type(config.get("daily_limit")) is not int or not 1 <= config["daily_limit"] <= 30
                    or type(config.get("manual_reserve", 0)) is not int
                    or not 0 <= config.get("manual_reserve", 0) <= config["daily_limit"]):
                raise ValueError("Invalid policy")
            return config, start
        except (OSError, ValueError, KeyError, TypeError):
            raise AcquisitionDeferred("quota_policy_unavailable") from None

    def _db(self):
        # mode=rw is intentional: losing the ledger must never grant 30 more.
        path = self.config_path.with_name("acquisition-quota.sqlite3").resolve()
        db = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=10)
        try:
            db.execute("PRAGMA synchronous=FULL")
        except sqlite3.Error:
            db.close()
            raise
        return db

    def reserve(self, groups, *, amount=1, manual=False, tracked=False, resource_kind='original'):
        groups = sorted(set(groups))
        if not groups or not set(groups).issubset(PUBLISHERS) or type(amount) is not int or amount < 0:
            raise AcquisitionDeferred("quota_unknown_publisher")
        if tracked and (amount != 1 or manual):
            raise AcquisitionDeferred("quota_invalid_request")
        if resource_kind not in ('original', 'figure', 'table') or (manual and resource_kind != 'original'):
            raise AcquisitionDeferred('quota_invalid_request')
        charged = amount if resource_kind == 'original' else 0
        config, start = self.config()
        now = self.now()
        if now < start or config.get("paused", False):
            raise AcquisitionDeferred("quota_not_started")
        day = now.astimezone(KST).date().isoformat()
        db = None
        try:
            db = self._db()
            db.execute("BEGIN IMMEDIATE")
            last_day = db.execute("SELECT value FROM metadata WHERE key='last_day'").fetchone()
            if last_day is None or day < last_day[0]:
                raise AcquisitionDeferred("quota_clock_rollback")
            if not manual and db.execute("SELECT 1 FROM sqlite_master WHERE name='quota_pauses'").fetchone():
                for group in groups:
                    pause = db.execute("SELECT until FROM quota_pauses WHERE publisher=? AND reason NOT IN ('http_403','publisher_check')", (group,)).fetchone()
                    if pause and pause[0] > now.timestamp():
                        raise AcquisitionDeferred('quota_source_paused')
            rows = {}
            for group in groups:
                row = db.execute("SELECT automatic,manual FROM usage WHERE day=? AND publisher=?", (day, group)).fetchone()
                automatic, used_manual = row or (0, 0)
                # Reserved manual capacity remains available to manual entries.
                used = automatic + (used_manual if manual else max(used_manual, config.get("manual_reserve", 0)))
                if resource_kind == 'original' and used + (amount or 1) > config["daily_limit"]:
                    raise AcquisitionDeferred("quota_daily_limit")
                rows[group] = (automatic, used_manual)
            if amount:
                for group, (automatic, used_manual) in rows.items():
                    db.execute("INSERT OR REPLACE INTO usage VALUES(?,?,?,?)",
                               (day, group, automatic + (0 if manual else charged), used_manual + (charged if manual else 0)))
                db.execute("UPDATE metadata SET value=? WHERE key='last_day'", (day,))
            request_id = None
            if tracked:
                db.execute("""CREATE TABLE IF NOT EXISTS quota_requests(
                    id TEXT PRIMARY KEY,day TEXT NOT NULL,publishers TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('pending','downloaded','failed')),
                    reason TEXT,created_at TEXT NOT NULL,settled_at TEXT)""")
                request_id = uuid.uuid4().hex
                db.execute("INSERT INTO quota_requests VALUES(?,?,?,'pending',NULL,?,NULL)",
                           (request_id, day, json.dumps(groups), now.isoformat()))
                # Side table preserves the seven-column contract used by a
                # previous worker finishing its already reserved requests.
                db.execute('''CREATE TABLE IF NOT EXISTS quota_request_details(
                    id TEXT PRIMARY KEY,resource_kind TEXT NOT NULL,charged INTEGER NOT NULL CHECK(charged IN (0,1)))''')
                db.execute('INSERT INTO quota_request_details VALUES(?,?,?)', (request_id, resource_kind, charged))
            db.commit()
            return {"day": day, "publishers": groups, "charged": charged, "resource_kind": resource_kind, "request_id": request_id}
        except (OSError, sqlite3.Error):
            raise AcquisitionDeferred("quota_ledger_unavailable") from None
        finally:
            if db is not None:
                db.close()

    def settle(self, request_id, *, failed=False, reason=None):
        """Settle once on the original day; pauses do not prevent completion.

        Missing receipts, crashes and parsing failures never imply a refund.
        """
        if not isinstance(request_id, str) or not re.fullmatch(r'[a-f0-9]{32}', request_id):
            raise AcquisitionDeferred('quota_invalid_request')
        if reason is not None and not re.fullmatch(r'[a-z0-9_]{1,60}', reason):
            raise AcquisitionDeferred('quota_invalid_request')
        db = None
        try:
            db = self._db()
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT day,publishers,state FROM quota_requests WHERE id=?', (request_id,)).fetchone()
            if row is None:
                raise AcquisitionDeferred('quota_unknown_request')
            day, encoded, state = row
            if state == 'pending':
                groups = json.loads(encoded)
                if not groups or not set(groups).issubset(PUBLISHERS):
                    raise AcquisitionDeferred('quota_ledger_unavailable')
                if failed:
                    charged = 1  # Legacy receipts remain charged unless individually proven failed.
                    if db.execute("SELECT 1 FROM sqlite_master WHERE name='quota_request_details'").fetchone():
                        detail = db.execute('SELECT charged FROM quota_request_details WHERE id=?', (request_id,)).fetchone()
                        if detail is not None:
                            charged = detail[0]
                    for group in groups:
                        if not charged:
                            continue
                        changed = db.execute('UPDATE usage SET automatic=automatic-? WHERE day=? AND publisher=? AND automatic>=?', (charged, day, group, charged))
                        if changed.rowcount != 1:
                            raise AcquisitionDeferred('quota_ledger_unavailable')
                    if reason in ('http_401', 'http_429'):
                        db.execute('CREATE TABLE IF NOT EXISTS quota_pauses(publisher TEXT PRIMARY KEY,until REAL NOT NULL,reason TEXT NOT NULL)')
                        until = self.now().timestamp() + (3600 if reason == 'http_429' else 86400)
                        for group in groups:
                            db.execute('''INSERT INTO quota_pauses VALUES(?,?,?) ON CONFLICT(publisher)
                                DO UPDATE SET until=CASE WHEN quota_pauses.reason IN ('http_403','publisher_check') THEN excluded.until
                                ELSE max(until,excluded.until) END,reason=excluded.reason''', (group, until, reason))
                state = 'failed' if failed else 'downloaded'
                db.execute('UPDATE quota_requests SET state=?,reason=?,settled_at=? WHERE id=?',
                           (state, reason, self.now().isoformat(), request_id))
            db.commit()
            return {'request_id': request_id, 'state': state, 'day': day}
        except (OSError, sqlite3.Error, ValueError, TypeError):
            raise AcquisitionDeferred('quota_ledger_unavailable') from None
        finally:
            if db is not None:
                db.close()

    def pause(self, groups, reason):
        """Persist a terminal browser denial after a bounded automatic check."""
        groups = sorted(set(groups))
        if not groups or not set(groups).issubset(PUBLISHERS) or reason not in ('http_401', 'http_403', 'http_429', 'publisher_check', 'authentication_required'):
            raise AcquisitionDeferred('quota_invalid_request')
        # Older callers can report a bare 403, but it must not pause other papers.
        if reason in ('http_403', 'publisher_check'):
            return {'paused': [], 'reason': reason}
        try:
            with closing(self._db()) as db, db:
                db.execute('CREATE TABLE IF NOT EXISTS quota_pauses(publisher TEXT PRIMARY KEY,until REAL NOT NULL,reason TEXT NOT NULL)')
                until = self.now().timestamp() + (3600 if reason == 'http_429' else 86400)
                for group in groups:
                    db.execute('''INSERT INTO quota_pauses VALUES(?,?,?) ON CONFLICT(publisher)
                        DO UPDATE SET until=CASE WHEN quota_pauses.reason IN ('http_403','publisher_check') THEN excluded.until
                                ELSE max(until,excluded.until) END,reason=excluded.reason''', (group, until, reason))
            return {'paused': groups, 'reason': reason}
        except (OSError, sqlite3.Error):
            raise AcquisitionDeferred('quota_ledger_unavailable') from None

    def active(self):
        config, start = self.config()
        if self.now() < start or config.get("paused", False):
            raise AcquisitionDeferred("quota_not_started")

    def status(self):
        config, _ = self.config()
        day = self.now().astimezone(KST).date().isoformat()
        try:
            with closing(self._db()) as db:
                rows = dict((group, (automatic, manual)) for group, automatic, manual in
                            db.execute("SELECT publisher,automatic,manual FROM usage WHERE day=?", (day,)))
            return {"day": day, **config, "publishers": {
                group: {"automatic": rows.get(group, (0, 0))[0], "manual": rows.get(group, (0, 0))[1],
                        "remaining": max(0, config["daily_limit"] - rows.get(group, (0, 0))[0]
                                         - max(config.get("manual_reserve", 0), rows.get(group, (0, 0))[1]))}
                for group in sorted(PUBLISHERS)}}
        except (OSError, sqlite3.Error):
            raise AcquisitionDeferred("quota_ledger_unavailable") from None


def before_download(url):
    selected = policy_path()
    if not selected or metadata_url(url):
        return
    Quota(selected).reserve(groups_for_url(url, current_publishers()))


@contextmanager
def download_request(url, *, resource_kind='original'):
    """Reserve before I/O; release only confirmed HTTP/transport failures."""
    selected = policy_path()
    quota, reservation = None, None
    if selected and not metadata_url(url):
        quota = Quota(selected)
        reservation = quota.reserve(groups_for_url(url, current_publishers()), tracked=True, resource_kind=resource_kind)
    try:
        yield
    except (HTTPError, URLError, OSError, IncompleteRead) as error:
        if reservation:
            reason = 'http_' + str(error.code) if isinstance(error, HTTPError) else 'transport_error'
            quota.settle(reservation['request_id'], failed=True, reason=reason)
        raise
    else:
        if reservation:
            quota.settle(reservation['request_id'])


def preflight(paper):
    selected = policy_path()
    if not selected:
        return
    quota = Quota(selected)
    quota.active()
    groups = paper_publishers(paper)
    if groups:
        quota.reserve(groups, amount=0)


def initialize(config_path):
    """Operator-only setup; deliberately refuse to overwrite a previous ledger."""
    quota = Quota(config_path)
    quota.config()
    path = Path(config_path).with_name("acquisition-quota.sqlite3")
    with path.open("xb"):
        pass
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        db.execute("INSERT INTO metadata VALUES('last_day','')")
        db.execute("CREATE TABLE usage(day TEXT NOT NULL,publisher TEXT NOT NULL,automatic INTEGER NOT NULL CHECK(automatic>=0),"
                   "manual INTEGER NOT NULL CHECK(manual>=0),PRIMARY KEY(day,publisher))")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", required=True)
    parser.add_argument("action", choices=("initialize", "status", "reserve", "begin", "downloaded", "failed", "check", "manual", "pause"))
    parser.add_argument("--url", default="")
    parser.add_argument("--publishers", default="")
    parser.add_argument("--doi", default="")
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--request-id")
    parser.add_argument("--reason")
    parser.add_argument('--resource-kind', choices=('original', 'figure', 'table'), default='original')
    args = parser.parse_args()
    quota = Quota(args.policy)
    try:
        if args.action == "initialize":
            initialize(args.policy)
            result = {"initialized": True}
        elif args.action == "status":
            result = quota.status()
        elif args.action in ('downloaded', 'failed'):
            result = quota.settle(args.request_id, failed=args.action == 'failed', reason=args.reason)
        else:
            groups = [g for g in args.publishers.split(",") if g]
            groups = sorted(set(groups + paper_publishers({"doi": args.doi})))
            if args.url:
                groups = groups_for_url(args.url, groups)
            if args.action == 'pause':
                result = quota.pause(groups, args.reason)
            elif args.action == "check" and not groups:
                quota.active()
                result = {"charged": 0}
            else:
                result = quota.reserve(groups, amount=0 if args.action == "check" else args.count,
                                       manual=args.action == "manual", tracked=args.action == "begin", resource_kind=args.resource_kind)
        print(json.dumps({"ok": True, **result}))
    except AcquisitionDeferred as error:
        print(json.dumps({"ok": False, "reason": error.reason}))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
