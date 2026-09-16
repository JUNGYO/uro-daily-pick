"""A cache priority hint never substitutes for source and claim verification."""
import copy
import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import local_summary as spark
from test_summary_repair import BODY, PAPER, draft


class SummaryCheckpointTests(unittest.TestCase):
    def checkpoint(self, value=None):
        return {'source_hash': hashlib.sha256((spark.CACHE_VERSION + '\n' + PAPER['title'] + '\n' + BODY).encode()).hexdigest(),
                'draft': draft() if value is None else value}

    def test_valid_source_bound_draft_becomes_canonical_verified_summary(self):
        result = spark.validate_draft_summary(self.checkpoint(), PAPER, {'content_text': BODY})
        self.assertEqual(result, spark._validated_summary(draft(), PAPER, BODY))
        self.assertEqual(result['summary_ko'].count('\n'), 2)

    def test_stale_source_or_unsupported_number_cannot_be_promoted(self):
        checkpoint = self.checkpoint()
        for paper, body in (({**PAPER, 'title': 'Changed title'}, BODY), (PAPER, BODY + ' Changed body')):
            with self.assertRaises(ValueError):
                spark.validate_draft_summary(checkpoint, paper, {'content_text': body})
        invalid = copy.deepcopy(draft())
        invalid['structured']['sample_size'] = '999 adults'
        with self.assertRaises(ValueError):
            spark.validate_draft_summary(self.checkpoint(invalid), PAPER, {'content_text': BODY})


if __name__ == '__main__':
    unittest.main()
