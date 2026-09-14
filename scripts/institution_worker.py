"""Z8 institution-network browser worker. No publisher API key is required."""
import argparse
import ctypes
import hashlib
from http.client import IncompleteRead
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import ssl
import subprocess
import sys
import time
import uuid
from difflib import SequenceMatcher
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPSHandler

from fulltext import FulltextUnavailable, NoRedirect, fetch_oa, parse_document
from local_summary import MODEL_LABEL, ensure_server, generate_summary, summary_payload

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
        while True:
            page = self.request("papers", params={"select":"pmid,doi,title,pub_date,paper_type",
                "or":"(fulltext_available.eq.false,summary_source_hash.is.null,summarized_at.is.null)", "order":"pub_date.desc,id",
                "offset":len(rows), "limit":100})
            rows.extend(page)
            if len(page) < 100:
                return rows


class Browser:
    def __init__(self, node, directory):
        self.process = subprocess.Popen([str(node), str(Path(__file__).with_name("browser_fulltext.cjs"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", env={**os.environ, "URO_BROWSER_PROFILE": str(directory / "browser-profile")},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def read(self, paper):
        self.process.stdin.write(json.dumps({"pmid":paper["pmid"], "doi":paper["doi"]}) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("Browser stopped before returning an article")
        return json.loads(line)

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)


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


def run(directory, node, seconds):
    import msvcrt
    lock = (directory / "worker.lock").open("a+b")
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
    db = sqlite3.connect(directory / "queue.sqlite3")
    db.execute("CREATE TABLE IF NOT EXISTS attempts(pmid TEXT PRIMARY KEY,status TEXT,next_retry REAL)")
    spool = directory / "documents"
    spool.mkdir(exist_ok=True)
    deadline = time.monotonic() + seconds
    done = failed = deferred = 0
    try:
        service.status("running")
        ensure_server(directory)
        archive_legacy_bodies(service,directory,deadline)
        papers = service.candidates()
        # Finish already acquired bodies before spending time on publisher access.
        papers.sort(key=lambda paper: not any(path.exists() for path in (
            spool / (str(paper["pmid"]) + ".json"),
            directory / "sources" / (str(paper["pmid"]) + ".browser.json"))))
        print(f"Institution queue: {len(papers)} papers awaiting bodies", flush=True)
        for paper in papers:
            if time.monotonic() >= deadline:
                break
            pmid = str(paper["pmid"])
            if not re.fullmatch(r"\d{1,12}", pmid):
                continue
            prior = db.execute("SELECT status,next_retry FROM attempts WHERE pmid=?", (pmid,)).fetchone()
            if prior and prior[1] > time.time():
                deferred += 1
                continue
            document_path = spool / (pmid + ".json")
            phase="collection"
            try:
                if document_path.exists():
                    saved = json.loads(document_path.read_text(encoding="utf-8"))
                    document = saved["document"] if saved.get("doi") == paper["doi"] and saved.get("title") == paper["title"] else None
                else:
                    document = None
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
                            if browser is None: browser=Browser(node,directory)
                            result=browser.read(paper)
                            document=parsed_result(paper,result)
                    if document is None:
                        status = result.get("status") if result.get("status") in STATES else "parse_failed"
                        service.status("running", pmid, status)
                        db.execute("INSERT OR REPLACE INTO attempts VALUES(?,?,?)", (pmid,status,next_retry(status,time.time())))
                        db.commit()
                        print(f"PMID {pmid}: {status}, {result.get('reason','validation')}", flush=True)
                        failed += 1
                        time.sleep(2)
                        continue
                    if result: (spool / (pmid + ".html")).write_text(result["html"], encoding="utf-8")
                    save_json(document_path,{"doi":paper["doi"],"title":paper["title"],"document":document})
                phase="summary"
                summary_path = spool / (pmid + ".summary.json")
                expected_hash = hashlib.sha256(("fulltext\n"+paper["title"]+"\n"+document["content_text"]).encode()).hexdigest()
                summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.exists() else None
                if not summary or summary.get("summary_source_hash") != expected_hash or summary.get("summary_model") != MODEL_LABEL:
                    summary = generate_summary(paper, document)
                    save_json(summary_path,summary)
                phase="publication"
                service.rpc("publish_institution_summary", **summary_payload(paper, document, summary))
                db.execute("INSERT OR REPLACE INTO attempts VALUES(?,?,?)", (pmid,"ready",0))
                db.commit()
                done += 1
                print(f"PMID {pmid}: local body {len(document['content_text'])} characters; summary published", flush=True)
            except ValueError:
                status="parse_failed" if phase=="collection" else "retryable_error"
                service.status("running",pmid,status)
                db.execute("INSERT OR REPLACE INTO attempts VALUES(?,?,?)", (pmid,status,next_retry(status,time.time())))
                db.commit()
                failed += 1
                print(f"PMID {pmid}: {phase} validation failed; retry scheduled", flush=True)
            time.sleep(2)
        service.status("idle")
        print(f"Institution full texts: {done} ready, {failed} unavailable/invalid, {deferred} deferred", flush=True)
    except Exception:
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
    args = parser.parse_args()
    if args.enroll:
        print(json.dumps(enroll(args.state_dir)))
        return
    if not args.node or not 60 <= args.max_seconds <= 3600:
        parser.error("A Node executable and 60..3600 second runtime are required")
    try:
        run(args.state_dir, args.node, args.max_seconds)
    except Exception as error:
        print(f"Institution worker failed: {type(error).__name__}; pending documents are preserved", flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
