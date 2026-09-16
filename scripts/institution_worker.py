"""Independent local collection and summary workers, using authorized sources."""
import argparse
import ctypes
import hashlib
from http.client import IncompleteRead
import json
import os
from pathlib import Path
import re
import queue
import secrets
import sqlite3
import ssl
import subprocess
import sys
import time
import threading
import uuid
from difflib import SequenceMatcher
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPSHandler

from fulltext import FulltextUnavailable, NoRedirect, fetch_oa, parse_document
from evidence import validate_metadata
from local_summary import MODEL_LABEL, SummaryBudgetExpired, ensure_server, generate_summary, summary_payload, literature_inference_scope
from catalog_policy import AUTOMATIC_START_DATE
from summary_queue import SummaryPublicationRejected

SERVICE_URL = "https://vwdcqzcoovczmtzdyzbc.supabase.co"
PUBLIC_KEY = "sb_publishable_FwZC-M2lO2nvh3MFbqf6nA_K8jMXNdw"
STATES = {"access_required", "challenge", "unsupported", "parse_failed", "retryable_error"}


def protect(data, decrypt=False):
    """Windows DPAPI, bound to this signed-in user, for this worker's own token."""
    if os.name != "nt":
        raise RuntimeError("Worker credential storage requires Windows")
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    buf = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    operation = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    operation.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    operation.restype = wintypes.BOOL
    if not operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        free = ctypes.WinDLL("kernel32").LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        free(output.data)


def enroll(directory):
    directory.mkdir(parents=True, exist_ok=True)
    config_path, token_path = directory / "worker.json", directory / "worker-token.dpapi"
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding="utf-8"))
        token = protect(token_path.read_bytes(), decrypt=True).decode()
    else:
        token = secrets.token_urlsafe(48)
        config = {"id": str(uuid.uuid4()), "url": SERVICE_URL, "public_key": PUBLIC_KEY}
        token_path.write_bytes(protect(token.encode()))
        config_path.write_text(json.dumps(config), encoding="utf-8")
    return {"worker_id": config["id"], "token_hash": hashlib.sha256(token.encode()).hexdigest()}


