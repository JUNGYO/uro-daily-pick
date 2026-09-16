"""Synthetic collection stages: no live HTTP, originals, credentials or browser sessions."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch, call
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from collection_queue import SourceGate, SourcePaused, run_collection
from fulltext import FulltextUnavailable, parse_document
from institution_worker import atomic_replace, save_json
from collection_queue import _save_bytes


class ParallelCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        for folder in ("documents", "cloud-archive", "sources"):
            (self.directory / folder).mkdir()
        self.db = sqlite3.connect(self.directory / "queue.sqlite3")
        # Production uses WAL; durable per-source checkpoints now exercise this
        # same mode rather than fsyncing a DELETE journal for every coordinator tick.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE attempts(pmid TEXT PRIMARY KEY,status TEXT,next_retry REAL)")
        self.db.commit()
        self.main_thread = threading.get_ident()
        self.paragraph = "A synthetic article documents the methods, outcome and limitations. " * 45
        self.xml = ("<article><body><sec><title>Methods</title><p>" + self.paragraph +
                    "</p></sec><sec><title>Results</title><p>Outcome 17</p></sec></body></article>").encode()
        self.document = {**parse_document(self.xml), "source_url": "https://oa.example.test/article"}
        self.registered, self.statuses = [], []
        outer = self
        class Service:
            def register_original(self, paper, document):
                outer.assertEqual(threading.get_ident(), outer.main_thread)
                path = outer.directory / "documents" / (str(paper["pmid"]) + ".json")
                outer.assertTrue(path.exists(), "Persist the original before sending its receipt")
                outer.registered.append(str(paper["pmid"]))
            def status(self, *args):
                outer.assertEqual(threading.get_ident(), outer.main_thread)
                outer.statuses.append(args)
        self.service = Service()
        self.deps = {"fetch_oa": lambda *a, **k: (self.xml, "https://oa.example.test/article"),
                     "fetch_elsevier": self.forbid_network, "Browser": self.forbid_network,
                     "elsevier_enabled": False}

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def forbid_network(self, *args, **kwargs):
        raise AssertionError("Unexpected provider/browser use")

    def paper(self, n, doi=None):
        return {"id": n, "pmid": str(n), "doi": doi or "10.1007/study-" + str(n),
                "title": "Synthetic study " + str(n), "fulltext_available": False}

    def run_queue(self, papers, **kwargs):
        return run_collection(self.directory, "synthetic-node", time.monotonic() + 10,
                              self.service, self.db, papers, dependencies=self.deps, **kwargs)

    def browser_result(self, paper):
        return {"status": "downloaded", "title": paper["title"], "doi": paper["doi"],
                "url": "https://link.springer.com/article/" + paper["pmid"],
                "html": '<article><h2>Methods</h2><p>' + self.paragraph +
                        '</p><h2>Results</h2><table><tr><td>Outcome 17</td></tr></table></article>'}

    def test_three_api_acquisitions_overlap_deduplicate_pmids_and_write_on_main_thread(self):
        barrier, lock = threading.Barrier(3), threading.Lock()
        active, maximum, calls = 0, 0, []
        def fetch(pmid, **kwargs):
            nonlocal active, maximum
            self.assertNotEqual(threading.get_ident(), self.main_thread)
            self.assertLessEqual(kwargs["deadline"], time.monotonic() + 120)
            with lock:
                active += 1
                maximum = max(maximum, active)
                calls.append(pmid)
            barrier.wait(timeout=3)
            with lock:
                active -= 1
            return self.xml, "https://oa.example.test/article/" + pmid
        self.deps["fetch_oa"] = fetch
        result = self.run_queue([self.paper(1), self.paper(2), self.paper(1), self.paper(3)])
        self.assertEqual(maximum, 3)
        self.assertCountEqual(calls, ["1", "2", "3"])
        self.assertEqual(result, {"completed": 3, "failed": 0, "deferred": 0})
        self.assertCountEqual(self.registered, calls)
        self.assertFalse(list((self.directory / "documents").glob("*.pending")))
        self.assertEqual(self.db.execute("SELECT count(*) FROM attempts").fetchone()[0], 0)

    def test_blocked_browser_does_not_occupy_api_slots_or_mix_responses(self):
        oa_progress, browser_started = threading.Event(), threading.Event()
        browser_calls, active = [], 0
        outer = self
        def fetch(pmid, **kwargs):
            if int(pmid) <= 3:
                raise FulltextUnavailable("Synthetic non-OA paper")
            if pmid == "6":
                oa_progress.set()
            return self.xml, "https://oa.example.test/" + pmid
        class Browser:
            def __init__(self, *args): pass
            def read(self, paper, budget_ms):
                nonlocal active
                active += 1
                outer.assertEqual(active, 1)
                browser_started.set()
                outer.assertTrue(oa_progress.wait(3), "OA stage must continue while browser waits")
                browser_calls.append(paper["pmid"])
                active -= 1
                return outer.browser_result(paper)
            def close(self): pass
        self.deps.update(fetch_oa=fetch, Browser=Browser)
        papers = [self.paper(1), self.paper(2, "10.1111/test"), self.paper(3, "10.1001/test"),
                  self.paper(4), self.paper(5), self.paper(6)]
        result = self.run_queue(papers)
        self.assertTrue(browser_started.is_set())
        self.assertEqual(result["completed"], 6)
        self.assertCountEqual(browser_calls, ["1", "2", "3"])
        for pid in browser_calls:
            saved = json.loads((self.directory / "documents" / (pid + ".json")).read_text())
            self.assertEqual(saved["title"], "Synthetic study " + pid)
            self.assertIn("Outcome 17", saved["document"]["content_text"])

    def test_source_gate_spacing_blocking_and_deadline(self):
        clock = [100.0]
        gate = SourceGate(lambda: clock[0], lambda seconds: clock.__setitem__(0, clock[0] + seconds))
        gate("https://oa.example.test/search", 110)
        gate("https://oa.example.test/xml", 110)
        self.assertGreaterEqual(clock[0], 101)
        gate("https://other.example.test/xml", 110)
        self.assertLess(clock[0], 102)
        gate.block("https://oa.example.test/rejected")
        with self.assertRaises(SourcePaused): gate("https://oa.example.test/next", 110)
        with self.assertRaises(TimeoutError): gate("https://other.example.test/next", clock[0])

    def test_atomic_original_writes_retry_transient_windows_sharing_locks(self):
        real_replace = Path.replace
        for extension, write in ((".xml", lambda path: _save_bytes(path, b"new original")),
                                 (".json", lambda path: save_json(path, {"verified": True}))):
            with self.subTest(extension=extension):
                target = self.directory / ("replacement" + extension)
                target.write_bytes(b"existing original")
                calls = []
                def sharing_lock(temporary, destination):
                    self.assertEqual(threading.get_ident(), self.main_thread)
                    self.assertEqual(target.read_bytes(), b"existing original")
                    calls.append((temporary, destination))
                    if len(calls) <= 2:
                        error = PermissionError(13, "Synthetic sharing lock")
                        error.winerror = 32 if len(calls) == 1 else 33
                        raise error
                    return real_replace(temporary, destination)
                with patch.object(Path, "replace", autospec=True, side_effect=sharing_lock), \
                     patch("institution_worker.time.sleep") as sleep:
                    write(target)
                self.assertEqual(sleep.call_args_list, [call(.1), call(.2)])
                self.assertEqual(len(calls), 3)
                self.assertNotEqual(target.read_bytes(), b"existing original")
                self.assertFalse(target.with_suffix(extension + ".pending").exists())

    def test_atomic_replace_is_bounded_and_other_errors_preserve_existing_file(self):
        temporary, target = self.directory / "body.pending", self.directory / "body.xml"
        temporary.write_bytes(b"new original")
        target.write_bytes(b"existing original")
        for code, attempts, delays in ((32, 5, [.1, .2, .4, .8]), (33, 5, [.1, .2, .4, .8]), (5, 1, []), (None, 1, [])):
            with self.subTest(winerror=code):
                error = PermissionError(13, "Synthetic filesystem failure")
                if code is not None:
                    error.winerror = code
                with patch.object(Path, "replace", side_effect=error) as replace, \
                     patch("institution_worker.time.sleep") as sleep:
                    with self.assertRaises(PermissionError) as raised:
                        atomic_replace(temporary, target)
                self.assertIs(raised.exception, error)
                self.assertEqual(replace.call_count, attempts)
                self.assertEqual(sleep.call_args_list, [call(delay) for delay in delays])
                self.assertEqual(target.read_bytes(), b"existing original")
                self.assertEqual(temporary.read_bytes(), b"new original")

    def test_api_403_stops_same_source_but_keeps_authorized_alternative(self):
        calls = []
        def rejected(pmid, *, deadline, request_gate):
            url = "https://oa.example.test/search"
            request_gate(url, deadline)
            calls.append(pmid)
            raise HTTPError(url, 403, "Synthetic access denial", {}, None)
        self.deps.update(fetch_oa=rejected, elsevier_enabled=True,
                         fetch_elsevier=lambda *a, **k: (self.xml, "https://api.elsevier.com/article"))
        result = self.run_queue([self.paper(n) for n in range(1, 5)], max_workers=1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["completed"], 4)

    def test_browser_challenge_stops_later_same_publisher_and_retains_due_candidates(self):
        calls = []
        class Browser:
            def __init__(self, *args): pass
            def read(self, paper, **kwargs):
                calls.append(paper["pmid"])
                return {"status": "challenge", "reason": "publisher_check", "url": "https://link.springer.com/article"}
            def close(self): pass
        self.deps.update(fetch_oa=lambda *a, **k: (_ for _ in ()).throw(FulltextUnavailable()), Browser=Browser)
        result = self.run_queue([self.paper(n) for n in range(1, 4)])
        self.assertEqual(len(calls), 1)
        self.assertIn(calls[0], ["1", "2", "3"])
        self.assertEqual(result, {"completed": 0, "failed": 1, "deferred": 2})
        self.assertEqual(self.db.execute("SELECT count(*) FROM collection_attempts").fetchone()[0], 1)

    def test_document_archive_and_browser_source_resume_without_network_and_reject_bad_hash(self):
        for pid, kind in ((1, "documents"), (2, "cloud-archive")):
            paper = self.paper(pid)
            saved = {"paper": paper, "document": self.document} if kind == "cloud-archive" else {**paper, "document": self.document}
            (self.directory / kind / (str(pid) + ".json")).write_text(json.dumps(saved))
        (self.directory / "sources" / "3.browser.json").write_text(json.dumps(self.browser_result(self.paper(3))))
        (self.directory / "documents" / "4.json").write_text(json.dumps({**self.paper(4), "document": {**self.document, "content_hash": "0" * 64}}))
        self.deps["fetch_oa"] = self.forbid_network
        result = self.run_queue([self.paper(n) for n in range(1, 5)])
        self.assertEqual(result, {"completed": 2, "failed": 1, "deferred": 0})
        self.assertCountEqual(self.registered, ["1", "2", "3"])
        self.assertEqual(self.db.execute("SELECT status FROM collection_attempts WHERE pmid='4'").fetchone()[0], "parse_failed")

    def test_deadline_stops_new_submissions_and_preserves_completed_original(self):
        clock, calls = [1.0], []
        def fetch(pmid, **kwargs):
            calls.append(pmid)
            clock[0] = 10
            return self.xml, "https://oa.example.test/article"
        self.deps.update(fetch_oa=fetch, clock=lambda: clock[0])
        result = run_collection(self.directory, "fake", 10, self.service, self.db,
                                [self.paper(n) for n in range(1, 8)], dependencies=self.deps, max_workers=1)
        self.assertEqual(calls, ["1"])
        self.assertEqual(result["completed"], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM collection_attempts").fetchone()[0], 1)

    def test_receipt_failure_retains_original_and_resume_resets_retry_without_refetch(self):
        now = [10000]
        self.deps["wall_clock"] = lambda: now[0]
        successful_register = self.service.register_original
        self.service.register_original = lambda *a: (_ for _ in ()).throw(RuntimeError("Synthetic outage"))
        first = self.run_queue([self.paper(1)])
        self.assertEqual(first["failed"], 1)
        self.assertTrue((self.directory / "documents" / "1.json").exists())
        self.deps["fetch_oa"] = self.forbid_network
        self.assertEqual(self.run_queue([self.paper(1)])["deferred"], 1)
        now[0] = 11000
        self.service.register_original = successful_register
        self.assertEqual(self.run_queue([self.paper(1)])["failed"], 0)
        self.assertEqual(self.db.execute("SELECT status FROM collection_attempts WHERE pmid='1'").fetchone()[0], "ready")
        self.assertEqual(self.db.execute("SELECT count(*) FROM collection_retry_metadata").fetchone()[0], 0)

    def test_browser_backlog_overflow_and_deadline_leave_unstarted_records_due(self):
        clock = [1.0]
        browser_started, api_finished = threading.Event(), threading.Event()
        calls, browser_calls = [], []
        lock = threading.Lock()
        outer = self
        def fetch(pmid, **kwargs):
            if int(pmid) > 4:
                self.assertTrue(browser_started.wait(3))
            with lock:
                calls.append(pmid)
                if len(calls) == 150:
                    clock[0] = 10.0
                    api_finished.set()
            raise FulltextUnavailable()
        class Browser:
            def __init__(self, *args): pass
            def read(self, paper, **kwargs):
                browser_calls.append(paper["pmid"])
                browser_started.set()
                outer.assertTrue(api_finished.wait(5), "A full browser backlog must not starve further OA work")
                return outer.browser_result(paper)
            def close(self): pass
        self.deps.update(fetch_oa=fetch, Browser=Browser, clock=lambda: clock[0])
        result = run_collection(self.directory, "fake", 10, self.service, self.db,
                                [self.paper(n) for n in range(1, 151)], dependencies=self.deps)
        self.assertEqual(len(calls), 150)
        self.assertEqual(len(browser_calls), 1)
        self.assertEqual(result, {"completed": 1, "failed": 0, "deferred": 149})
        self.assertEqual(self.db.execute("SELECT count(*) FROM collection_attempts").fetchone()[0], 1)

    def test_missing_table_failure_never_stores_partial_original_and_elsevier_web_is_not_started(self):
        class Browser:
            def __init__(self, *args): pass
            def read(self, *args, **kwargs):
                return {"status": "retryable_error", "reason": "article_table_unavailable"}
            def close(self): pass
        self.deps.update(fetch_oa=lambda *a, **k: (_ for _ in ()).throw(FulltextUnavailable()), Browser=Browser)
        self.assertEqual(self.run_queue([self.paper(1)])["failed"], 1)
        self.assertFalse((self.directory / "documents" / "1.json").exists())
        self.deps["Browser"] = self.forbid_network
        self.assertEqual(self.run_queue([self.paper(2, "10.1016/test")])["failed"], 1)
        self.assertEqual(self.db.execute("SELECT status FROM collection_attempts WHERE pmid='2'").fetchone()[0], "unsupported")


if __name__ == "__main__":
    unittest.main()
