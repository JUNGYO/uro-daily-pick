import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import bootstrap_admin_metrics as metrics


def progress(cursor, *, processed=2, high_water=10, complete=False):
    return dict(processed=processed, cursor=cursor, high_water_id=high_water, complete=complete)


def response(status, data):
    return Mock(status_code=status, json=Mock(return_value=data))


class AdminMetricsBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.log = io.StringIO()
        self.redirect = contextlib.redirect_stdout(self.log)
        self.redirect.__enter__()

    def tearDown(self):
        self.redirect.__exit__(None, None, None)

    @patch.object(metrics.time, "sleep")
    def test_uncertain_request_retries_without_client_generated_cursor(self, sleep):
        ack = progress(8)
        with patch.object(metrics.requests, "post", side_effect=[requests.Timeout("private"), response(200, ack)]) as post:
            self.assertEqual(metrics.bootstrap_batch("https://example.test", "secret", 200), ack)
        self.assertEqual(post.call_count, 2)
        for call in post.call_args_list:
            self.assertEqual(call.kwargs["json"], {"p_limit": 200})
            self.assertEqual(call.kwargs["timeout"], (10, 30))

    def test_finishes_from_existing_durable_checkpoint_and_accepts_already_done(self):
        for acknowledgements in ([progress(8), progress(10, complete=True)],
                                 [progress(10, processed=0, complete=True)]):
            with self.subTest(acknowledgements=acknowledgements), \
                    patch.object(metrics, "bootstrap_batch", side_effect=acknowledgements) as batch:
                self.assertTrue(metrics.initialize("url", "key"))
            self.assertEqual(batch.call_count, len(acknowledgements))

    def test_known_transaction_failures_reduce_size_and_keep_the_cap(self):
        for code in ("57014", "40P01"):
            with self.subTest(code=code), patch.object(metrics, "bootstrap_batch", side_effect=[
                metrics.BootstrapError("failed", code), progress(5), progress(10, complete=True),
            ]) as batch:
                self.assertTrue(metrics.initialize("url", "key", batch_size=25))
            self.assertEqual([c.args[2] for c in batch.call_args_list], [25, 12, 12])

    def test_unknown_and_singleton_failures_are_not_reported_as_complete(self):
        for error, size in [(metrics.BootstrapError("unknown", "XX000"), 200),
                            (metrics.BootstrapError("singleton", "57014"), 1)]:
            with self.subTest(size=size), patch.object(metrics, "bootstrap_batch", side_effect=error) as batch:
                with self.assertRaises(metrics.BootstrapError):
                    metrics.initialize("url", "key", batch_size=size)
            batch.assert_called_once()

    def test_budget_expiry_keeps_server_checkpoint_and_returns_incomplete(self):
        with patch.object(metrics.time, "monotonic", side_effect=[0, 0, 1801]), \
                patch.object(metrics, "bootstrap_batch", return_value=progress(5)) as batch:
            self.assertFalse(metrics.initialize("url", "key"))
        batch.assert_called_once()
        self.assertIn("committed progress is preserved", self.log.getvalue())

    def test_checkpoint_regression_stall_or_target_change_fails(self):
        for second in [progress(4), progress(5), progress(7, high_water=11)]:
            with self.subTest(second=second), patch.object(metrics, "bootstrap_batch", side_effect=[progress(5), second]):
                with self.assertRaisesRegex(metrics.BootstrapError, "checkpoint"):
                    metrics.initialize("url", "key")

    @patch.object(metrics.time, "sleep")
    def test_retry_errors_redact_details_and_are_bounded(self, sleep):
        for code, attempts in [("57014", 2), ("40P01", 2), ("XX000", 4), ("57014 private", 4)]:
            with self.subTest(code=code), patch.object(metrics.requests, "post", return_value=response(
                    500, {"code": code, "details": "secret", "message": "private SQL"})) as post:
                with self.assertRaises(metrics.BootstrapError) as caught:
                    metrics.bootstrap_batch("url", "secret", 200)
            self.assertEqual(post.call_count, attempts)
            self.assertNotIn("private", str(caught.exception))
            self.assertNotIn("secret", str(caught.exception))
        with patch.object(metrics.requests, "post", side_effect=[
                response(500, {"code": "57014"}), requests.Timeout("private"),
                requests.Timeout("private"), requests.Timeout("private")]):
            with self.assertRaises(metrics.BootstrapError) as caught:
                metrics.bootstrap_batch("url", "key", 200)
        self.assertIsNone(caught.exception.code, "A transport failure must not reuse an earlier SQLSTATE")

    def test_invalid_acknowledgements_and_rejected_access_fail_without_retry(self):
        for value in [None, [], {}, progress(-1), progress(11), progress(3, processed=201),
                      progress(8, complete=True),
                      progress(1, processed=True), progress(1, processed=0), progress(1, complete=1)]:
            with self.subTest(value=value), patch.object(metrics.requests, "post", return_value=response(200, value)) as post:
                with self.assertRaisesRegex(metrics.BootstrapError, "acknowledgement"):
                    metrics.bootstrap_batch("url", "key", 200)
            post.assert_called_once()
        with patch.object(metrics.requests, "post", return_value=response(403, {"message": "private"})) as post:
            with self.assertRaisesRegex(metrics.BootstrapError, "HTTP 403"):
                metrics.bootstrap_batch("url", "key", 200)
        post.assert_called_once()


if __name__ == "__main__":
    unittest.main()