class Service:
    def __init__(self, directory):
        self.config = json.loads((directory / "worker.json").read_text(encoding="utf-8"))
        self.token = protect((directory / "worker-token.dpapi").read_bytes(), decrypt=True).decode()
        self.opener = build_opener(HTTPSHandler(context=ssl.create_default_context()), NoRedirect())

    def request(self, path, data=None, params=None):
        url = self.config["url"] + "/rest/v1/" + path
        if params:
            url += "?" + urlencode(params)
        payload = None if data is None else json.dumps(data, ensure_ascii=False).encode()
        deadline = getattr(self, "research_deadline", None) if path in {
            "rpc/claim_research_extractions", "rpc/finish_research_extraction", "rpc/fail_research_extraction"} else None
        if path in ("papers", "rpc/publish_institution_summary", "rpc/institution_worker_status"):
            deadline = getattr(self, "summary_deadline", None)
        for attempt in range(4):
            remaining = 45 if deadline is None else min(45, deadline - time.monotonic())
            if remaining < 1:
                raise TimeoutError("Research service request budget expired")
            try:
                request = Request(url, data=payload, headers={"apikey": self.config["public_key"],
                    "Content-Type": "application/json", "Accept": "application/json"})
                with self.opener.open(request, timeout=remaining) as response:
                    content = response.read(2 * 1024 * 1024)
                return json.loads(content) if content else None
            except HTTPError as error:
                if path in ("rpc/finish_research_extraction", "rpc/fail_research_extraction") and error.code in (403, 409):
                    from research_extraction import ResearchLeaseSuperseded
                    raise ResearchLeaseSuperseded("Research extraction lease or source changed") from None
                if path=="rpc/publish_institution_summary" and error.code in (400,409,422):
                    raise SummaryPublicationRejected("Summary publication requires revalidation") from None
                if error.code not in (408,429,500,502,503,504,520,522,524):
                    raise RuntimeError(f"Service HTTP {error.code}") from None
            except ssl.SSLCertVerificationError:
                raise RuntimeError("Service certificate verification failed") from None
            except (URLError, TimeoutError, IncompleteRead, ConnectionError, ssl.SSLError):
                pass
            if attempt < 3:
                pause = 2 ** (attempt + 1)
                if deadline is not None and deadline - time.monotonic() <= pause + 1:
                    raise TimeoutError("Research service retry budget expired")
                time.sleep(pause)
        raise RuntimeError("Service temporarily unavailable")

    def rpc(self, name, **values):
        allowed={"institution_worker_status","publish_institution_summary","institution_cloud_archive","confirm_local_fulltext_archive","register_institution_original",
                 "claim_research_extractions","finish_research_extraction","fail_research_extraction"}
        if name not in allowed:
            raise ValueError("Unsupported worker RPC")
        if name in {"claim_research_extractions","finish_research_extraction","fail_research_extraction"}:
            from research_extraction import validate_rpc, validate_job
            validate_rpc(name, values)
            result = self.request("rpc/" + name, {"p_worker_id": self.config["id"], "p_token": self.token, **values})
            if name == "claim_research_extractions":
                if not isinstance(result, list) or len(result) > values["p_limit"]:
                    raise ValueError("Invalid research claim result")
                for job in result:
                    validate_job(job)
            elif name == "finish_research_extraction" and result is not True:
                raise ValueError("Research completion not confirmed")
            elif name == "fail_research_extraction" and result is not None:
                raise ValueError("Invalid research failure receipt")
            return result
        if name=="register_institution_original" and (
                set(values)!={"p_pmid","p_doi","p_title","p_source"}
                or set(values["p_source"])!={"content_hash","summary_source_hash","characters","section_count","source_url"}):
            raise ValueError("Only acquisition metadata may be published")
        if name=="publish_institution_summary":
            if (set(values)!={"p_pmid","p_doi","p_title","p_source","p_summary"}
                    or set(values["p_source"])!={"content_hash","characters","section_count","source_url"}
                    or set(values["p_summary"]) not in ({"summary_ko","structured_data","clinical_relevance","qa_data","summary_model","summary_source_hash"},{"summary_ko","structured_data","clinical_relevance","qa_data","summary_model","summary_source_hash","evidence","research_details"})):
                raise ValueError("Only derived summary fields may be published")
        if name=="publish_institution_summary" and "evidence" in values["p_summary"]:
            validate_metadata(values["p_summary"]["evidence"],values["p_summary"].get("research_details"))
        return self.request("rpc/" + name, {"p_worker_id": self.config["id"], "p_token": self.token, **values})

    def status(self, state, pmid=None, status=None):
        self.rpc("institution_worker_status", p_state=state, p_pmid=pmid, p_status=status)

    def register_original(self, paper, document):
        body=document["content_text"]
        self.rpc("register_institution_original",p_pmid=str(paper["pmid"]),p_doi=paper.get("doi"),p_title=paper["title"],
            p_source={"content_hash":document["content_hash"],"characters":len(body),
                "section_count":len(document["sections"]),"source_url":document["source_url"],
                "summary_source_hash":hashlib.sha256(("fulltext\n"+paper["title"]+"\n"+body).encode()).hexdigest()})

    def candidates(self, pmid=None, include_summary=False):
        rows = []
        last_id = 0
        selected = "id,pmid,doi,title,pub_date,paper_type,fulltext_available"
        if include_summary:
            selected += ",summary_basis,summary_source_hash,summarized_at,summary_model,summary_ko"
        while True:
            page = self.request("papers", params={"select":selected,
                **({"pmid":"eq."+pmid} if pmid else {"pub_date":"gte."+AUTOMATIC_START_DATE}),
                **({"fulltext_available":"eq.true"} if include_summary and not pmid else {}),
                "or":f"(fulltext_available.eq.false,summary_source_hash.is.null,summarized_at.is.null,summary_model.is.null,summary_model.neq.{MODEL_LABEL},structured_data.is.null,qa_data.is.null)", "order":"id.asc",
                "id":f"gt.{last_id}", "limit":1000})
            rows.extend(page)
            if len(page) < 1000:
                rows.sort(key=lambda paper: paper.get("pub_date") or "", reverse=True)
                return rows
            next_id = page[-1].get("id")
            if not isinstance(next_id, int) or next_id <= last_id:
                raise ValueError("Candidate cursor did not advance")
            last_id = next_id

    def automatic_figure_pmids(self, pmids):
        allowed=set()
        for start in range(0,len(pmids),100):
            rows=self.request('papers',params={'select':'pmid','pub_date':'gte.'+AUTOMATIC_START_DATE,
                'pmid':'in.('+','.join(pmids[start:start+100])+')','limit':100})
            allowed.update(str(row['pmid']) for row in rows)
        return allowed


