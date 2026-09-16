"""Batch metadata/known-OA retrieval with fake downloads only."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import fulltext
import oa_discovery as oa


def record(pmid="1", *, open_access="Y", pmcid="PMC123", source="MED"):
    return {"id": pmid, "source": source, "isOpenAccess": open_access, "pmcid": pmcid}


def response(records):
    return {"hitCount": len(records), "resultList": {"result": records}}


def downloader(result):
    return Mock(return_value=json.dumps(result).encode())


class OADiscoveryTests(unittest.TestCase):
    def test_one_bounded_request_maps_out_of_order_results_and_explicit_missing_records(self):
        fetch = downloader(response([record("2", open_access="N"), record("1")]))
        gate = Mock()
        with patch.object(oa.time, "monotonic", return_value=10):
            result = oa.discover_oa_batch(["1", 2, "3", "1"], deadline=20,
                                          request_gate=gate, download=fetch)
        self.assertEqual(list(result), ["1", "2", "3"])
        self.assertEqual(result["1"], {"status": "available", "pmcid": "PMC123",
                                      "source_url": oa.API_BASE + "/PMC123/fullTextXML"})
        self.assertEqual(result["2"], {"status": "unavailable", "reason": "not_open_access"})
        self.assertEqual(result["3"], {"status": "unavailable", "reason": "not_indexed"})
        fetch.assert_called_once()
        parsed = urlsplit(fetch.call_args.args[0])
        self.assertEqual((parsed.scheme, parsed.netloc, parsed.path),
                         ("https", "www.ebi.ac.uk", "/europepmc/webservices/rest/search"))
        self.assertEqual(parse_qs(parsed.query), {
            "query": ["(EXT_ID:1 OR EXT_ID:2 OR EXT_ID:3) AND SRC:MED"],
            "format": ["json"], "resultType": ["lite"], "pageSize": ["50"], "cursorMark": ["*"]})
        self.assertEqual(fetch.call_args.kwargs, {"deadline": 20, "request_gate": gate})

    def test_empty_batch_never_requests(self):
        fetch = Mock()
        self.assertEqual(oa.discover_oa_batch([], download=fetch), {})
        fetch.assert_not_called()

    def test_exactly_fifty_ids_are_queried_once(self):
        fetch = downloader(response([record(str(n), open_access="N") for n in range(1, 51)]))
        result = oa.discover_oa_batch(range(1, 51), download=fetch)
        self.assertEqual(len(result), 50)
        fetch.assert_called_once()

    def test_invalid_inputs_and_oversized_batches_never_request(self):
        bad = ["1", b"1", [True], [1.0], [None], ["1 OR SRC:PMC"], ["１"], ["٠١"],
               ["01"], ["0"], ["1\n"], ["1" * 13], range(1, 52)]
        for values in bad:
            with self.subTest(values=values):
                fetch = Mock()
                with self.assertRaises(ValueError):
                    oa.discover_oa_batch(values, download=fetch)
                fetch.assert_not_called()

    def test_complete_zero_hit_response_is_a_current_provider_absence(self):
        self.assertEqual(oa.discover_oa_batch(["1", "2"], download=downloader(response([]))), {
            "1": {"status": "unavailable", "reason": "not_indexed"},
            "2": {"status": "unavailable", "reason": "not_indexed"}})

    def test_bad_or_incomplete_envelopes_never_return_negative_observations(self):
        bad = [[], None, {}, {"hitCount": 0}, {"hitCount": 0, "resultList": {}},
               {"hitCount": 0, "resultList": {"result": {}}},
               {"hitCount": 2, "resultList": {"result": [record()]}},
               {"hitCount": 0, "resultList": {"result": [record()]}},
               {"hitCount": "1", "resultList": {"result": [record()]}},
               {"hitCount": 1.0, "resultList": {"result": [record()]}},
               {"hitCount": True, "resultList": {"result": [record()]}},
               {"hitCount": -1, "resultList": {"result": []}}]
        for body in bad:
            with self.subTest(body=body), self.assertRaises(oa.OADiscoveryError):
                oa.discover_oa_batch(["1", "2"], download=downloader(body))

    def test_invalid_identities_and_missing_oa_status_abort_entire_batch(self):
        bad = [record("3"), record(2), record("2", source="PMC"),
               record("2", source=None), record("2", open_access=None),
               record("2", open_access="yes"), record("2", pmcid=""),
               record("2", pmcid="PMC123/../../other"), record("2", pmcid="PMC１２３"),
               {"id": "2", "source": "MED"}, None, []]
        for entry in bad:
            with self.subTest(entry=entry), self.assertRaises(oa.OADiscoveryError):
                oa.discover_oa_batch(["1", "2"], download=downloader(response([record(), entry])))

    def test_duplicate_results_abort_even_when_hit_count_matches_length(self):
        with self.assertRaises(oa.OADiscoveryError):
            oa.discover_oa_batch(["1", "2"], download=downloader(response([record(), record()])))

    def test_malformed_duplicate_json_keys_oversize_and_unexpected_payloads_are_retryable(self):
        bad = [b'{"hitCount":', b'\xff',
               b'{"hitCount":1,"hitCount":0,"resultList":{"result":[]}}',
               b" " * (oa.MAX_DISCOVERY_BYTES + 1), {"hitCount": 0}]
        for raw in bad:
            with self.subTest(raw_type=type(raw)), self.assertRaises(oa.OADiscoveryError):
                oa.discover_oa_batch(["1"], download=Mock(return_value=raw))

    def test_transport_errors_propagate_without_retry_or_absence(self):
        errors = [TimeoutError("budget"), RuntimeError("source paused"),
                  HTTPError(oa.API_BASE, 429, "Slow down", {"Retry-After": "300"}, None),
                  HTTPError(oa.API_BASE, 503, "Unavailable", {}, None)]
        for error in errors:
            fetch = Mock(side_effect=error)
            with self.subTest(error=error), self.assertRaises(type(error)) as caught:
                oa.discover_oa_batch(["1"], download=fetch)
            self.assertIs(caught.exception, error)
            fetch.assert_called_once()

    def test_expired_budget_never_requests(self):
        fetch = Mock()
        with patch.object(oa.time, "monotonic", return_value=10), self.assertRaises(TimeoutError):
            oa.discover_oa_batch(["1"], deadline=10, download=fetch)
        fetch.assert_not_called()

    def test_budget_expiring_during_response_never_returns_observations(self):
        fetch = downloader(response([]))
        with patch.object(oa.time, "monotonic", side_effect=[1, 10]), self.assertRaises(TimeoutError):
            oa.discover_oa_batch(["1"], deadline=5, download=fetch)

    def test_default_reuses_existing_download_with_the_same_gate_and_deadline(self):
        gate = Mock()
        with patch.object(fulltext, "download", return_value=json.dumps(response([])).encode()) as fetch:
            oa.discover_oa_batch(["1"], request_gate=gate)
        self.assertEqual(fetch.call_args.kwargs, {"deadline": None, "request_gate": gate})

    def test_known_oa_fetch_has_one_xml_request_and_still_returns_body_for_upstream_validation(self):
        observation = oa.discover_oa_batch(["1"], download=downloader(response([record()])))
        # A metadata response cannot certify the body. Deliberately return an
        # invalid article to prove fetch leaves the existing parser in charge.
        fetch = Mock(return_value=b"<article/>")
        gate = Mock()
        with patch.object(oa.time, "monotonic", return_value=10):
            body, url = oa.fetch_discovered_oa("1", observation, deadline=15,
                                               request_gate=gate, download=fetch)
        self.assertEqual(url, oa.API_BASE + "/PMC123/fullTextXML")
        fetch.assert_called_once_with(url, deadline=15, request_gate=gate)
        with self.assertRaises(ValueError):
            fulltext.parse_document(body)

    def test_known_absence_does_not_download_and_remains_provider_specific(self):
        fetch = Mock()
        observation = {"1": {"status": "unavailable", "reason": "not_open_access"}}
        with self.assertRaises(fulltext.FulltextUnavailable):
            oa.fetch_discovered_oa("1", observation, download=fetch)
        fetch.assert_not_called()

    def test_fetch_rejects_untrusted_urls_injected_pmcids_and_missing_observations(self):
        good = {"status": "available", "pmcid": "PMC123",
                "source_url": oa.API_BASE + "/PMC123/fullTextXML"}
        bad = [{}, None, {"1": {**good, "source_url": "https://elsewhere.test/"}},
               {"1": {**good, "source_url": oa.API_BASE + "/PMC124/fullTextXML"}},
               {"1": {**good, "pmcid": "PMC123?url=https://elsewhere.test"}},
               {"1": {**good, "status": "retryable_error"}},
               {"1": {"status": "unavailable", "reason": "request_failed"}}]
        for observation in bad:
            fetch = Mock()
            with self.subTest(observation=observation), self.assertRaises(oa.OADiscoveryError):
                oa.fetch_discovered_oa("1", observation, download=fetch)
            fetch.assert_not_called()

    def test_xml_download_preserves_cooldown_error_and_same_deadline(self):
        observation = oa.discover_oa_batch(["1"], download=downloader(response([record()])))
        error = HTTPError(oa.API_BASE, 429, "Limit", {"Retry-After": "60"}, None)
        with self.assertRaises(HTTPError) as caught:
            oa.fetch_discovered_oa("1", observation, download=Mock(side_effect=error))
        self.assertIs(caught.exception, error)


if __name__ == "__main__":
    unittest.main()
