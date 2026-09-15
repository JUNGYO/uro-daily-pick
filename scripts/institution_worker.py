"""Z8 institution-network browser worker. No publisher API key is required."""
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
from local_summary import MODEL_LABEL, SummaryBudgetExpired, ensure_server, generate_summary, summary_payload

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
        for attempt in range(4):
            try:
                request = Request(url, data=payload, headers={"apikey": self.config["public_key"],
                    "Content-Type": "application/json", "Accept": "application/json"})
                with self.opener.open(request, timeout=45) as response:
                    content = response.read(2 * 1024 * 1024)
                return json.loads(content) if content else None
            except HTTPError as error:
                if path=="rpc/publish_institution_summary" and error.code in (400,409,422):
                    raise ValueError("Summary publication requires revalidation") from None
                if error.code not in (408,429,500,502,503,504,520,522,524):
                    raise RuntimeError(f"Service HTTP {error.code}") from None
            except ssl.SSLCertVerificationError:
                raise RuntimeError("Service certificate verification failed") from None
            except (URLError, TimeoutError, IncompleteRead, ConnectionError, ssl.SSLError):
                pass
            if attempt < 3:
                time.sleep(2 ** (attempt + 1))
        raise RuntimeError("Service temporarily unavailable")

    def rpc(self, name, **values):
        allowed={"institution_worker_status","publish_institution_summary","institution_cloud_archive","confirm_local_fulltext_archive"}
        if name not in allowed:
            raise ValueError("Unsupported worker RPC")
        if name=="publish_institution_summary":
            if (set(values)!={"p_pmid","p_doi","p_title","p_source","p_summary"}
                    or set(values["p_source"])!={"content_hash","characters","section_count","source_url"}
                    or set(values["p_summary"])!={"summary_ko","structured_data","clinical_relevance","qa_data","summary_model","summary_source_hash"}):
                raise ValueError("Only derived summary fields may be published")
        return self.request("rpc/" + name, {"p_worker_id": self.config["id"], "p_token": self.token, **values})

    def status(self, state, pmid=None, status=None):
        self.rpc("institution_worker_status", p_state=state, p_pmid=pmid, p_status=status)

    def candidates(self):
        rows = []
        last_id = 0
        while True:
            page = self.request("papers", params={"select":"id,pmid,doi,title,pub_date,paper_type",
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


class Browser:
    def __init__(self, node, directory, profile="browser-profile"):
        self.process = subprocess.Popen([str(node), str(Path(__file__).with_name("browser_fulltext.cjs"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", env={**os.environ, "URO_BROWSER_PROFILE": str(directory / profile)},
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


def save_json(path, value):
    temporary=path.with_suffix(path.suffix+".pending")
    with temporary.open("w",encoding="utf-8") as output:
        json.dump(value,output,ensure_ascii=False)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


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


def run(directory, node, seconds, phase="all"):
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
        db.execute("CREATE TABLE IF NOT EXISTS collection_attempts(pmid TEXT PRIMARY KEY,status TEXT,next_retry REAL)")
        db.execute("INSERT OR IGNORE INTO collection_attempts SELECT * FROM attempts WHERE status!='ready'")
        db.commit()
    spool = directory / "documents"
    spool.mkdir(exist_ok=True)
    deadline = time.monotonic() + seconds
    done = failed = deferred = 0
    try:
        service.status("running")
        if phase!="collect":
            ensure_server(directory)
            archive_legacy_bodies(service,directory,deadline)
        papers = service.candidates()
        # Finish already acquired bodies before spending time on publisher access.
        cached={path.name.split(".")[0] for folder in (spool,directory/"cloud-archive",directory/"sources")
                for path in folder.glob("*.json")}
        papers.sort(key=lambda paper: (str(paper["pmid"]) in cached) if phase=="collect" else (str(paper["pmid"]) not in cached))
        print(f"Institution {phase} queue: {len(papers)} papers", flush=True)
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
                if phase=="collect" and document is not None:
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
                if phase=="collect":
                    db.execute("INSERT OR REPLACE INTO collection_attempts VALUES(?,?,?)", (pmid,"ready",0))
                    db.commit()
                    done+=1
                    print(f"PMID {pmid}: original stored locally; queued for Spark summary",flush=True)
                    time.sleep(2)
                    continue
                operation="summary"
                summary_path = spool / (pmid + ".summary.json")
                expected_hash = hashlib.sha256(("fulltext\n"+paper["title"]+"\n"+document["content_text"]).encode()).hexdigest()
                summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.exists() else None
                if not summary or summary.get("summary_source_hash") != expected_hash or summary.get("summary_model") != MODEL_LABEL:
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
    parser.add_argument("--phase",choices=["all","collect","summarize","figures"],default="all")
    args = parser.parse_args()
    if args.enroll:
        print(json.dumps(enroll(args.state_dir)))
        return
    if not args.node or not 60 <= args.max_seconds <= 3600:
        parser.error("A Node executable and 60..3600 second runtime are required")
    try:
        if args.phase=="figures":
            from article_images import run_image_queue
            run_image_queue(args.state_dir,args.node,args.max_seconds)
        else:
            run(args.state_dir, args.node, args.max_seconds,args.phase)
    except Exception as error:
        reason = str(error)[:160] if isinstance(error, RuntimeError) else type(error).__name__
        print(f"Institution worker failed: {reason}; pending documents are preserved", flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
