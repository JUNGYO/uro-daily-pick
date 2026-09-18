"""Regressions for the observed production gateway/empty-response failures."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import get_json, patch_fields, supabase_headers


def response(status=200, body=None):
    result = requests.Response()
    result.status_code = status
    result._content = body if body is not None else b'[{"id": 1}]'
    result._content_consumed = True
    return result


class ReadRecoveryTests(unittest.TestCase):
    def test_opaque_key_and_legacy_jwt_header_contracts(self):
        self.assertEqual(supabase_headers("sb_secret_test"), {"apikey": "sb_secret_test"})
        self.assertEqual(supabase_headers("sb_publishable_test"), {"apikey": "sb_publishable_test"})
        self.assertEqual(supabase_headers("legacy.jwt.token"),
                         {"apikey": "legacy.jwt.token", "Authorization": "Bearer legacy.jwt.token"})

    @patch("common.time.sleep")
    def test_gateway_timeout_then_empty_body_then_success(self, sleep):
        with patch("common.requests.get", side_effect=[response(522), response(body=b""), response()]) as get:
            self.assertEqual(get_json("https://example.test", headers={"apikey": "test"}), [{"id": 1}])
        self.assertEqual(get.call_count, 3)
        self.assertEqual(get.call_args.kwargs["headers"]["Connection"], "close")
        self.assertEqual(sleep.call_count, 2)

    @patch("common.time.sleep")
    def test_read_timeout_exhaustion_is_bounded_and_redacted(self, sleep):
        with patch("common.requests.get", side_effect=requests.Timeout("sensitive-url")) as get:
            with self.assertRaisesRegex(requests.RequestException, "after 4 attempts") as caught:
                get_json("https://example.test", headers={"apikey": "test"})
        self.assertNotIn("sensitive", str(caught.exception))
        self.assertIn("(timeout)", str(caught.exception))
        self.assertEqual(get.call_count, 4)
        self.assertEqual(sleep.call_count, 3)

    @patch("common.time.sleep")
    def test_access_failure_is_not_retried(self, sleep):
        with patch("common.requests.get", return_value=response(403)) as get:
            with self.assertRaises(requests.HTTPError):
                get_json("https://example.test", headers={})
        self.assertEqual(get.call_count, 1)
        sleep.assert_not_called()

    @patch("common.time.sleep")
    def test_final_read_failure_category_has_no_response_or_request_details(self, sleep):
        for category, failure in [("http HTTP 504", response(504, b"private-response")),
                                  ("invalid_json", response(body=b"private-response")),
                                  ("connection", requests.ConnectionError("private-url"))]:
            with self.subTest(category=category):
                kwargs = {"side_effect": failure} if isinstance(failure, Exception) else {"return_value": failure}
                with patch("common.requests.get", **kwargs), self.assertRaises(requests.RequestException) as caught:
                    get_json("https://example.test/private-url", headers={"apikey": "private-key"}, attempts=2)
                message = str(caught.exception)
                self.assertIn(f"({category})", message)
                self.assertNotIn("private", message)

    @patch("common.time.sleep")
    def test_final_transient_error_reports_only_valid_database_code(self, sleep):
        for code in ("57014", "40P01", "XX000", "PGRST003"):
            with self.subTest(code=code):
                sleep.reset_mock()
                body = json.dumps({"code": code, "message": "private message",
                                   "details": "private SQL", "hint": "private hint"}).encode()
                with patch("common.requests.get", return_value=response(500, body)) as get:
                    with self.assertRaises(requests.RequestException) as caught:
                        get_json("https://example.test/private-url", headers={"apikey": "private-key"})
                self.assertEqual(str(caught.exception),
                                 f"Database read failed after 4 attempts (http HTTP 500 code {code})")
                self.assertEqual(get.call_count, 4)
                self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 4, 8])

    @patch("common.time.sleep")
    def test_malformed_database_codes_cannot_expose_response_details(self, sleep):
        codes = ("57014\n", "57014 private-key", "pgrst003", "PGRST03", "PGRST0034",
                 "private-url", 57014, ["57014"], {"secret": "private-key"}, None)
        for code in codes:
            with self.subTest(code=code):
                body = json.dumps({"code": code, "message": "private response"}).encode()
                with patch("common.requests.get", return_value=response(500, body)):
                    with self.assertRaises(requests.RequestException) as caught:
                        get_json("https://example.test/private-url", headers={"apikey": "private-key"}, attempts=1)
                self.assertEqual(str(caught.exception), "Database read failed after 1 attempts (http HTTP 500)")
        sleep.assert_not_called()

    @patch("common.time.sleep")
    def test_non_object_and_non_json_error_bodies_keep_http_category(self, sleep):
        for body in (b"", b"<html>private gateway failure</html>", b'["57014", "private-key"]',
                     b'"private message"', b'null', b'{"message":"private response"}'):
            with self.subTest(body=body):
                with patch("common.requests.get", return_value=response(503, body)):
                    with self.assertRaises(requests.RequestException) as caught:
                        get_json("https://example.test/private-url", headers={"apikey": "private-key"}, attempts=1)
                self.assertEqual(str(caught.exception), "Database read failed after 1 attempts (http HTTP 503)")
        sleep.assert_not_called()

    @patch("common.time.sleep")
    def test_final_failure_does_not_reuse_prior_database_code(self, sleep):
        with patch("common.requests.get", side_effect=[response(500, b'{"code":"57014"}'),
                                                       requests.Timeout("private message")]):
            with self.assertRaises(requests.RequestException) as caught:
                get_json("https://example.test/private-url", headers={"apikey": "private-key"}, attempts=2)
        self.assertEqual(str(caught.exception), "Database read failed after 2 attempts (timeout)")
        sleep.assert_called_once_with(2)


class WriteRecoveryTests(unittest.TestCase):
    @patch("common.time.sleep")
    def test_gateway_after_commit_retries_the_identical_field_assignment(self, sleep):
        data = {"summary_ko": "one\ntwo\nthree", "summary_source_hash": "unchanged"}
        with patch("common.requests.patch", side_effect=[response(504), requests.Timeout(), response(204)]) as save:
            patch_fields("https://example.test/papers", headers={}, params={"id": "eq.1257"}, data=data)
        self.assertEqual(save.call_count, 3)
        self.assertTrue(all(call.kwargs["json"] == data for call in save.call_args_list))
        self.assertTrue(all(call.kwargs["params"] == {"id": "eq.1257"} for call in save.call_args_list))

    @patch("common.time.sleep")
    def test_permission_errors_are_not_retried_and_exhaustion_is_bounded(self, sleep):
        with patch("common.requests.patch", return_value=response(403)) as save, self.assertRaises(requests.HTTPError):
            patch_fields("https://example.test", headers={}, params={}, data={})
        self.assertEqual(save.call_count, 1)
        with patch("common.requests.patch", side_effect=requests.Timeout("private details")) as save:
            with self.assertRaisesRegex(requests.RequestException, "write failed after 4 attempts") as error:
                patch_fields("https://example.test", headers={}, params={}, data={})
        self.assertNotIn("private", str(error.exception))
        self.assertEqual(save.call_count, 4)


if __name__ == "__main__":
    unittest.main()
