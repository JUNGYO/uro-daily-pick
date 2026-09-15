import hashlib
import http.client
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fulltext_viewer import Archive, SupabaseIdentity, ViewerError, ViewerServer, WindowLimit

ORIGIN = "https://reader.example.test"
TOKEN = "fixture." + "a" * 32
BODY = "Synthetic article body for local testing.\n" * 20


class ViewerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for name in ("documents", "cloud-archive"):
            (self.root / name).mkdir()
        self.document = {"title": "Synthetic title", "doi": "10.0000/fixture",
                         "document": {"content_text": BODY, "content_hash": hashlib.sha256(BODY.encode()).hexdigest()}}
        (self.root / "documents/12345.json").write_text(json.dumps(self.document), encoding="utf-8")
        self.identity = Mock()
        self.archive = Archive(self.root)
        self.server = ViewerServer(0, self.archive, self.identity, ORIGIN)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path="/v1/fulltext/12345", method="GET", headers=None):
        client = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        client.request(method, path, headers=headers if headers is not None else {
            "Origin": ORIGIN, "Authorization": "Bearer " + TOKEN})
        response = client.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        client.close()
        return result

    def test_verified_owner_can_read_hash_checked_plain_text(self):
        status, headers, body = self.request()
        self.assertEqual(status, 200)
        self.identity.authorize.assert_called_once_with(TOKEN)
        self.assertEqual(json.loads(body)["content_text"], BODY)
        self.assertIn("no-store", headers["Cache-Control"])
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertNotIn("documents", body.decode())

    def test_no_login_does_not_read_article(self):
        self.server.archive = Mock()
        status, _, body = self.request(headers={"Origin": ORIGIN})
        self.assertEqual(status, 401)
        self.server.archive.read.assert_not_called()
        self.identity.authorize.assert_not_called()
        self.assertNotIn(BODY.encode(), body)

    def test_denied_and_expired_identity_do_not_read_article(self):
        for status in (401, 403, 503):
            with self.subTest(status=status):
                self.server.archive = Mock()
                self.identity.authorize.side_effect = ViewerError(status, "denied")
                self.assertEqual(self.request()[0], status)
                self.server.archive.read.assert_not_called()

    def test_untrusted_origin_and_query_tokens_are_rejected(self):
        for headers in ({}, {"Origin": "https://untrusted.example", "Authorization": "Bearer " + TOKEN}):
            self.assertEqual(self.request(headers=headers)[0], 403)
        for path in ("/v1/fulltext/12345?token=" + TOKEN, "/documents/12345.json", "/v1/fulltext/../config", "/v1/fulltext/%2e%2e", "/"):
            self.assertEqual(self.request(path)[0], 404)
        self.identity.authorize.assert_not_called()

    def test_preflight_is_narrow_and_has_no_body(self):
        headers = {"Origin": ORIGIN, "Access-Control-Request-Method": "GET",
                   "Access-Control-Request-Headers": "authorization"}
        status, response_headers, body = self.request(method="OPTIONS", headers=headers)
        self.assertEqual((status, body), (204, b""))
        self.assertEqual(response_headers["Access-Control-Allow-Methods"], "GET")
        headers["Access-Control-Request-Method"] = "POST"
        self.assertEqual(self.request(method="OPTIONS", headers=headers)[0], 403)
        self.assertEqual(self.request(method="POST")[0], 501)
        self.identity.authorize.assert_not_called()

    def test_missing_corrupt_and_archived_articles(self):
        self.assertEqual(self.request("/v1/fulltext/99999")[0], 404)
        self.document["document"]["content_text"] += "changed"
        path = self.root / "documents/12345.json"
        path.write_text(json.dumps(self.document), encoding="utf-8")
        self.assertEqual(self.request()[0], 503)
        self.document["document"]["content_text"] = BODY
        (self.root / "cloud-archive/12345.json").write_text(json.dumps(self.document), encoding="utf-8")
        self.assertEqual(self.request()[0], 200)

    def test_rate_limit_before_identity_and_minimal_health(self):
        self.server.limit = WindowLimit(maximum=0)
        self.assertEqual(self.request()[0], 429)
        self.identity.authorize.assert_not_called()
        self.assertEqual(json.loads(self.request("/health", headers={})[2]), {"status": "ok"})

    def add_figure(self):
        image = b'\x89PNG\r\n\x1a\n' + b'synthetic local image'
        asset = hashlib.sha256(image).hexdigest()
        folder = self.root / 'documents/12345.images'
        folder.mkdir()
        (folder / asset).write_bytes(image)
        manifest = {'content_hash': self.document['document']['content_hash'], 'status': 'complete',
                    'source_url': 'https://publisher.example/private', 'figures': [
                        {'key': 'figure-1', 'label': 'Figure 1', 'caption': 'Study flow', 'asset_id': asset,
                         'content_type': 'image/png', 'status': 'ready', 'local_path': 'private-path'}]}
        (self.root / 'documents/12345.images.json').write_text(json.dumps(manifest))
        return asset, image

    def test_image_uses_owner_auth_and_no_store_without_exposing_paths(self):
        asset, image = self.add_figure()
        path = '/v1/fulltext/12345/images/' + asset
        status, headers, body = self.request(path)
        self.assertEqual((status, body), (200, image))
        self.assertEqual(headers['Content-Type'], 'image/png')
        self.assertIn('no-store', headers['Cache-Control'])
        article = self.request()[2]
        self.assertNotIn(b'private', article)
        self.assertEqual(self.request(path, headers={'Origin': ORIGIN})[0], 401)
        self.identity.authorize.side_effect = ViewerError(403, 'access_denied')
        self.assertEqual(self.request(path)[0], 403)

    def test_corrupt_image_and_stale_manifest_fail_without_hiding_body(self):
        asset, _ = self.add_figure()
        path = '/v1/fulltext/12345/images/' + asset
        (self.root / 'documents/12345.images' / asset).write_bytes(b'corrupt image')
        self.assertEqual(self.request(path)[0], 503)
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.request('/v1/fulltext/12345/images/' + '0' * 64)[0], 404)
        manifest = self.root / 'documents/12345.images.json'
        value = json.loads(manifest.read_text())
        value['content_hash'] = 'old-body'
        manifest.write_text(json.dumps(value))
        self.assertEqual(json.loads(self.request()[2])['figures'], [])
        self.assertEqual(self.request(path)[0], 404)


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.identity = SupabaseIdentity("https://project.supabase.co", "sb_publishable_fixture", "owner@example.test", "owner-id")
        self.identity.opener = Mock()

    def user(self, **overrides):
        user = {"id": "owner-id", "email": "owner@example.test", "email_confirmed_at": "2026-01-01"}
        user.update(overrides)
        self.identity.opener.open.return_value = io.BytesIO(json.dumps(user).encode())

    def test_real_auth_endpoint_required_and_owner_is_pinned(self):
        self.user()
        self.identity.authorize(TOKEN)
        request = self.identity.opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://project.supabase.co/auth/v1/user")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
        for changes in ({"email": "someone@example.test"}, {"id": "another-id"},
                        {"email_confirmed_at": None}, {"is_anonymous": True}):
            self.user(**changes)
            with self.assertRaises(ViewerError) as result:
                self.identity.authorize(TOKEN)
            self.assertEqual(result.exception.status, 403)

    def test_identity_errors_fail_closed_without_leaking_details(self):
        for error, status in [(URLError("private detail"), 503),
                              (HTTPError("private", 401, "expired", {}, None), 401),
                              (HTTPError("private", 302, "redirect", {}, None), 503)]:
            self.identity.opener.open.side_effect = error
            with self.assertRaises(ViewerError) as result:
                self.identity.authorize(TOKEN)
            self.assertEqual(result.exception.status, status)
            self.assertNotIn("private", result.exception.code)


if __name__ == "__main__":
    unittest.main()
