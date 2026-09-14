"""Read-only, loopback-only article API behind an HTTPS reverse proxy.

Uses the existing Supabase login, never a supplied email or a worker credential.
Run with a dedicated OS identity that can read only the article archive and this
release. There are no file uploads, directory listings, or general proxy routes.
"""
import argparse
from collections import deque
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
from socketserver import ThreadingMixIn
import ssl
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, HTTPSHandler, Request

MAX_FILE_BYTES = 12 * 1024 * 1024
MAX_TEXT_CHARS = 2_000_000
PMID = re.compile(r"[1-9][0-9]{0,11}\Z")


class ViewerError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def https_origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment):
        raise ValueError("Expected a single HTTPS origin")
    return value.rstrip("/")


class SupabaseIdentity:
    def __init__(self, url, public_key, owner_email, owner_id):
        self.url = https_origin(url) + "/auth/v1/user"
        if not public_key.startswith("sb_publishable_"):
            raise ValueError("Only a Supabase public publishable key is accepted")
        if not owner_email or not owner_id:
            raise ValueError("An explicit owner email and user ID are required")
        self.key = public_key
        self.email = owner_email.strip().lower()
        self.owner_id = owner_id
        self.opener = build_opener(NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))

    def authorize(self, token):
        request = Request(self.url, headers={"apikey": self.key, "Authorization": "Bearer " + token})
        try:
            with self.opener.open(request, timeout=10) as response:
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise ValueError("Oversize identity")
                user = json.loads(raw)
        except HTTPError as error:
            if error.code in (400, 401, 403):
                raise ViewerError(401, "sign_in_required") from None
            raise ViewerError(503, "identity_unavailable") from None
        except (URLError, OSError, ValueError):
            raise ViewerError(503, "identity_unavailable") from None
        if (not isinstance(user, dict) or user.get("id") != self.owner_id
                or str(user.get("email", "")).strip().lower() != self.email
                or not user.get("email_confirmed_at") or user.get("is_anonymous")):
            raise ViewerError(403, "access_denied")


class Archive:
    def __init__(self, state_dir):
        state = Path(state_dir).resolve(strict=True)
        self.roots = [state / "documents", state / "cloud-archive"]
        if any(path.is_symlink() or path.resolve(strict=True) != path for path in self.roots):
            raise ValueError("Archive directories must be real local directories")

    def read(self, pmid):
        if not PMID.fullmatch(pmid):
            raise ViewerError(404, "not_found")
        found_invalid = False
        for root in self.roots:
            path = root / (pmid + ".json")
            try:
                if not path.exists():
                    continue
                if path.is_symlink() or path.resolve(strict=True) != path:
                    raise ValueError("Invalid archive path")
                with path.open("rb") as stream:
                    raw = stream.read(MAX_FILE_BYTES + 1)
                if len(raw) > MAX_FILE_BYTES:
                    raise ValueError("Archive too large")
                record = json.loads(raw)
                doc = record["document"]
                text = doc["content_text"]
                if not isinstance(text, str) or not 100 <= len(text) <= MAX_TEXT_CHARS:
                    raise ValueError("Invalid article")
                if hashlib.sha256(text.encode("utf-8")).hexdigest() != doc["content_hash"]:
                    raise ValueError("Article integrity mismatch")
                paper = record.get("paper") or record
                # Return plain text only. Never return publisher HTML or local paths.
                return {"pmid": pmid, "title": str(paper.get("title") or "Article " + pmid)[:2000],
                        "doi": str(paper.get("doi") or "")[:500], "content_text": text,
                        "content_hash": doc["content_hash"], "format": "extracted_text"}
            except (OSError, ValueError, TypeError, KeyError):
                found_invalid = True
        raise ViewerError(503 if found_invalid else 404, "document_unavailable" if found_invalid else "not_found")


