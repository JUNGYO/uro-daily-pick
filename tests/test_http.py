"""Regressions for the observed production gateway/empty-response failures."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import get_json, supabase_headers


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
        self.assertEqual(get.call_count, 4)
        self.assertEqual(sleep.call_count, 3)

    @patch("common.time.sleep")
    def test_access_failure_is_not_retried(self, sleep):
        with patch("common.requests.get", return_value=response(403)) as get:
            with self.assertRaises(requests.HTTPError):
                get_json("https://example.test", headers={})
        self.assertEqual(get.call_count, 1)
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
