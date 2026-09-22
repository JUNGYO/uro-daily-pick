import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from document_layout import validate_layout
from fulltext import parse_document
from institution_worker import save_json
from rebuild_reading_layout import rebuild, rebuild_result


class DocumentLayoutTests(unittest.TestCase):
    def test_rebuild_retries_transient_locks_but_reports_persistent_failure(self):
        with patch('rebuild_reading_layout.time.sleep'), patch('rebuild_reading_layout.rebuild') as run:
            run.side_effect = [PermissionError(), 'restored']
            self.assertEqual(rebuild_result('123.json', True)['status'], 'restored')
            self.assertEqual(run.call_count, 2)
            run.reset_mock()
            run.side_effect = PermissionError()
            result = rebuild_result('123.json', True)
            self.assertEqual(result['status'], 'validation_failed')
            self.assertEqual(run.call_count, 3)

    def xml(self):
        return ('<article><body><sec><title>Methods</title><p>' + 'An intact sentence. ' * 80
                + '</p><sec><title>Statistics</title><p>Reported HR 0.72 and P &lt; 0.05.</p></sec>'
                '<table-wrap><label>Table 1</label><table><thead><tr><th>Group</th><th>N</th></tr></thead>'
                '<tbody><tr><td rowspan="2">A</td><td>123</td></tr><tr><td>🧬 456</td></tr></tbody>'
                '</table></table-wrap><fig><label>Figure 1</label><caption><p>Study flow.</p></caption></fig>'
                '</sec><sec><title>Results</title><p>All 579 participants remain represented.</p>'
                '</sec></body></article>').encode()

    def test_xml_preserves_native_paragraphs_headings_tables_and_captions(self):
        doc = parse_document(self.xml())
        text = doc['content_text']
        layout = validate_layout(doc['reading_layout'], text, doc['content_hash'])
        long = next(b for b in layout['blocks'] if text[b['start']:b['end']].startswith('An intact'))
        self.assertEqual(long['kind'], 'paragraph')
        self.assertGreater(long['end']-long['start'], 1400)
        table = next(b for b in layout['blocks'] if b['kind'] == 'table')
        self.assertEqual([[text[c['start']:c['end']] for c in row] for row in table['rows']],
                         [['Group','N'], ['A','123'], ['🧬 456']])
        self.assertEqual(table['rows'][1][0]['rowspan'], 2)
        self.assertTrue(table['rows'][0][0]['header'])
        self.assertTrue(any(b['kind']=='figure' for b in layout['blocks']))
        # New structure is additive; the established source string/hash are stable.
        canonical = '\n\n'.join(s['title']+'\n'+s['text'] for s in doc['sections'])
        self.assertEqual(text, canonical)
        self.assertEqual(hashlib.sha256(canonical.encode()).hexdigest(), doc['content_hash'])

    def test_html_table_cells_remain_distinct_without_publisher_markup(self):
        raw = ('<article><h2>Results</h2><p>'+'Outcome. '*80+'</p><table><tr>'
               '<th>Intervention</th><th>HR</th></tr><tr><td><em>A</em></td><td>0.72</td></tr>'
               '</table><p>Last sentence.</p></article>').encode()
        doc = parse_document(raw)
        table = next(b for b in doc['reading_layout']['blocks'] if b['kind']=='table')
        self.assertEqual(doc['content_text'][table['rows'][1][1]['start']:table['rows'][1][1]['end']], '0.72')
        self.assertNotIn('<em>', json.dumps(doc['reading_layout']))

    def test_incomplete_or_overlapping_layout_cannot_replace_a_saved_original(self):
        doc = parse_document(self.xml())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'original.json'
            save_json(path, {'document':doc})
            before = path.read_bytes()
            for mutation in ('drop_tail','overlap','wrong_hash','drop_cell'):
                invalid=copy.deepcopy(doc)
                layout=invalid['reading_layout']
                if mutation=='drop_tail': layout['blocks'].pop()
                elif mutation=='overlap': layout['blocks'][1]['start']=0
                elif mutation=='wrong_hash': layout['content_hash']='0'*64
                else: next(b for b in layout['blocks'] if b['kind']=='table')['rows'][-1].pop()
                with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                    save_json(path, {'document':invalid})
                self.assertEqual(path.read_bytes(), before)

    def test_backfill_is_resumable_and_never_changes_original_or_summary(self):
        doc=parse_document(self.xml())
        del doc['reading_layout']
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory).resolve()/'123.json'
            path.write_text(json.dumps({'document':doc}),encoding='utf-8')
            path.with_suffix('.xml').write_bytes(self.xml())
            before=path.read_bytes()
            self.assertEqual(rebuild(path), 'verified_dry_run')
            self.assertFalse(path.with_suffix('.layout.json').exists())
            self.assertEqual(rebuild(path,apply=True), 'restored')
            self.assertEqual(rebuild(path,apply=True), 'already_verified')
            self.assertEqual(path.read_bytes(),before)
            sidecar=path.with_suffix('.layout.json')
            sidecar.unlink()
            path.with_suffix('.xml').write_bytes(self.xml().replace(b'579',b'580'))
            self.assertEqual(rebuild(path,apply=True), 'source_version_differs')
            self.assertFalse(sidecar.exists())
            self.assertEqual(path.read_bytes(),before)


if __name__=='__main__': unittest.main()