class WindowLimit:
    """Global bound: do not trust client-supplied forwarding headers as identity."""
    def __init__(self, maximum=120, seconds=60):
        self.maximum, self.seconds = maximum, seconds
        self.events = deque()
        self.lock = threading.Lock()

    def allow(self):
        with self.lock:
            now = time.monotonic()
            while self.events and self.events[0] < now - self.seconds:
                self.events.popleft()
            if len(self.events) >= self.maximum:
                return False
            self.events.append(now)
            return True


class ViewerServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, port, archive, identity, origin):
        self.archive, self.identity, self.origin = archive, identity, https_origin(origin)
        self.limit = WindowLimit()
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(("127.0.0.1", port), ViewerHandler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # No request URLs, headers, tokens, email addresses or article text in logs.
        pass


class ViewerHandler(BaseHTTPRequestHandler):
    server_version = "ArticleViewer"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(12)

    def log_message(self, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"error": "request_rejected"})

    def reply(self, status, value=None):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8") if value is not None else b""
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        self.send_header("Vary", "Origin")
        self.send_header("Connection", "close")
        if self.headers.get("Origin") == self.server.origin:
            self.send_header("Access-Control-Allow-Origin", self.server.origin)
            if self.command == "OPTIONS" and status == 204:
                self.send_header("Access-Control-Allow-Methods", "GET")
                self.send_header("Access-Control-Allow-Headers", "Authorization")
                self.send_header("Access-Control-Max-Age", "300")
        if status == 429:
            self.send_header("Retry-After", "60")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def article_path(self):
        match = re.fullmatch(r"/v1/fulltext/([1-9][0-9]{0,11})", self.path)
        if not match:
            raise ViewerError(404, "not_found")
        if self.headers.get_all("Origin") != [self.server.origin]:
            raise ViewerError(403, "origin_denied")
        if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Length", "0") != "0":
            raise ViewerError(400, "request_rejected")
        if not self.server.limit.allow():
            raise ViewerError(429, "try_later")
        return match[1]

    def do_OPTIONS(self):
        try:
            self.article_path()
            headers = self.headers.get("Access-Control-Request-Headers", "").lower().split(",")
            if (self.headers.get("Access-Control-Request-Method") != "GET"
                    or any(h.strip() != "authorization" for h in headers)):
                raise ViewerError(403, "request_rejected")
            self.reply(204)
        except ViewerError as error:
            self.reply(error.status, {"error": error.code})

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"status": "ok"})
            return
        try:
            pmid = self.article_path()
            values = self.headers.get_all("Authorization", [])
            if (len(values) != 1 or not values[0].startswith("Bearer ")
                    or not re.fullmatch(r"[A-Za-z0-9_.-]{20,8192}", values[0][7:])):
                raise ViewerError(401, "sign_in_required")
            self.server.identity.authorize(values[0][7:])
            self.reply(200, self.server.archive.read(pmid))
        except ViewerError as error:
            self.reply(error.status, {"error": error.code})
        except (OSError, ValueError, TypeError):
            self.reply(503, {"error": "document_unavailable"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--access-report", type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8-sig"))
    archive = Archive(config["state_dir"])
    identity = SupabaseIdentity(config["supabase_url"], config["public_key"],
                                config["owner_email"], config["owner_id"])
    https_origin(config["origin"])
    if args.access_report:
        result = {"archive_readable": False, "archive_read_only": True, "private_paths_denied": True}
        for root in archive.roots:
            for path in root.glob("*.json"):
                if PMID.fullmatch(path.stem):
                    try:
                        archive.read(path.stem)
                        result["archive_readable"] = True
                    except ViewerError:
                        continue
                    try:
                        with path.open("ab"):
                            result["archive_read_only"] = False
                    except PermissionError:
                        pass
                    break
        for path in config.get("protected_paths", []):
            try:
                next(Path(path).iterdir(), None)
                result["private_paths_denied"] = False
            except PermissionError:
                pass
        args.access_report.write_text(json.dumps(result), encoding="utf-8")
        if not all(result.values()):
            raise SystemExit(1)
        return
    if args.check:
        print("Viewer configuration valid")
        return
    with ViewerServer(int(config.get("port", 18451)), archive, identity, config["origin"]) as server:
        server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
