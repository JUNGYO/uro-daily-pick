"""Collection retry scheduling against local synthetic SQLite state only."""
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from institution_worker import next_retry, prepare_collection_attempts, record_collection_attempt


class CollectionRetryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "queue.sqlite3"
        self.db = sqlite3.connect(self.path)
        self.db.execute("CREATE TABLE attempts(pmid TEXT PRIMARY KEY,status TEXT,next_retry REAL)")
        self.db.executemany("INSERT INTO attempts VALUES(?,?,?)", [
            ("1", "retryable_error", 1900), ("2", "ready", 0), ("3", "access_required", 604900)])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.directory.cleanup()

    def test_legacy_upgrade_preserves_existing_queues_and_deadlines(self):
        self.db.execute("CREATE TABLE collection_attempts(pmid TEXT PRIMARY KEY,status TEXT,next_retry REAL)")
        self.db.execute("INSERT INTO collection_attempts VALUES('1','access_required',700000)")
        self.db.commit()
        before = self.db.execute("SELECT * FROM attempts ORDER BY pmid").fetchall()
        prepare_collection_attempts(self.db)
        prepare_collection_attempts(self.db)
        self.assertEqual(self.db.execute("SELECT * FROM collection_attempts ORDER BY pmid").fetchall(),
                         [("1", "access_required", 700000), ("3", "access_required", 604900)])
        self.assertEqual(self.db.execute("SELECT * FROM attempts ORDER BY pmid").fetchall(), before)
        self.assertEqual([r[1] for r in self.db.execute("PRAGMA table_info(collection_attempts)")],
                         ["pmid", "status", "next_retry"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM collection_retry_metadata").fetchone()[0], 0)

    def test_repeated_failure_persists_progressive_backoff_with_one_day_cap(self):
        prepare_collection_attempts(self.db)
        clock = 10000
        for delay in (900, 3600, 21600, 86400, 86400):
            with patch("institution_worker.time.time", return_value=clock):
                retry_at = record_collection_attempt(self.db, "9", "retryable_error", "article_table_unavailable")
            self.assertEqual(retry_at, clock + delay)
            self.assertEqual(self.db.execute("SELECT count(*) FROM collection_attempts WHERE pmid='9' AND next_retry<=?", [retry_at - 1]).fetchone()[0], 0)
            self.assertEqual(self.db.execute("SELECT count(*) FROM collection_attempts WHERE pmid='9' AND next_retry<=?", [retry_at]).fetchone()[0], 1)
            self.db.close()
            self.db = sqlite3.connect(self.path)
            prepare_collection_attempts(self.db)
            clock = retry_at
        self.assertEqual(self.db.execute("SELECT consecutive_failures FROM collection_retry_metadata WHERE pmid='9'").fetchone()[0], 5)

    def test_success_resets_streak_and_leaves_summary_attempt_untouched(self):
        prepare_collection_attempts(self.db)
        summary_before = self.db.execute("SELECT * FROM attempts ORDER BY pmid").fetchall()
        for now in (10000, 11000, 15000):
            record_collection_attempt(self.db, "1", "retryable_error", "navigation_error", now)
        self.assertEqual(record_collection_attempt(self.db, "1", "ready", now=40000), 0)
        self.assertIsNone(self.db.execute("SELECT * FROM collection_retry_metadata WHERE pmid='1'").fetchone())
        self.assertEqual(record_collection_attempt(self.db, "1", "retryable_error", "navigation_error", 50000), 50900)
        self.assertEqual(self.db.execute("SELECT * FROM attempts ORDER BY pmid").fetchall(), summary_before)
        self.assertEqual(next_retry("retryable_error", 50000), 50900)

    def test_reason_or_status_change_resets_streak_and_access_policy_stays_seven_days(self):
        prepare_collection_attempts(self.db)
        for now in (10000, 11000, 15000):
            record_collection_attempt(self.db, "9", "retryable_error", "article_table_unavailable", now)
        self.assertEqual(record_collection_attempt(self.db, "9", "retryable_error", "navigation_error", 40000), 40900)
        self.assertEqual(record_collection_attempt(self.db, "9", "access_required", "http_403", 50000), 50000 + 7 * 86400)
        self.assertEqual(record_collection_attempt(self.db, "9", "retryable_error", "navigation_error", 700000), 700900)
        self.assertEqual(record_collection_attempt(self.db, "9", "challenge", "publisher_check", 800000), 886400)

    def test_metadata_is_bounded_and_queue_update_rolls_back_if_metadata_write_fails(self):
        prepare_collection_attempts(self.db)
        record_collection_attempt(self.db, "9", "retryable_error", "https://example.test/private-article?body=text", 10000)
        self.assertEqual(self.db.execute("SELECT reason FROM collection_retry_metadata WHERE pmid='9'").fetchone()[0], "unspecified")
        self.db.execute("CREATE TRIGGER fail_retry_metadata BEFORE INSERT ON collection_retry_metadata BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            record_collection_attempt(self.db, "9", "retryable_error", "navigation_error", 50000)
        self.assertEqual(self.db.execute("SELECT next_retry FROM collection_attempts WHERE pmid='9'").fetchone()[0], 10900)
        self.assertEqual(self.db.execute("SELECT reason FROM collection_retry_metadata WHERE pmid='9'").fetchone()[0], "unspecified")


if __name__ == "__main__":
    unittest.main()
