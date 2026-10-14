"""Durable acquisition scheduling regressions; fixtures never contact a source."""
import contextlib
import io
import json
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from tests import test_parallel_collection as parallel_fixture
from collection_queue import _SharedBrowser, SourceGate, run_collection
from fulltext import FulltextUnavailable


class DurableCollectionTests(unittest.TestCase):
    def test_validation_rejection_is_quarantined_and_never_registered(self):
        f = self.f
        class Browser:
            def __init__(self, *args): pass
            def read(self, paper, **kwargs):
                return {**f.browser_result(paper), 'doi':'10.1007/wrong',
                    'url':'https://link.springer.com/article/example?private=token'}
            def close(self): pass
        def unavailable(*args, **kwargs): raise FulltextUnavailable()
        f.deps.update(fetch_oa=unavailable, Browser=Browser)
        self.assertEqual(self.run_queue([f.paper(1)])['completed'], 0)
        self.assertEqual(f.registered, [])
        self.assertFalse((f.directory/'documents/1.json').exists())
        evidence=json.loads((f.directory/'browser-rejections/1.json').read_text())
        self.assertIs(evidence['verified'], False)
        self.assertEqual(evidence['reason'], 'article_doi_mismatch')
        self.assertEqual(evidence['response']['url'], 'https://link.springer.com/article/example')
        self.assertNotIn('private=token', self.output)
        self.assertEqual(f.db.execute("SELECT reason FROM collection_probe_details WHERE provider='browser'").fetchone()[0], 'article_doi_mismatch')

    def test_source_pause_survives_restart_and_expires_without_blocking_other_sources(self):
        f = self.f
        calls = []
        class BlockedBrowser:
            def __init__(self, *args): pass
            def read(self, paper, **kwargs):
                calls.append(paper["pmid"])
                return {"status": "challenge", "reason": "publisher_check", "url": "https://link.springer.com/article"}
            def close(self): pass
        def unavailable(*args, **kwargs): raise FulltextUnavailable()
        f.deps.update(fetch_oa=unavailable, Browser=BlockedBrowser)
        self.run_queue([f.paper(1)])
        self.assertEqual(calls, ["1"])
        self.assertGreater(f.db.execute("SELECT retry_at FROM collection_source_pauses WHERE source='springer-nature'").fetchone()[0], self.now[0])
        self.run_queue([f.paper(2)])
        self.assertEqual(calls, ["1"], "A new process must respect the host pause")
        self.assertEqual(self.telemetry["restored_source_pauses"], 1)
        f.deps["fetch_oa"] = lambda *a, **k: (f.xml, "https://oa.example.test/article")
        self.assertEqual(self.run_queue([f.paper(3)])["completed"], 1)
        self.now[0] += 86401
        f.deps["fetch_oa"] = unavailable
        self.run_queue([f.paper(4)])
        self.assertEqual(calls, ["1", "4"])

    def test_cached_negative_batch_never_submits_api_jobs(self):
        f = self.f
        f.deps.update(fetch_oa=f.forbid_network, discover_oa_batch=lambda pmids, **kwargs: {
            p: {"status": "unavailable", "reason": "not_open_access"} for p in pmids})
        papers = [f.paper(n, "10.1016/test-" + str(n)) for n in range(1, 151)]
        result = self.run_queue(papers)
        self.assertEqual(result["completed"], 0)
        self.assertEqual(self.telemetry["api_candidates"], 0)
        self.assertEqual(self.telemetry["cached_api_skipped"], 150)
        self.assertEqual(self.telemetry["discovery_batches"], 3)

    def setUp(self):
        self.f = parallel_fixture.ParallelCollectionTests(methodName="runTest")
        self.f.setUp()
        self.now = [10000.0]
        self.f.deps["wall_clock"] = lambda: self.now[0]

    def tearDown(self):
        self.f.tearDown()

    def run_queue(self, papers, **kwargs):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = self.f.run_queue(papers, **kwargs)
        self.output = output.getvalue()
        self.telemetry = json.loads(next(line.split(": ", 1)[1] for line in self.output.splitlines()
                                        if line.startswith("Collection telemetry:")))
        return result

    def test_second_run_skips_150_known_misses_and_reaches_untouched_oa(self):
        f, clock = self.f, [1.0]
        calls, browser_calls = [], []
        api_finished = threading.Event()
        lock = threading.Lock()
        def fetch(pmid, **kwargs):
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
                if not api_finished.wait(20):
                    raise AssertionError("API workers stalled behind browser")
                return f.browser_result(paper)
            def close(self): pass
        f.deps.update(fetch_oa=fetch, Browser=Browser, clock=lambda: clock[0])
        papers = [f.paper(n) for n in range(1, 152)]
        with contextlib.redirect_stdout(io.StringIO()):
            first = run_collection(f.directory, "fake", 10, f.service, f.db, papers, dependencies=f.deps)
        self.assertEqual(first["completed"], 1)
        self.assertEqual(len(calls), 150)
        self.assertEqual(f.db.execute("SELECT count(*) FROM collection_browser_pending").fetchone()[0], 149)
        first_browser = browser_calls[0]
        calls.clear()
        clock[0] = 1.0
        def second_fetch(pmid, **kwargs):
            calls.append(pmid)
            self.assertEqual(pmid, "151", "A negative source lookup must survive restart")
            return f.xml, "https://oa.example.test/article"
        class PausedBrowser:
            def __init__(self, *args): pass
            def read(self, paper, **kwargs):
                self_outer.assertNotEqual(paper["pmid"], first_browser)
                return {"status": "challenge", "reason": "publisher_check", "url": "https://link.springer.com/article"}
            def close(self): pass
        self_outer = self
        f.deps.update(fetch_oa=second_fetch, Browser=PausedBrowser)
        with contextlib.redirect_stdout(io.StringIO()):
            second = run_collection(f.directory, "fake", 10, f.service, f.db, papers, dependencies=f.deps)
        self.assertEqual(calls, ["151"])
        self.assertEqual(second["completed"], 1)
        self.assertTrue((f.directory / "documents" / "151.json").exists())

    def test_transient_api_retry_is_not_delayed_by_browser_seven_day_cooldown(self):
        f, calls = self.f, []
        def fetch(pmid, **kwargs):
            calls.append(pmid)
            if len(calls) == 1:
                raise URLError("synthetic outage")
            return f.xml, "https://oa.example.test/article"
        f.deps["fetch_oa"] = fetch
        paper = f.paper(1, "10.1016/test")
        self.run_queue([paper])
        rows = dict(f.db.execute("SELECT provider,next_probe FROM collection_source_probes WHERE pmid='1'"))
        self.assertEqual(rows["oa"], 10900)
        self.assertEqual(rows["browser"], 614800)
        self.assertEqual(f.db.execute("SELECT next_retry FROM collection_attempts WHERE pmid='1'").fetchone()[0], 10900)
        self.now[0] = 10901
        self.assertEqual(self.run_queue([paper])["completed"], 1)
        self.assertEqual(calls, ["1", "1"])
        self.assertEqual(self.telemetry["browser_attempts"], 0)

    def test_identity_change_invalidates_negative_and_browser_cooldowns(self):
        f, calls = self.f, []
        def fetch(pmid, **kwargs):
            calls.append(pmid)
            if len(calls) == 1:
                raise FulltextUnavailable()
            return f.xml, "https://oa.example.test/article"
        f.deps["fetch_oa"] = fetch
        paper = f.paper(1, "10.1016/test")
        self.run_queue([paper])
        self.assertEqual(self.run_queue([paper])["deferred"], 1)
        changed = {**paper, "doi": "10.1016/corrected", "title": "Corrected catalog identity"}
        self.assertEqual(self.run_queue([changed])["completed"], 1)
        self.assertEqual(len(calls), 2)

    def test_metadata_batches_remain_50_50_23_and_download_only_positive_ids(self):
        f, batches, downloads = self.f, [], []
        def discover(pmids, **kwargs):
            self.assertEqual(threading.get_ident(), f.main_thread)
            batches.append(list(pmids))
            return {pmid: ({"status": "available", "pmcid": "PMC" + pmid}
                           if int(pmid) % 25 == 0 else {"status": "unavailable", "reason": "not_open_access"})
                    for pmid in pmids}
        def download(pmid, locations, **kwargs):
            self.assertEqual(locations[pmid]["pmcid"], "PMC" + pmid)
            downloads.append(pmid)
            return f.xml, locations[pmid]["source_url"]
        f.deps.update(fetch_oa=f.forbid_network, discover_oa_batch=discover, fetch_discovered_oa=download)
        result = self.run_queue([f.paper(n, "10.1016/test-" + str(n)) for n in range(1, 124)])
        self.assertEqual([len(batch) for batch in batches], [50, 50, 23])
        self.assertCountEqual(downloads, ["25", "50", "75", "100"])
        self.assertEqual(result["completed"], 4)
        self.assertEqual(self.telemetry["discovery_batches"], 3)
        self.assertEqual(self.telemetry["cached_no_copy"], 119)

    def test_not_indexed_expires_earlier_than_confirmed_not_open_access(self):
        f = self.f
        f.deps.update(discover_oa_batch=lambda pmids, **kwargs: {
            "1": {"status": "unavailable", "reason": "not_indexed"},
            "2": {"status": "unavailable", "reason": "not_open_access"}}, fetch_oa=f.forbid_network)
        self.run_queue([f.paper(1, "10.1016/a"), f.paper(2, "10.1016/b")])
        rows = {row[0]: row[1:] for row in f.db.execute(
            "SELECT pmid,status,next_probe FROM collection_source_probes WHERE provider='oa'")}
        self.assertEqual(rows["1"], ("not_indexed", 96400))
        self.assertEqual(rows["2"], ("unavailable", 614800))

    def test_discovery_403_is_not_a_negative_and_stops_further_source_requests(self):
        f, requests = self.f, []
        def discover(pmids, *, deadline, request_gate):
            url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
            request_gate(url, deadline)
            requests.append(pmids)
            raise HTTPError(url, 403, "synthetic denial", {}, None)
        f.deps.update(discover_oa_batch=discover, fetch_oa=f.forbid_network)
        self.run_queue([f.paper(n, "10.1016/x-" + str(n)) for n in range(1, 53)])
        self.assertEqual(len(requests), 1)
        self.assertEqual(f.db.execute("SELECT count(*) FROM collection_source_probes WHERE status IN ('unavailable','not_indexed')").fetchone()[0], 0)
        self.assertGreaterEqual(self.telemetry["source_paused"], 1)
        later = f.db.execute("SELECT status,next_probe FROM collection_source_probes WHERE pmid='52' AND provider='oa'").fetchone()
        self.assertEqual(later[0], "source_paused")
        self.assertAlmostEqual(later[1], 96400, delta=30)
        self.assertEqual(f.db.execute("SELECT next_retry FROM collection_attempts WHERE pmid='52'").fetchone()[0], later[1])
        self.assertEqual(f.db.execute("SELECT next_probe FROM collection_source_probes WHERE pmid='52' AND provider='browser'").fetchone()[0], 614800)

    def test_missing_xml_location_is_rediscovered_after_retry(self):
        f, metadata, locations = self.f, [], []
        def discover(pmids, **kwargs):
            metadata.append(list(pmids))
            return {pmid: {"status": "available", "pmcid": "PMC" + str(len(metadata))} for pmid in pmids}
        def download(pmid, mapping, **kwargs):
            locations.append(mapping[pmid]["pmcid"])
            if len(locations) == 1:
                raise HTTPError(mapping[pmid]["source_url"], 404, "missing", {}, None)
            return f.xml, mapping[pmid]["source_url"]
        f.deps.update(fetch_oa=f.forbid_network, discover_oa_batch=discover, fetch_discovered_oa=download)
        paper = f.paper(1, "10.1016/test")
        self.run_queue([paper])
        self.assertIsNone(f.db.execute("SELECT pmcid FROM collection_source_probes WHERE provider='oa'").fetchone()[0])
        self.now[0] = 10901
        self.assertEqual(self.run_queue([paper])["completed"], 1)
        self.assertEqual(locations, ["PMC1", "PMC2"])

    def test_discovered_positive_at_deadline_is_downloaded_before_untouched_tail(self):
        f, clock, calls = self.f, [1.0], []
        def discover(pmids, **kwargs):
            clock[0] = 10.0
            return {pmid: {"status": "available", "pmcid": "PMC" + pmid} for pmid in pmids}
        f.deps.update(discover_oa_batch=discover, fetch_oa=f.forbid_network, clock=lambda: clock[0])
        with contextlib.redirect_stdout(io.StringIO()):
            run_collection(f.directory, "fake", 10, f.service, f.db, [f.paper(1)], dependencies=f.deps)
        clock[0] = 1.0
        def download(pmid, locations, **kwargs):
            calls.append(pmid)
            clock[0] = 10.0
            return f.xml, locations[pmid]["source_url"]
        f.deps.update(fetch_discovered_oa=download, discover_oa_batch=lambda *a, **k: {})
        # The new untouched records would previously sort before the known copy.
        with contextlib.redirect_stdout(io.StringIO()):
            result = run_collection(f.directory, "fake", 10, f.service, f.db,
                [f.paper(n) for n in range(2, 80)] + [f.paper(1)], dependencies=f.deps, max_workers=1)
        self.assertEqual(result["completed"], 1)
        self.assertEqual(calls, ["1"])

    def test_failed_receipt_is_reconciled_before_untouched_tail_without_fetch(self):
        f = self.f
        register = f.service.register_original
        f.service.register_original = lambda *a: (_ for _ in ()).throw(RuntimeError("synthetic offline"))
        self.run_queue([f.paper(1)])
        self.now[0] = 10901
        clock, registrations = [1.0], []
        def registered(paper, document):
            registrations.append(paper["pmid"])
            register(paper, document)
            clock[0] = 10.0
        f.service.register_original = registered
        f.deps.update(clock=lambda: clock[0], fetch_oa=f.forbid_network)
        with contextlib.redirect_stdout(io.StringIO()):
            run_collection(f.directory, "fake", 10, f.service, f.db,
                [f.paper(n) for n in range(2, 90)] + [f.paper(1)], dependencies=f.deps, max_workers=1)
        self.assertEqual(registrations, ["1"])
        self.assertEqual(f.db.execute("SELECT status FROM collection_attempts WHERE pmid='1'").fetchone()[0], "ready")

    def test_unknown_publisher_pause_does_not_pause_unrelated_known_source(self):
        calls = []
        class Browser:
            def __init__(self, *args): pass
            def read(self, paper, **kwargs):
                calls.append(paper["pmid"])
                if len(calls) == 1:
                    return {"status": "challenge", "reason": "publisher_check", "url": "https://unknown.example.test/article"}
                return {"status": "unsupported"}
            def close(self): pass
        deps = {"clock": time.monotonic, "Browser": Browser}
        browser = _SharedBrowser(self.f.directory, "fake", time.monotonic() + 10, deps, SourceGate())
        try:
            browser.read(self.f.paper(1, "10.7777/unknown"))
            browser.read(self.f.paper(2, "10.1007/known"))
        finally:
            browser.close()
        self.assertEqual(calls, ["1", "2"])

    def test_metadata_lookahead_does_not_load_50_original_payloads(self):
        import collection_queue
        f, cache_reads = self.f, []
        barrier = threading.Barrier(3)
        original_read = collection_queue._read_cache
        def read_cache(directory, paper):
            cache_reads.append(paper["pmid"])
            return original_read(directory, paper)
        def fetch(pmid, **kwargs):
            if int(pmid) <= 3:
                barrier.wait(timeout=5)
                self.assertEqual(len(cache_reads), 3)
                barrier.wait(timeout=5)
            return f.xml, "https://oa.example.test/article"
        f.deps["fetch_oa"] = fetch
        with patch.object(collection_queue, "_read_cache", side_effect=read_cache):
            result = self.run_queue([f.paper(n) for n in range(1, 51)])
        self.assertEqual(result["completed"], 50)

    def test_new_repository_recovers_manuscript_despite_old_oa_and_browser_cooldowns(self):
        f = self.f
        f.deps['fetch_oa'] = lambda *a, **k: (_ for _ in ()).throw(FulltextUnavailable())
        paper = f.paper(1, '10.1016/test')
        self.run_queue([paper])
        browser_retry = f.db.execute("SELECT next_probe FROM collection_source_probes WHERE provider='browser'").fetchone()[0]
        calls = []
        def cloud(item, pmcid, **kwargs):
            calls.append((item['pmid'], pmcid))
            return f.xml, 'https://pmc-oa-opendata.s3.amazonaws.com/PMC1.2/PMC1.2.xml', {'license': 'TDM', 'version': 2}
        f.deps.update(fetch_oa=f.forbid_network, fetch_pmc_cloud=cloud,
            discover_oa_batch=lambda pmids, **kwargs: {'1': {'status': 'unavailable', 'reason': 'not_open_access', 'pmcid': 'PMC1'}})
        self.assertEqual(self.run_queue([paper])['completed'], 1)
        self.assertEqual(calls, [('1', 'PMC1')])
        self.assertEqual(f.db.execute("SELECT next_probe FROM collection_source_probes WHERE provider='browser'").fetchone()[0], browser_retry)
        saved = json.loads((f.directory/'documents/1.json').read_text())
        self.assertEqual(saved['document']['repository']['version'], 2)

    def test_rejected_body_is_not_redownloaded_every_fifteen_minutes(self):
        f, calls = self.f, []
        def fetch(pmid, **kwargs):
            calls.append(pmid)
            return b'<article><body><p>A short correction.</p></body></article>', 'https://oa.example.test/1'
        f.deps['fetch_oa'] = fetch
        paper = f.paper(1, '10.1016/test')
        self.run_queue([paper])
        self.now[0] += 901
        self.run_queue([paper])
        self.assertEqual(calls, ['1'])
        self.assertFalse((f.directory/'documents/1.json').exists())
        self.assertEqual(f.db.execute("SELECT status FROM collection_source_probes WHERE provider='oa'").fetchone()[0], 'invalid_body')

    def test_persisted_publisher_pause_skips_host_backlog_but_keeps_it_durable(self):
        f, calls = self.f, []
        f.deps['fetch_oa'] = lambda *a, **k: (_ for _ in ()).throw(FulltextUnavailable())
        class Browser:
            def __init__(self, *args): pass
            def read(self, paper, **kwargs):
                calls.append(paper['pmid'])
                return {'status': 'access_required', 'reason': 'publisher_paused'}
            def close(self): pass
        f.deps['Browser'] = Browser
        result = self.run_queue([f.paper(n) for n in range(1, 21)])
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.telemetry['browser_attempts'], 1)
        self.assertEqual(result['deferred'], 19)
        self.assertEqual(f.db.execute('SELECT count(*) FROM collection_browser_pending').fetchone()[0], 19)

    def test_unsupported_backlog_is_retired_without_browser_and_valid_tail_runs(self):
        from collection_queue import _prepare_probe_state, _paper_identity
        f, calls = self.f, []
        papers = [f.paper(n, '10.1097/unsupported-' + str(n)) for n in range(1, 1001)] + [f.paper(1001)]
        from institution_worker import prepare_collection_attempts
        prepare_collection_attempts(f.db)
        _prepare_probe_state(f.db, papers)
        for paper in papers:
            identity = _paper_identity(paper)
            f.db.execute('INSERT INTO collection_source_probes VALUES(?,?,?,?,?,?,?)',
                (paper['pmid'], 'oa', identity, 'unavailable', self.now[0] + 604800, self.now[0], None))
            f.db.execute('INSERT INTO collection_browser_pending VALUES(?,?,?)', (paper['pmid'], identity, self.now[0]))
        f.db.commit()
        class Browser:
            def __init__(self, *args): pass
            def read(self, paper, **kwargs):
                calls.append(paper['pmid'])
                return f.browser_result(paper)
            def close(self): pass
        f.deps.update(fetch_oa=f.forbid_network, Browser=Browser)
        result = self.run_queue(papers)
        self.assertEqual(result['completed'], 1)
        self.assertEqual(calls, ['1001'])
        self.assertEqual(self.telemetry['browser_attempts'], 1)
        self.assertEqual(f.db.execute('SELECT count(*) FROM collection_browser_pending').fetchone()[0], 0)
        self.assertEqual(f.db.execute("SELECT count(*) FROM collection_probe_details WHERE reason='browser_adapter_unavailable'").fetchone()[0], 1000)
        self.run_queue(papers[:-1])
        self.assertEqual(calls, ['1001'])
        report = json.loads((f.directory/'collection-result.json').read_text())
        self.assertEqual(report['outcome'], 'no_new_originals')

    def test_browser_ineligible_paper_still_uses_available_repository(self):
        result = self.run_queue([self.f.paper(1, '10.1097/oa')])
        self.assertEqual(result['completed'], 1)
        self.assertEqual(self.telemetry['browser_attempts'], 0)

    def test_browser_quota_deferral_is_persisted_and_not_retried_before_midnight(self):
        f, calls = self.f, []
        f.deps['fetch_oa'] = lambda *a, **k: (_ for _ in ()).throw(FulltextUnavailable())
        class Browser:
            def __init__(self, *args): pass
            def read(self, paper, **kwargs):
                calls.append(paper['pmid'])
                return {'status':'access_required', 'reason':'quota_daily_limit'}
            def close(self): pass
        f.deps['Browser'] = Browser
        paper = f.paper(1)
        self.run_queue([paper])
        self.now[0] += 600
        self.run_queue([paper])
        self.assertEqual(calls, ['1'])
        row = f.db.execute("SELECT reason FROM collection_probe_details WHERE provider='quota'").fetchone()
        self.assertEqual(row[0], 'quota_daily_limit')
        self.assertEqual(f.db.execute('SELECT count(*) FROM collection_browser_pending').fetchone()[0], 0)
        self.now[0] = f.db.execute("SELECT next_probe FROM collection_source_probes WHERE provider='quota'").fetchone()[0] + 1
        self.run_queue([paper])
        self.assertEqual(calls, ['1', '1'])

    def test_validation_failure_waits_weekly_but_identity_change_retries(self):
        f, calls = self.f, []
        def fail(pmid, **kwargs):
            calls.append(pmid)
            raise ValueError('PMC DOI mismatch')
        f.deps['fetch_oa'] = fail
        paper = f.paper(1, '10.1016/invalid')
        self.run_queue([paper])
        self.now[0] += 901
        self.run_queue([paper])
        self.assertEqual(calls, ['1'])
        self.assertEqual(f.db.execute("SELECT reason FROM collection_probe_details WHERE provider='oa'").fetchone()[0], 'source_validation_failed')
        self.run_queue([{**paper, 'doi':'10.1016/corrected'}])
        self.assertEqual(calls, ['1', '1'])

    def test_one_papers_unsupported_redirect_does_not_defer_its_publisher(self):
        f, calls = self.f, []
        f.deps['fetch_oa'] = lambda *a, **k: (_ for _ in ()).throw(FulltextUnavailable())
        class Browser:
            def __init__(self, *args): pass
            def read(self, paper, **kwargs):
                calls.append(paper['pmid'])
                if paper['pmid']=='1':
                    return {'status':'access_required','reason':'quota_unsupported_source'}
                return f.browser_result(paper)
            def close(self): pass
        f.deps['Browser'] = Browser
        self.assertEqual(self.run_queue([f.paper(1), f.paper(2)],max_workers=1)['completed'],1)
        self.assertEqual(calls,['1','2'])
        self.assertIsNone(f.db.execute("SELECT 1 FROM collection_source_probes WHERE pmid='2' AND provider='quota'").fetchone())

    def test_actual_known_unsupported_routes_and_bmc_adapter(self):
        from collection_queue import browser_ineligible_reason, _browser_source
        for doi in ('10.1038/aja.2012.76','10.1111/j.1745-7262.2005.00020.x'):
            self.assertEqual(browser_ineligible_reason(self.f.paper(1,doi)), 'browser_adapter_unavailable')
        self.assertIsNone(browser_ineligible_reason(self.f.paper(1,'10.1186/s12894-026-example')))
        self.assertEqual(_browser_source(self.f.paper(1,'10.1186/s12894-026-example')),'https://link.springer.com/')

    def test_large_first_publisher_backlog_cannot_starve_other_publisher(self):
        from collection_queue import _prepare_probe_state, _paper_identity
        from institution_worker import prepare_collection_attempts
        f, calls = self.f, []
        papers = [f.paper(n, '10.1111/fixture-' + str(n)) for n in range(1, 101)] + [f.paper(101)]
        prepare_collection_attempts(f.db)
        _prepare_probe_state(f.db, papers)
        for paper in papers:
            identity = _paper_identity(paper)
            f.db.execute('INSERT INTO collection_source_probes VALUES(?,?,?,?,?,?,?)',
                (paper['pmid'], 'oa', identity, 'unavailable', self.now[0] + 604800, self.now[0], None))
            f.db.execute('INSERT INTO collection_browser_pending VALUES(?,?,?)', (paper['pmid'], identity, self.now[0]))
        f.db.commit()
        class Browser:
            def __init__(self, *args): pass
            def read(self, paper, **kwargs):
                calls.append(paper['pmid'])
                if paper['pmid'] == '101': return f.browser_result(paper)
                return {'status':'access_required','reason':'quota_unknown_publisher'}
            def close(self): pass
        f.deps.update(fetch_oa=f.forbid_network, Browser=Browser)
        with patch.object(SourceGate, '__call__', return_value=None):
            self.assertEqual(self.run_queue(papers)['completed'], 1)
        self.assertEqual(calls[:2], ['1','101'])
        self.assertEqual([p for p in calls if p != '101'], sorted(str(n) for n in range(1,101)))

    def test_new_adapter_expires_only_old_capability_failure(self):
        from collection_queue import _prepare_probe_state, _paper_identity
        from institution_worker import prepare_collection_attempts, record_collection_attempt
        f = self.f
        papers = [f.paper(n,'10.1186/example-' + str(n)) for n in (1,2)]
        prepare_collection_attempts(f.db)
        _prepare_probe_state(f.db, papers)
        for paper, reason in zip(papers, ['browser_adapter_unavailable','http_403']):
            pmid, identity = paper['pmid'], _paper_identity(paper)
            record_collection_attempt(f.db, pmid, 'unsupported' if pmid=='1' else 'access_required', reason, now=self.now[0])
            for provider, status in [('browser','unsupported' if pmid=='1' else 'access_required'),('oa','unavailable')]:
                f.db.execute('INSERT INTO collection_source_probes VALUES(?,?,?,?,?,?,?)',
                    (pmid,provider,identity,status,self.now[0]+604800,self.now[0],None))
            f.db.execute('INSERT INTO collection_probe_details VALUES(?,?,?,?,?)', (pmid,'browser',identity,reason,1))
        f.db.execute('INSERT INTO collection_source_pauses VALUES(?,?)', ('springer-nature',self.now[0]+86400))
        f.db.commit()
        probes, _ = _prepare_probe_state(f.db,papers)
        self.assertNotIn('browser',probes['1'])
        self.assertIn('oa',probes['1'])
        self.assertEqual(probes['2']['browser']['reason'],'http_403')
        self.assertIsNone(f.db.execute("SELECT 1 FROM collection_attempts WHERE pmid='1'").fetchone())
        self.assertIsNotNone(f.db.execute("SELECT 1 FROM collection_attempts WHERE pmid='2'").fetchone())
        self.assertEqual(f.db.execute('SELECT retry_at FROM collection_source_pauses').fetchone()[0],self.now[0]+86400)

    def test_transient_errors_back_off_across_restart(self):
        f = self.f
        f.deps['fetch_oa'] = lambda *a, **k: (_ for _ in ()).throw(HTTPError('https://example.test',500,'unavailable',{},None))
        paper = f.paper(1, '10.1016/retry')
        self.run_queue([paper])
        self.now[0] += 901
        self.run_queue([paper])
        row = f.db.execute("SELECT next_probe FROM collection_source_probes WHERE provider='oa'").fetchone()
        self.assertEqual(row[0], self.now[0] + 1800)
        self.assertEqual(f.db.execute("SELECT failures FROM collection_probe_details WHERE provider='oa'").fetchone()[0], 2)

    def test_next_batch_fills_free_slot_while_previous_batch_last_request_is_slow(self):
        f = self.f
        later_started = threading.Event()
        waited = []
        def fetch(pmid, **kwargs):
            if pmid == '50': waited.append(later_started.wait(3))
            if pmid == '51': later_started.set()
            return f.xml, 'https://oa.example.test/' + pmid
        f.deps['fetch_oa'] = fetch
        self.assertEqual(self.run_queue([f.paper(n) for n in range(1, 52)])['completed'], 51)
        self.assertEqual(waited, [True])


if __name__ == "__main__":
    unittest.main()
