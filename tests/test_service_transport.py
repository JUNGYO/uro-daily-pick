"""Transport diagnosis is useful without retaining private response/request data."""
import json
from pathlib import Path
import ssl
import sys
import unittest
from urllib.error import HTTPError, URLError
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from institution_worker import Service, ServiceRequestError
from catalog_sync import failure_details


class ServiceTransportTests(unittest.TestCase):
    def setUp(self):
        self.service = Service.__new__(Service)
        self.service.config = {"url": "https://example.invalid", "public_key": "fixture-key"}
        self.service.opener = Mock()

    def check_error(self, error, category, status=None, attempts=4):
        self.service.opener.open.side_effect = error
        with patch("institution_worker.time.sleep"), self.assertRaises(ServiceRequestError) as caught:
            self.service.request("papers", params={"private": "fixture-secret"})
        detail = failure_details(caught.exception, "catalog_import")
        self.assertEqual(detail["category"], category)
        self.assertEqual(detail.get("http_status"), status)
        self.assertEqual(self.service.opener.open.call_count, attempts)
        self.assertNotIn("fixture-secret", str(caught.exception) + json.dumps(detail))
        self.assertNotIn("example.invalid", str(caught.exception) + json.dumps(detail))
        return caught.exception

    def test_http_retry_exhaustion_keeps_only_status_and_old_error_contract(self):
        error = self.check_error(HTTPError("https://example.invalid/fixture-secret", 503,
            "fixture-secret", {}, None), "http", 503)
        self.assertEqual(str(error), "Service temporarily unavailable")

    def test_rejected_metadata_keeps_existing_error_string_without_retry(self):
        error = self.check_error(HTTPError("https://example.invalid/fixture-secret", 400,
            "fixture-secret", {}, None), "http", 400, attempts=1)
        self.assertEqual(str(error), "Service HTTP 400")

    def test_timeout_and_wrapped_timeout_are_identifiable_without_private_reason(self):
        for error in (TimeoutError("fixture-secret"), URLError(TimeoutError("fixture-secret"))):
            with self.subTest(error=type(error).__name__):
                self.service.opener.reset_mock()
                self.check_error(error, "timeout")

    def test_other_connection_failures_remain_distinct_from_timeouts(self):
        self.check_error(URLError("fixture-secret"), "network")

    def test_certificate_verification_failure_is_not_retried_or_weakened(self):
        error = self.check_error(ssl.SSLCertVerificationError("fixture-secret"), "tls", attempts=1)
        self.assertEqual(str(error), "Service certificate verification failed")


if __name__ == "__main__":
    unittest.main()