class Browser:
    def __init__(self, node, directory, profile="browser-profile"):
        self.process = subprocess.Popen([str(node), str(Path(__file__).with_name("browser_fulltext.cjs"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", env={**os.environ, "URO_BROWSER_PROFILE": str(directory / profile),
                "URO_PUBLISHER_STATE": str(directory / "publisher-pauses")},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.responses = queue.Queue()
        def receive():
            try:
                for line in self.process.stdout:
                    self.responses.put(line)
            except (OSError,ValueError):
                pass
            finally:
                self.responses.put(None)
        self.reader = threading.Thread(target=receive,daemon=True)
        self.reader.start()

    def response(self, budget_ms):
        try:
            line = self.responses.get(timeout=budget_ms/1000 + 15)
        except queue.Empty:
            self.kill()
            raise TimeoutError('Browser response time limit exceeded') from None
        if not line:
            raise OSError('Browser stopped before returning a response')
        return json.loads(line)

    def kill(self):
        if self.process.poll() is not None: return
        if os.name == 'nt':
            subprocess.run(['taskkill.exe','/PID',str(self.process.pid),'/T','/F'],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
        else:
            self.process.kill()
        self.process.wait(timeout=10)

    def read(self, paper, budget_ms=240000):
        self.process.stdin.write(json.dumps({"pmid":paper["pmid"], "doi":paper["doi"], "budget_ms":budget_ms}) + "\n")
        self.process.stdin.flush()
        return self.response(budget_ms)

    def close(self):
        try: self.process.stdin.close()
        except (OSError,ValueError): pass
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.kill()

    def image(self, url, budget_ms=20000):
        self.process.stdin.write(json.dumps({"operation":"image","url":url,"budget_ms":budget_ms}) + "\n")
        self.process.stdin.flush()
        return self.response(budget_ms)


def parsed_result(paper, result):
    if result.get("status") != "downloaded":
        return None
    normalized = lambda text: " ".join(re.findall(r"\w+", text.lower()))
    expected, actual = normalized(paper["title"]), normalized(result.get("title", ""))
    if expected not in actual and SequenceMatcher(None, expected, actual).ratio() < 0.8:
        raise ValueError("Article title does not match the catalog")
    if result.get("doi") and paper.get("doi") and result["doi"].lower() != paper["doi"].lower():
        raise ValueError("Article DOI does not match the catalog")
    parsed = parse_document(result["html"].encode())
    if len(parsed["content_text"]) < 2000 or len(parsed["sections"]) < 2:
        raise ValueError("Incomplete body")
    url = urlsplit(result["url"])
    return {**parsed, "source_url": urlunsplit((url.scheme, url.netloc, url.path, "", "")), "license":result.get("license")}


def next_retry(status, now):
    return now + (900 if status == "retryable_error" else 86400 if status == "challenge" else 7 * 86400)


def prepare_collection_attempts(db):
    """Add retry metadata without rewriting the existing collection/summary queues."""
    with db:
        db.execute("CREATE TABLE IF NOT EXISTS collection_attempts(pmid TEXT PRIMARY KEY,status TEXT,next_retry REAL)")
        db.execute("INSERT OR IGNORE INTO collection_attempts SELECT * FROM attempts WHERE status!='ready'")
        db.execute("""CREATE TABLE IF NOT EXISTS collection_retry_metadata(
            pmid TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT NOT NULL,
            consecutive_failures INTEGER NOT NULL, attempted_at REAL NOT NULL)""")


def record_collection_attempt(db, pmid, status, reason="", now=None):
    """Back off repeated collection failures; summarization keeps its own policy."""
    if status not in STATES | {"ready"}:
        raise ValueError("Unknown collection outcome")
    now = time.time() if now is None else now
    # Store only the bounded machine reason, never publisher text or source URLs.
    reason = reason if isinstance(reason, str) and re.fullmatch(r"[a-z0-9_]{1,80}", reason) else "unspecified"
    with db:
        prior = db.execute("SELECT status,reason,consecutive_failures FROM collection_retry_metadata WHERE pmid=?", (pmid,)).fetchone()
        same_failure = prior and prior[0] == status and prior[1] == reason
        failures = prior[2] + 1 if same_failure and status == "retryable_error" else 1
        retry_at = 0 if status == "ready" else next_retry(status, now)
        if status == "retryable_error":
            retry_at = now + (900, 3600, 21600, 86400)[min(failures, 4) - 1]
        db.execute("INSERT OR REPLACE INTO collection_attempts VALUES(?,?,?)", (pmid, status, retry_at))
        if status == "ready":
            db.execute("DELETE FROM collection_retry_metadata WHERE pmid=?", (pmid,))
        else:
            db.execute("INSERT OR REPLACE INTO collection_retry_metadata VALUES(?,?,?,?,?)",
                       (pmid, status, reason, failures, now))
    return retry_at


def cached_paper_matches(saved, paper):
    """Reuse a verified PMID cache across minor publisher title corrections."""
    old_doi=(saved.get("doi") or "").strip().lower()
    new_doi=(paper.get("doi") or "").strip().lower()
    if old_doi!=new_doi:return False
    if saved.get("title")==paper.get("title"):return True
    if not new_doi:return False
    normalized=lambda title:" ".join(re.findall(r"\w+",(title or "").lower()))
    old_title,new_title=normalized(saved.get("title")),normalized(paper.get("title"))
    return bool(old_title and new_title) and SequenceMatcher(None,old_title,new_title).ratio()>=.9


def verify_cached_body(document):
    if hashlib.sha256(document["content_text"].encode()).hexdigest()!=document["content_hash"]:
        raise ValueError("Cached body hash mismatch")
    return document


def atomic_replace(temporary, path):
    """Retry only transient Windows sharing/lock violations; never remove the target."""
    delays = (.1, .2, .4, .8)
    for attempt in range(len(delays) + 1):
        try:
            return temporary.replace(path)
        except OSError as error:
            if getattr(error, "winerror", None) not in (32, 33) or attempt == len(delays):
                raise
            time.sleep(delays[attempt])


def save_json(path, value):
    temporary=path.with_suffix(path.suffix+".pending")
    with temporary.open("w",encoding="utf-8") as output:
        json.dump(value,output,ensure_ascii=False)
        output.flush()
        os.fsync(output.fileno())
    atomic_replace(temporary, path)


def archive_legacy_bodies(service, directory, deadline):
    archive=directory/"cloud-archive"
    archive.mkdir(exist_ok=True)
    count=0
    while time.monotonic()<deadline:
        item=service.rpc("institution_cloud_archive")
        if not item: break
        paper,document=item["paper"],item["document"]
        pmid=str(paper["pmid"])
        if not re.fullmatch(r"\d{1,12}",pmid): raise ValueError("Invalid archive PMID")
        path=archive/(pmid+".json")
        save_json(path,item)
        saved=json.loads(path.read_text(encoding="utf-8"))
        body=saved["document"]["content_text"]
        content_hash=hashlib.sha256(body.encode()).hexdigest()
        source_hash=hashlib.sha256(("fulltext\n"+saved["paper"]["title"]+"\n"+body).encode()).hexdigest()
        if saved!=item: raise ValueError("Local archive verification failed")
        service.rpc("confirm_local_fulltext_archive",p_pmid=pmid,p_content_hash=content_hash,p_source_hash=source_hash)
        count+=1
        if count%25==0: print(f"Legacy archive: {count} verified local copies",flush=True)
    print(f"Legacy archive: {count} bodies moved to Z8 with hashes verified",flush=True)


def run(directory, node, seconds, phase="all", requested_pmid=None):
    if phase not in ("all","collect","summarize"):
        raise ValueError("Unknown worker phase")
    import msvcrt
    lock = (directory / ("worker.lock" if phase=="all" else phase+".lock")).open("a+b")
    if os.fstat(lock.fileno()).st_size == 0:
        lock.write(b"0"); lock.flush()
    lock.seek(0)
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        lock.close()
        print("An institution worker is already running", flush=True)
        return
    browser = None
    service = Service(directory)
    db = sqlite3.connect(directory / "queue.sqlite3",timeout=20)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE IF NOT EXISTS attempts(pmid TEXT PRIMARY KEY,status TEXT,next_retry REAL)")
    attempt_table="collection_attempts" if phase=="collect" else "attempts"
    if phase=="collect":
        prepare_collection_attempts(db)
    spool = directory / "documents"
    spool.mkdir(exist_ok=True)
    deadline = time.monotonic() + seconds
    done = failed = deferred = 0
    try:
        service.status("running")
        if phase!="collect":
            ensure_server(directory)
        if phase == "all":
            archive_legacy_bodies(service,directory,deadline)
        if phase == "summarize":
            papers = service.candidates(requested_pmid, include_summary=True)
        else:
            papers = service.candidates(requested_pmid) if requested_pmid else service.candidates()
        # Finish already acquired bodies before spending time on publisher access.
        cached={path.name.split(".")[0] for folder in (spool,directory/"cloud-archive",directory/"sources")
                for path in folder.glob("*.json")}
        papers.sort(key=lambda paper: (str(paper["pmid"]) in cached) if phase=="collect" else (str(paper["pmid"]) not in cached))
        print(f"Institution {phase} queue: {len(papers)} papers", flush=True)
        if phase == "collect":
            from collection_queue import run_collection
            counts = run_collection(directory, node, deadline, service, db, papers)
            print(f"Institution collect: {counts['completed']} completed, {counts['failed']} unavailable/invalid, "
                  f"{counts['deferred']} deferred", flush=True)
            return
        if phase == "summarize":
            from summary_queue import run_summary_queue
            counts = run_summary_queue(directory, deadline, service, db, papers,
                                       refresh=None if requested_pmid else lambda: service.candidates(include_summary=True))
            print(f"Institution summarize: {counts['first_completed']} first summaries, {counts['updated']} refreshed, "
                  f"{counts['failed']} failed, {counts['yielded']} yielded, {counts['deferred']} deferred", flush=True)
            return
        for paper in papers:
            if time.monotonic() >= deadline:
                break
            pmid = str(paper["pmid"])
            if not re.fullmatch(r"\d{1,12}", pmid):
                continue
            prior = db.execute(f"SELECT status,next_retry FROM {attempt_table} WHERE pmid=?", (pmid,)).fetchone()
            if prior and prior[1] > time.time():
                deferred += 1
                continue
            document_path = spool / (pmid + ".json")
            operation="collection"
            try:
                if document_path.exists():
                    saved = json.loads(document_path.read_text(encoding="utf-8"))
                    document = verify_cached_body(saved["document"]) if cached_paper_matches(saved,paper) else None
                else:
                    document = None
                archive_path = directory / "cloud-archive" / (pmid + ".json")
                if document is None and archive_path.exists():
                    archived = json.loads(archive_path.read_text(encoding="utf-8"))
                    if cached_paper_matches(archived["paper"],paper):
                        document = verify_cached_body(archived["document"])
                        if phase!="summarize":
                            save_json(document_path,{"doi":paper["doi"],"title":paper["title"],"document":document})
                if phase=="summarize" and document is None:
                    continue
                if document is None:
                    cached_source=directory/"sources"/(pmid+".browser.json")
                    result=None
                    if cached_source.exists():
                        result=json.loads(cached_source.read_text(encoding="utf-8"))
                        document=parsed_result(paper,result)
                    else:
                        try:
                            content,source_url=fetch_oa(pmid)
                            document={**parse_document(content),"source_url":source_url}
                            if len(document["content_text"]) < 2000 or len(document["sections"]) < 2:
                                raise ValueError("Incomplete OA body")
                            (spool/(pmid+".xml")).write_bytes(content)
                        except (FulltextUnavailable,HTTPError,URLError,TimeoutError,ValueError,IncompleteRead,ConnectionError,ssl.SSLError):
                            if browser is not None and browser.process.poll() is not None:
                                browser.close();browser=None
                            if browser is None: browser=Browser(node,directory)
                            try:
                                result=browser.read(paper,budget_ms=max(1000,min(240000,int((deadline-time.monotonic())*1000))))
                            except OSError:
                                result={'status':'retryable_error','reason':'browser_response_unavailable'}
                            document=parsed_result(paper,result)
                    if document is None:
                        status = result.get("status") if result.get("status") in STATES else "parse_failed"
                        service.status("running", pmid, status)
                        db.execute(f"INSERT OR REPLACE INTO {attempt_table} VALUES(?,?,?)", (pmid,status,next_retry(status,time.time())))
                        db.commit()
                        print(f"PMID {pmid}: {status}, {result.get('reason','validation')}", flush=True)
                        failed += 1
                        time.sleep(2)
                        continue
                    if result: (spool / (pmid + ".html")).write_text(result["html"], encoding="utf-8")
                    save_json(document_path,{"doi":paper["doi"],"title":paper["title"],"document":document})
                if not paper.get("fulltext_available"): service.register_original(paper,document)
                operation="summary"
                summary_path = spool / (pmid + ".summary.json")
                expected_hash = hashlib.sha256(("fulltext\n"+paper["title"]+"\n"+document["content_text"]).encode()).hexdigest()
                summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.exists() else None
                if not summary or summary.get("summary_source_hash") != expected_hash or summary.get("summary_model") != MODEL_LABEL:
                    with literature_inference_scope(directory):
                        summary = (generate_summary(paper,document,deadline=deadline,cache_path=spool/(pmid+".notes.json"))
                                   if phase=="summarize" else generate_summary(paper,document))
                    save_json(summary_path,summary)
                operation="publication"
                service.rpc("publish_institution_summary", **summary_payload(paper, document, summary))
                db.execute("INSERT OR REPLACE INTO attempts VALUES(?,?,?)", (pmid,"ready",0))
                db.commit()
                done += 1
                print(f"PMID {pmid}: local body {len(document['content_text'])} characters; summary published", flush=True)
            except SummaryBudgetExpired:
                print(f"PMID {pmid}: summary time budget reached; original and evidence retained for next run",flush=True)
                break
            except ValueError:
                status="parse_failed" if operation=="collection" else "retryable_error"
                service.status("running",pmid,status)
                db.execute(f"INSERT OR REPLACE INTO {attempt_table} VALUES(?,?,?)", (pmid,status,next_retry(status,time.time())))
                db.commit()
                failed += 1
                print(f"PMID {pmid}: {operation} validation failed; retry scheduled", flush=True)
            time.sleep(2)
        if phase=="all":
            service.status("idle")
        print(f"Institution {phase}: {done} completed, {failed} unavailable/invalid, {deferred} deferred", flush=True)
    except Exception:
        if phase=="all":
            try: service.status("error")
            except Exception: pass
        raise
    finally:
        if browser:
            browser.close()
        db.close()
        lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--node", type=Path)
    parser.add_argument("--enroll", action="store_true")
    parser.add_argument("--max-seconds", type=int, default=3300)
    parser.add_argument("--phase",choices=["all","collect","summarize","figures","research"],default="all")
    parser.add_argument("--pmid",help="Explicitly requested paper; bypasses the automatic publication cutoff")
    args = parser.parse_args()
    if args.pmid and not re.fullmatch(r"\d{1,12}",args.pmid):
        parser.error("PMID must contain 1..12 digits")
    if args.enroll:
        print(json.dumps(enroll(args.state_dir)))
        return
    if not args.node or not 60 <= args.max_seconds <= 3600:
        parser.error("A Node executable and 60..3600 second runtime are required")
    try:
        if args.phase=="research":
            from research_extraction import run_research_queue
            run_research_queue(args.state_dir,args.max_seconds)
        elif args.phase=="figures":
            from article_images import run_image_queue
            run_image_queue(args.state_dir,args.node,args.max_seconds,args.pmid)
        else:
            run(args.state_dir, args.node, args.max_seconds,args.phase,args.pmid)
    except Exception as error:
        reason = str(error)[:160] if isinstance(error, RuntimeError) else type(error).__name__
        print(f"Institution worker failed: {reason}; pending documents are preserved", flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
