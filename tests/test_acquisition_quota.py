"""Synthetic quota boundaries; never contact a publisher or touch real state."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from acquisition_quota import (AcquisitionDeferred, Quota, before_download, download_scope,
                               groups_for_url, initialize, paper_publishers)


class QuotaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.policy = self.root / "acquisition-policy.json"
        self.config = {"version": 1, "starts_at": "2026-10-13T00:00:00+09:00", "timezone": "Asia/Seoul",
                       "daily_limit": 30, "manual_reserve": 0}
        self.policy.write_text(json.dumps(self.config))
        initialize(self.policy)
        self.now = datetime.fromisoformat("2026-10-13T01:00:00+09:00")
        self.quota = Quota(self.policy, now=lambda: self.now)

    def tearDown(self):
        self.temp.cleanup()

    def assertDenied(self, reason, operation):
        with self.assertRaises(AcquisitionDeferred) as caught:
            operation()
        self.assertEqual(caught.exception.reason, reason)

    def test_30th_allowed_31st_denied_and_other_publisher_independent(self):
        for _ in range(30):
            self.quota.reserve(["springer-nature"])
        self.assertDenied("quota_daily_limit", lambda: self.quota.reserve(["springer-nature"]))
        restarted = Quota(self.policy, now=lambda: self.now)
        self.assertDenied("quota_daily_limit", lambda: restarted.reserve(["springer-nature"]))
        restarted.reserve(["wiley"])
        status = restarted.status()["publishers"]
        self.assertEqual(status["springer-nature"]["automatic"], 30)
        self.assertEqual(status["wiley"]["automatic"], 1)

    def test_repository_publisher_mappings_keep_shared_daily_limits(self):
        sbu = paper_publishers({"doi": "10.1590/S1677-5538.IBJU.2026.0023"})
        self.assertEqual(sbu, ["brazilian-society-of-urology"])
        self.assertEqual(paper_publishers({"doi": "10.1590/S9999-1234.2026.1"}), [])
        self.assertEqual(paper_publishers({"doi": "10.1590/S1677-55380.2026.1"}), [])
        legacy = paper_publishers({"doi": "", "journal": "The Canadian journal of urology"})
        self.assertEqual(legacy, ["cju-communications", "tech-science-press"])
        self.assertEqual(paper_publishers({"doi": "", "journal": "Canadian Urological Association journal"}), [])
        self.assertEqual(paper_publishers({"doi": "10.32604/cju.2026.1"}), ["tech-science-press"])
        self.quota.reserve(legacy, amount=29)
        self.quota.reserve(groups_for_url("https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML", legacy))
        self.assertDenied("quota_daily_limit", lambda: self.quota.reserve(groups_for_url(
            "https://pmc-oa-opendata.s3.amazonaws.com/PMC1.1/PMC1.1.xml", legacy)))
        self.assertDenied("quota_daily_limit", lambda: self.quota.reserve(["tech-science-press"]))
        self.quota.reserve(sbu, amount=30)
        self.assertDenied("quota_daily_limit", lambda: self.quota.reserve(sbu))

    def test_korean_midnight_and_clock_rollback(self):
        self.now = datetime.fromisoformat("2026-10-12T14:59:59+00:00")
        self.assertDenied("quota_not_started", lambda: self.quota.reserve(["bmj"]))
        self.now = datetime.fromisoformat("2026-10-12T15:00:00+00:00")
        self.quota.reserve(["bmj"], amount=30)
        self.now = datetime.fromisoformat("2026-10-13T14:59:59+00:00")
        self.assertDenied("quota_daily_limit", lambda: self.quota.reserve(["bmj"]))
        self.now = datetime.fromisoformat("2026-10-13T15:00:00+00:00")
        self.quota.reserve(["bmj"])
        self.now = datetime.fromisoformat("2026-10-12T15:00:00+00:00")
        self.assertDenied("quota_clock_rollback", lambda: self.quota.reserve(["wiley"]))

    def test_concurrent_reservations_never_overshoot(self):
        def attempt(_):
            try:
                self.quota.reserve(["jama"])
                return 1
            except AcquisitionDeferred:
                return 0
        with ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(sum(pool.map(attempt, range(60))), 30)

    def test_separate_processes_share_one_ledger(self):
        code = """
from acquisition_quota import Quota,AcquisitionDeferred
from datetime import datetime
import sys
q=Quota(sys.argv[1],now=lambda:datetime.fromisoformat('2026-10-13T01:00:00+09:00'))
accepted=0
for _ in range(20):
 try:q.reserve(['wiley']);accepted+=1
 except AcquisitionDeferred:pass
