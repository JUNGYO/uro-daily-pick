import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, call

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import refresh_integrity as refresh
from fetch_papers import IncompletePubMedResponse


class IntegrityRefreshTests(unittest.TestCase):
    def test_retries_only_missing_and_keeps_verified_records(self):
        first = {'pmid': '1'}
        second = {'pmid': '2'}
        with patch.object(refresh, 'fetch_details', side_effect=[
            IncompletePubMedResponse([first], ['2']), [second]
        ]) as fetch, patch.object(refresh.time, 'sleep'):
            self.assertEqual(refresh.fetch_integrity_details(['1', '2']), ([first, second], []))
        self.assertEqual(fetch.call_args_list, [call(['1', '2']), call(['2'])])

    def test_persistent_missing_records_are_deferred(self):
        with patch.object(refresh, 'fetch_details', side_effect=[
            IncompletePubMedResponse([{'pmid': '1'}], ['2']),
            IncompletePubMedResponse([], ['2'])
        ]), patch.object(refresh.time, 'sleep'):
            self.assertEqual(refresh.fetch_integrity_details(['1', '2']), ([{'pmid': '1'}], ['2']))

    def test_identity_errors_are_not_downgraded(self):
        with patch.object(refresh, 'fetch_details', side_effect=ValueError('foreign identifier')) as fetch:
            with self.assertRaisesRegex(ValueError, 'foreign identifier'):
                refresh.fetch_integrity_details(['1'])
        self.assertEqual(fetch.call_count, 1)

    def test_partial_batch_preserves_missing_records_and_continues_next_batch(self):
        rows = [{'pmid': str(n), 'integrity_status': 'current', 'related_notices': []} for n in range(101)]
        rows[1]['integrity_status'] = 'retracted'
        rows[1]['related_notices'] = [{'pmid': '999', 'relation': 'RetractionIn'}]
        def paper(n):
            return dict(pmid=str(n), volume='', issue='', pages='', publication_types=[],
                        integrity_status='current', related_notices=[], integrity_checked_at='2026-09-29')
        with patch.dict(os.environ, {'SUPABASE_URL': 'https://example.test', 'SUPABASE_SERVICE_KEY': 'test', 'GITHUB_STEP_SUMMARY': ''}), \
             patch.object(refresh, 'get_json', return_value=rows), \
             patch.object(refresh, 'fetch_integrity_details', side_effect=[([paper(n) for n in range(1, 100)], ['0']), ([paper(100)], [])]) as fetch, \
             patch.object(refresh, 'patch_fields') as write, patch.object(refresh.time, 'sleep'):
            refresh.main()
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(write.call_count, 100)
        self.assertNotIn('eq.0', [c.kwargs['params']['pmid'] for c in write.call_args_list])
        self.assertEqual(write.call_args_list[0].kwargs['data']['integrity_status'], 'retracted')
        self.assertEqual(write.call_args_list[0].kwargs['data']['related_notices'], rows[1]['related_notices'])

    def test_all_unavailable_is_still_a_failure_without_writes(self):
        with patch.dict(os.environ, {'SUPABASE_URL': 'https://example.test', 'SUPABASE_SERVICE_KEY': 'test', 'GITHUB_STEP_SUMMARY': ''}), \
             patch.object(refresh, 'get_json', return_value=[{'pmid': '1'}]), \
             patch.object(refresh, 'fetch_integrity_details', return_value=([], ['1'])), \
             patch.object(refresh, 'patch_fields') as write, patch.object(refresh.time, 'sleep'):
            with self.assertRaisesRegex(SystemExit, 'No requested citation'):
                refresh.main()
        write.assert_not_called()
