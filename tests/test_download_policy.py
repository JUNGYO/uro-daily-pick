"""Bounded API retrieval with fake openers only; never contacts a provider."""
import io
import json
import os
from pathlib import Path
import ssl
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import fulltext

API_URL = 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC123/fullTextXML'


class FakeResponse:
    def __init__(self, body, after_read=None, after_close=None):
        self.body = io.BytesIO(body)
        self.socket = Mock()
        self.fp = SimpleNamespace(raw=SimpleNamespace(_sock=self.socket))
        self.read_sizes = []
        self.after_read = after_read
        self.after_close = after_close
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.body.close()
        self.closed = True
        if self.after_close:
            self.after_close()

    def read1(self, size):
        self.read_sizes.append(size)
        data = self.body.read(size)
        if self.after_read:
            self.after_read()
        return data


class DownloadPolicyTests(unittest.TestCase):
    def test_existing_call_returns_bytes_with_verified_tls_and_no_redirects(self):
        response = FakeResponse(b'<article>complete</article>')
        opener = Mock()
        opener.open.return_value = response
        with patch.object(fulltext, 'build_opener', return_value=opener) as build:
            self.assertEqual(fulltext.download(API_URL, {'Accept': 'text/xml'}), b'<article>complete</article>')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header('Accept'), 'text/xml')
        self.assertEqual(opener.open.call_args.kwargs['timeout'], 45)
        https, redirects = build.call_args.args
        self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(https._context.check_hostname)
        self.assertIsInstance(redirects, fulltext.NoRedirect)
        self.assertIsNone(redirects.redirect_request(None, None, 302, '', {}, 'https://other.example.test'))
        self.assertTrue(response.closed)

    def test_expired_budget_does_not_open_or_enter_the_gate(self):
        gate = Mock()
        with patch.object(fulltext.time, 'monotonic', return_value=10), patch.object(fulltext, 'build_opener') as build:
            with self.assertRaises(TimeoutError):
                fulltext.download(API_URL, deadline=10, request_gate=gate)
        build.assert_not_called()
        gate.assert_not_called()

    def test_gate_wait_uses_budget_before_open_and_is_immediately_followed_by_request(self):
        clock = [10.0]
        events = []
        response = FakeResponse(b'xml')
        opener = Mock()

        def gate(url, deadline):
            events.append(('gate', url, deadline))
            clock[0] += 2

        def opened(request, timeout):
            events.append(('open', request.full_url, timeout))
            return response

        opener.open.side_effect = opened
        with patch.object(fulltext.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(fulltext, 'build_opener', return_value=opener):
            self.assertEqual(fulltext.download(API_URL, deadline=15, request_gate=gate), b'xml')
        self.assertEqual(events, [('gate', API_URL, 15), ('open', API_URL, 3)])
        self.assertEqual(response.socket.settimeout.call_args.args, (3,))

    def test_budget_expiring_inside_gate_prevents_network_request(self):
        clock = [0]
        opener = Mock()
        def gate(_url, _deadline):
            clock[0] = 5
        with patch.object(fulltext.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(fulltext, 'build_opener', return_value=opener):
            with self.assertRaises(TimeoutError):
                fulltext.download(API_URL, deadline=5, request_gate=gate)
        opener.open.assert_not_called()

    def test_slow_body_reads_reduce_socket_timeout_and_never_return_partial_data(self):
        clock = [0.0]
        def advanced():
            clock[0] += 1.5
        response = FakeResponse(b'x' * (128 * 1024), after_read=advanced)
        opener = Mock()
        opener.open.return_value = response
        with patch.object(fulltext.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(fulltext, 'build_opener', return_value=opener):
            with self.assertRaises(TimeoutError):
                fulltext.download(API_URL, deadline=2)
        self.assertEqual(opener.open.call_args.kwargs['timeout'], 2)
        self.assertEqual([call.args[0] for call in response.socket.settimeout.call_args_list], [2, .5])
        self.assertEqual(response.read_sizes, [64 * 1024, 64 * 1024])
        self.assertTrue(response.closed)

    def test_document_size_limit_is_still_exactly_twenty_mebibytes(self):
        for length, oversized in [(fulltext.MAX_BYTES, False), (fulltext.MAX_BYTES + 1, True)]:
            with self.subTest(length=length):
                response = FakeResponse(b'x' * length)
                opener = Mock()
                opener.open.return_value = response
                with patch.object(fulltext, 'build_opener', return_value=opener):
                    if oversized:
                        with self.assertRaisesRegex(ValueError, '20 MB'):
                            fulltext.download(API_URL)
                    else:
                        self.assertEqual(len(fulltext.download(API_URL)), fulltext.MAX_BYTES)
                self.assertLessEqual(max(response.read_sizes), 64 * 1024)
                self.assertTrue(response.closed)

    def test_provider_http_errors_are_not_retried_or_hidden_from_queue(self):
        for status in (403, 429):
            error = HTTPError(API_URL, status, 'Provider limit', {'Retry-After': '60'}, None)
            opener = Mock()
            opener.open.side_effect = error
            gate = Mock()
            with self.subTest(status=status), patch.object(fulltext, 'build_opener', return_value=opener):
                with self.assertRaises(HTTPError) as caught:
                    fulltext.download(API_URL, request_gate=gate)
                self.assertIs(caught.exception, error)
            opener.open.assert_called_once()
            gate.assert_called_once_with(API_URL, None)

    def test_paused_source_exception_is_propagated_without_request(self):
        paused = RuntimeError('Provider paused')
        opener = Mock()
        with patch.object(fulltext, 'build_opener', return_value=opener):
            with self.assertRaises(RuntimeError) as caught:
                fulltext.download(API_URL, request_gate=Mock(side_effect=paused))
        self.assertIs(caught.exception, paused)
        opener.open.assert_not_called()

    def test_search_and_xml_each_use_the_same_deadline_and_gate(self):
        search = {'resultList': {'result': [{'id': '123', 'isOpenAccess': 'Y', 'pmcid': 'PMC123'}]}}
        responses = [FakeResponse(json.dumps(search).encode()), FakeResponse(b'<article/>')]
        opener = Mock()
        opener.open.side_effect = responses
        clock = [0.0]
        gated = []
        def gate(url, deadline):
            gated.append((url, deadline))
            clock[0] += .5
        with patch.object(fulltext.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(fulltext, 'build_opener', return_value=opener):
            self.assertEqual(fulltext.fetch_oa(123, deadline=2, request_gate=gate), (b'<article/>', API_URL))
        self.assertEqual(len(gated), 2)
        self.assertIn('/search?', gated[0][0])
        self.assertEqual(gated[1], (API_URL, 2))
        self.assertEqual([call.kwargs['timeout'] for call in opener.open.call_args_list], [1.5, 1.0])

    def test_search_exhausting_budget_prevents_followup_xml_request(self):
        clock = [0.0]
        search = {'resultList': {'result': [{'id': '123', 'isOpenAccess': 'Y', 'pmcid': 'PMC123'}]}}
        response = FakeResponse(json.dumps(search).encode(), after_close=lambda: clock.__setitem__(0, 3))
        opener = Mock()
        opener.open.return_value = response
        gate = Mock()
        with patch.object(fulltext.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(fulltext, 'build_opener', return_value=opener):
            with self.assertRaises(TimeoutError):
                fulltext.fetch_oa('123', deadline=2, request_gate=gate)
        self.assertEqual(opener.open.call_count, 1)
        self.assertEqual(gate.call_count, 1)

    def test_elsevier_uses_only_official_api_and_headers_with_shared_budget(self):
        gate = Mock()
        with patch.dict(os.environ, {'ELSEVIER_API_KEY': 'synthetic-key', 'ELSEVIER_INST_TOKEN': 'synthetic-token'}), patch.object(fulltext, 'download', return_value=b'xml') as get:
            body, url = fulltext.fetch_elsevier('123', deadline=12, request_gate=gate)
        self.assertEqual(body, b'xml')
        self.assertEqual(url, 'https://api.elsevier.com/content/article/pubmed_id/123?view=FULL')
        self.assertNotIn('synthetic-key', url)
        self.assertNotIn('synthetic-token', url)
        self.assertEqual(get.call_args.args[1], {'X-ELS-APIKey': 'synthetic-key', 'X-ELS-Insttoken': 'synthetic-token', 'Accept': 'text/xml'})
        self.assertEqual(get.call_args.kwargs, {'deadline': 12, 'request_gate': gate})

    def test_sciencedirect_is_never_requested_or_given_a_gate_slot(self):
        for host in ('sciencedirect.com', 'www.sciencedirect.com', 'api.sciencedirect.com', 'www.sciencedirect.com.'):
            gate = Mock()
            with self.subTest(host=host), patch.object(fulltext, 'build_opener') as build:
                with self.assertRaises(fulltext.FulltextUnavailable):
                    fulltext.download('https://' + host + '/article', request_gate=gate)
                build.assert_not_called()
                gate.assert_not_called()

    def test_invalid_pmid_cannot_change_provider_request_path(self):
        for fetch in (fulltext.fetch_oa, fulltext.fetch_elsevier):
            with self.subTest(fetch=fetch.__name__), patch.object(fulltext, 'download') as get:
                with self.assertRaisesRegex(ValueError, 'PMID must be numeric'):
                    fetch('../other-path')
                get.assert_not_called()


if __name__ == '__main__':
    unittest.main()