print(accepted)
"""
        processes = [subprocess.Popen([sys.executable, "-c", code, str(self.policy)],
                                     cwd=Path(__file__).resolve().parents[1] / "scripts",
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(4)]
        results = [p.communicate(timeout=30) for p in processes]
        self.assertTrue(all(p.returncode == 0 for p in processes), results)
        self.assertEqual(sum(int(out) for out, _ in results), 30)

    def test_missing_corrupt_ledger_or_policy_fail_closed(self):
        ledger = self.root / "acquisition-quota.sqlite3"
        ledger.unlink()
        self.assertDenied("quota_ledger_unavailable", lambda: self.quota.reserve(["jama"]))
        self.assertFalse(ledger.exists())
        ledger.write_bytes(b"invalid sqlite")
        self.assertDenied("quota_ledger_unavailable", lambda: self.quota.reserve(["jama"]))
        self.policy.write_text("broken")
        self.assertDenied("quota_policy_unavailable", lambda: self.quota.reserve(["jama"]))

    def test_manual_reservation_and_recorded_downloads_reduce_automatic_capacity(self):
        self.config["manual_reserve"] = 10
        self.policy.write_text(json.dumps(self.config))
        self.quota.reserve(["bmj"], amount=20)
        self.assertDenied("quota_daily_limit", lambda: self.quota.reserve(["bmj"]))
        self.quota.reserve(["bmj"], amount=10, manual=True)
        self.assertDenied("quota_daily_limit", lambda: self.quota.reserve(["bmj"], manual=True))
        self.quota.reserve(["jama"], amount=12, manual=True)
        self.quota.reserve(["jama"], amount=18)
        self.assertDenied("quota_daily_limit", lambda: self.quota.reserve(["jama"]))

    def test_aliases_redirect_destination_and_unknown_repository(self):
        expected = paper_publishers({"doi": "10.1111/example"})
        self.assertEqual(groups_for_url("https://media.springernature.com/image.png", expected), ["springer-nature", "wiley"])
        self.assertEqual(groups_for_url("https://www.nature.com/articles/example"), ["springer-nature"])
        self.assertEqual(groups_for_url("https://bjui-journals.onlinelibrary.wiley.com/image.png"), ["wiley"])
        self.assertDenied("quota_unknown_publisher", lambda: groups_for_url("https://pmc.ncbi.nlm.nih.gov/articles/PMC1/"))
        self.assertDenied("quota_unknown_publisher", lambda: groups_for_url("https://wiley.com.attacker.invalid/body"))
        self.quota.reserve(["wiley"], amount=30)
        self.assertDenied("quota_daily_limit", lambda: self.quota.reserve(["springer-nature", "wiley"]))
        self.assertEqual(self.quota.status()["publishers"]["springer-nature"]["automatic"], 0)

    def test_failed_transport_does_not_consume_budget_and_image_shares_it(self):
        import fulltext
        import article_images
        def actual_quota(path):
            return self.quota
        with patch.dict(os.environ, {"URO_ACQUISITION_POLICY": str(self.policy)}), \
             patch("acquisition_quota.Quota", side_effect=actual_quota):
            self.quota.reserve(["wiley"], amount=28)
            with download_scope({"doi": "10.1111/example"}):
                with patch.object(fulltext, "build_opener") as opener:
                    opener.return_value.open.side_effect = OSError("synthetic transport failure")
                    with self.assertRaises(OSError):
                        fulltext.download("https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML")
                with patch.object(article_images, "build_opener") as image_opener:
                    image_opener.return_value.open.side_effect = OSError("synthetic transport failure")
                    with self.assertRaises(OSError):
                        article_images.fetch_bytes("https://onlinelibrary.wiley.com/image.png")
            self.assertEqual(self.quota.status()["publishers"]["wiley"]["automatic"], 28)

    def test_confirmed_failure_releases_only_its_own_reservation_once(self):
        self.quota.reserve(['wiley'], amount=29)
        receipt = self.quota.reserve(['wiley'], tracked=True)['request_id']
        self.assertDenied('quota_daily_limit', lambda: self.quota.reserve(['wiley']))
        self.quota.settle(receipt, failed=True, reason='transport_error')
        self.quota.settle(receipt, failed=True, reason='transport_error')
        self.assertEqual(self.quota.status()['publishers']['wiley']['automatic'], 29)
        self.assertDenied('quota_unknown_request', lambda: self.quota.settle('a'*32, failed=True))
        self.assertEqual(self.quota.status()['publishers']['wiley']['automatic'], 29)

    def test_downloaded_request_cannot_later_be_refunded(self):
        receipt = self.quota.reserve(['wiley','springer-nature'], tracked=True)['request_id']
        self.quota.settle(receipt)
        self.quota.settle(receipt, failed=True, reason='transport_error')
        self.assertEqual(self.quota.status()['publishers']['wiley']['automatic'], 1)
        self.assertEqual(self.quota.status()['publishers']['springer-nature']['automatic'], 1)

    def test_crashed_or_unsettled_request_stays_reserved(self):
        self.quota.reserve(['jama'], tracked=True)
        restarted = Quota(self.policy, now=lambda:self.now)
        self.assertEqual(restarted.status()['publishers']['jama']['automatic'], 1)

    def test_failure_after_midnight_changes_original_day_only(self):
        receipt = self.quota.reserve(['wiley'], tracked=True)['request_id']
        self.now = datetime.fromisoformat('2026-10-14T00:00:01+09:00')
        self.quota.reserve(['wiley'])
        self.quota.settle(receipt, failed=True, reason='transport_error')
        self.assertEqual(self.quota.status()['publishers']['wiley']['automatic'], 1)
        with closing(sqlite3.connect(self.root/'acquisition-quota.sqlite3')) as db:
            self.assertEqual(db.execute("SELECT automatic FROM usage WHERE day='2026-10-13' AND publisher='wiley'").fetchone()[0], 0)

    def test_concurrent_failure_settlement_cannot_double_refund(self):
        self.quota.reserve(['wiley'], amount=29)
        receipt = self.quota.reserve(['wiley'], tracked=True)['request_id']
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _:self.quota.settle(receipt, failed=True), range(16)))
        self.assertEqual(self.quota.status()['publishers']['wiley']['automatic'], 29)

    def test_403_is_uncharged_but_pauses_publisher_across_processes(self):
        import fulltext
        with patch.dict(os.environ, {'URO_ACQUISITION_POLICY':str(self.policy)}), \
             patch('acquisition_quota.Quota', return_value=self.quota), \
             download_scope({'doi':'10.1001/example'}), patch.object(fulltext,'build_opener') as opener:
            opener.return_value.open.side_effect = HTTPError('https://jamanetwork.com/article',403,'Forbidden',{},None)
            with self.assertRaises(HTTPError):fulltext.download('https://jamanetwork.com/article')
            self.assertEqual(self.quota.status()['publishers']['jama']['automatic'], 0)
            opener.return_value.open.reset_mock()
            self.assertDenied('quota_source_paused', lambda:fulltext.download('https://jamanetwork.com/another'))
            opener.return_value.open.assert_not_called()
        restarted = Quota(self.policy, now=lambda:self.now)
        self.assertDenied('quota_source_paused',lambda:restarted.reserve(['jama']))
        restarted.reserve(['bmj'])

    def test_received_body_counts_even_when_later_parsing_fails(self):
        import article_images
        with patch.dict(os.environ, {'URO_ACQUISITION_POLICY':str(self.policy)}), \
             patch('acquisition_quota.Quota',return_value=self.quota), \
             download_scope({'doi':'10.1111/example'}), patch.object(article_images,'build_opener') as opener:
            opener.return_value.open.return_value.__enter__.return_value.read.return_value=b'not an image'
            body=article_images.fetch_bytes('https://onlinelibrary.wiley.com/image.png')
            with self.assertRaises(ValueError):article_images.image_type(body)
        self.assertEqual(self.quota.status()['publishers']['wiley']['automatic'],1)

    def test_metadata_and_local_work_do_not_consume_quota(self):
        with patch.dict(os.environ, {"URO_ACQUISITION_POLICY": str(self.policy)}):
            before_download("https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=synthetic")
        self.assertTrue(all(v["automatic"] == 0 for v in self.quota.status()["publishers"].values()))
        with self.assertRaises(FileExistsError):
            initialize(self.policy)

    def test_oversized_limit_and_pause_cannot_download(self):
        self.config["daily_limit"] = 31
        self.policy.write_text(json.dumps(self.config))
        self.assertDenied("quota_policy_unavailable", lambda: self.quota.reserve(["jama"]))
        self.config.update(daily_limit=30, paused=True)
        self.policy.write_text(json.dumps(self.config))
        self.assertDenied("quota_not_started", lambda: self.quota.reserve(["jama"]))


if __name__ == "__main__":
    unittest.main()
