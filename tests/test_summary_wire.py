"""Integer citation wire tests using synthetic originals; no model or network."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from evidence import BASE_FIELDS, DETAIL_FIELDS, source_blocks, validate_evidence
import local_summary
from summary_repair import apply_repairs, repair_schema
from summary_wire import SourceAliases
from summarize_papers import validate_summary

BODY = ('Methods\nThe cohort included 60 adults.\nResults\nThe endpoint occurred in 17 adults.\n'
        'Limitations\nFollow-up was incomplete.\nTable 1: Endpoint in 17 adults.\nFigure 2: Cohort of 60 adults.')


def fixture():
    blocks = source_blocks(BODY)
    claims = dict.fromkeys((*BASE_FIELDS, *DETAIL_FIELDS, 'qa_1'), [])
    claims.update(summary_1=[blocks[1]['id']], summary_2=[blocks[3]['id']], summary_3=[blocks[5]['id']])
    data = {'summary_lines': ['성인 60명을 대상으로 연구를 수행했다.', '평가변수는 17명에서 발생했다.', '추적 관찰이 불완전했다.'],
            'structured': dict.fromkeys(BASE_FIELDS, 'Not reported'), 'clinical_relevance': 3,
            'research_details': dict.fromkeys(DETAIL_FIELDS, 'Not reported'),
            'qa': [{'q': '보고된 한계는?', 'a': 'Not reported'}], 'evidence': claims}
    return blocks, data


class SummaryWireTests(unittest.TestCase):
    def test_initial_response_restores_exact_locations_and_passes_existing_validators(self):
        blocks, canonical = fixture()
        aliases = SourceAliases(blocks)
        wire = copy.deepcopy(canonical)
        wire['evidence'] = {key: aliases.encode_refs(refs) for key, refs in canonical['evidence'].items()}
        before = copy.deepcopy(wire)
        decoded = aliases.decode_initial(wire)
        self.assertEqual(decoded, canonical)
        self.assertEqual(wire, before)
        raw = local_summary._initial_draft(json.dumps(decoded, ensure_ascii=False))
        result = local_summary._validated_summary(raw, {'title': 'Synthetic study'}, BODY)
        self.assertEqual(result['evidence']['claims'], canonical['evidence'])
        self.assertTrue(all(isinstance(ref, str) for refs in result['evidence']['claims'].values() for ref in refs))

    def test_alias_schema_changes_only_the_source_definition(self):
        blocks, _ = fixture()
        aliases = SourceAliases(blocks)
        canonical = local_summary._summary_schema(blocks)
        before = copy.deepcopy(canonical)
        encoded = aliases.schema(canonical)
        self.assertEqual(encoded['$defs']['source_id'], {'type': 'integer', 'enum': list(range(1, len(blocks) + 1))})
        encoded['$defs']['source_id'] = canonical['$defs']['source_id']
        self.assertEqual(encoded, canonical)
        self.assertEqual(canonical, before)

    def test_numbered_context_keeps_full_text_including_embedded_marker_like_text(self):
        blocks = [{'id': 'p-0000000', 'text': 'Original [p-0001400] label-like text: -4 and GPT-4o.\nKeep this line.'},
                  {'id': 'table-0001400', 'text': 'Original table spacing  0.050\t17'},
                  {'id': 'figure-0002800', 'text': 'Original figure caption.'}]
        aliases = SourceAliases(blocks)
        self.assertEqual(aliases.numbered(blocks), '\n'.join(f'[{i + 1}] ' + b['text'] for i, b in enumerate(blocks)))
        self.assertEqual(aliases.encode_refs([b['id'] for b in blocks]), [1, 2, 3])
        self.assertEqual(blocks[0]['text'], 'Original [p-0001400] label-like text: -4 and GPT-4o.\nKeep this line.')
        changed = copy.deepcopy(blocks)
        changed[0]['text'] = 'Different original under the same offset ID.'
        with self.assertRaisesRegex(ValueError, 'alias snapshot'):
            aliases.numbered(changed)

    def test_repair_subset_keeps_original_alias_numbers_and_canonical_validation(self):
        blocks, canonical = fixture()
        aliases = SourceAliases(blocks)
        excerpts = [blocks[3], blocks[5]]
        allowed = [b['id'] for b in excerpts]
        schema = aliases.schema(repair_schema(['summary_2'], allowed), allowed)
        self.assertEqual(schema['$defs']['source_id']['enum'], [4, 6])
        self.assertEqual(aliases.numbered(excerpts), '[4] ' + blocks[3]['text'] + '\n[6] ' + blocks[5]['text'])
        raw = local_summary._initial_draft(json.dumps(canonical, ensure_ascii=False))
        raw['evidence']['summary_2'] = [blocks[1]['id']]
        patch = {'summary_2': {'text': canonical['summary_lines'][1], 'sources': [4]}}
        decoded = aliases.decode_repairs(patch, allowed)
        repaired = apply_repairs(raw, decoded, ['summary_2'], allowed)
        validate_evidence(repaired, validate_summary(json.dumps(repaired)), BODY)
        self.assertEqual(repaired['evidence'], canonical['evidence'])
        self.assertEqual(patch['summary_2']['sources'], [4])
        with self.assertRaises(ValueError):
            aliases.decode_repairs({'summary_2': {'text': '새 문장.', 'sources': [2]}}, allowed)

    def test_model_alias_response_rejects_boolean_float_strings_range_and_duplicates(self):
        blocks, canonical = fixture()
        aliases = SourceAliases(blocks)
        invalid_refs = [[True], [False], [1.0], ['1'], [0], [-1], [len(blocks) + 1],
                        [1, 1], [blocks[1]['id']], [1, blocks[1]['id']], [[1]], None]
        for refs in invalid_refs:
            with self.subTest(refs=refs):
                data = copy.deepcopy(canonical)
                data['evidence'] = {'summary_1': refs}
                with self.assertRaises(ValueError):
                    aliases.decode_initial(data)
                with self.assertRaises(ValueError):
                    aliases.decode_repairs({'summary_1': {'text': '문장.', 'sources': refs}})

    def test_wire_decode_never_accepts_a_number_at_the_wrong_original_location(self):
        blocks, canonical = fixture()
        aliases = SourceAliases(blocks)
        wire = copy.deepcopy(canonical)
        wire['evidence'] = {key: aliases.encode_refs(refs) for key, refs in canonical['evidence'].items()}
        wire['evidence']['summary_2'] = [2]  # The methods contain 60, not the reported endpoint 17.
        raw = local_summary._initial_draft(json.dumps(aliases.decode_initial(wire), ensure_ascii=False))
        with self.assertRaisesRegex(ValueError, 'Number absent'):
            validate_evidence(raw, validate_summary(json.dumps(raw)), BODY)

    def test_exact_patch_keys_remain_enforced_after_alias_recovery(self):
        blocks, canonical = fixture()
        aliases = SourceAliases(blocks)
        raw = local_summary._initial_draft(json.dumps(canonical, ensure_ascii=False))
        patch = {'summary_1': {'text': canonical['summary_lines'][0], 'sources': [2]},
                 'summary_2': {'text': canonical['summary_lines'][1], 'sources': [4]}}
        with self.assertRaisesRegex(ValueError, 'exactly the failed claims'):
            apply_repairs(raw, aliases.decode_repairs(patch), ['summary_2'], list(aliases.ids))

    def test_derived_notes_markers_convert_without_changing_stored_notes(self):
        blocks, _ = fixture()
        aliases = SourceAliases(blocks)
        notes = '[' + blocks[1]['id'] + '] Six reported facts. [' + blocks[3]['id'] + '] Endpoint 17.'
        before = notes
        self.assertEqual(aliases.encode_markers(notes), '[2] Six reported facts. [4] Endpoint 17.')
        self.assertEqual(notes, before)
        with self.assertRaises(ValueError):
            aliases.encode_markers('[p-9999999] Unknown location.')
        with self.assertRaises(ValueError):
            aliases.encode_markers(notes, [blocks[1]['id']])

    def test_invalid_maps_and_allowed_sets_fail_before_request_building(self):
        blocks, _ = fixture()
        for bad in ([], [blocks[0], blocks[0]], [{'id': 1}], [{'id': 'p-1'}]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                SourceAliases(bad)
        aliases = SourceAliases(blocks)
        for bad in ([blocks[0]['id'], blocks[0]['id']], ['p-9999999'], [True], blocks[0]['id']):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                aliases.encode_refs([], bad)
        with self.assertRaises(ValueError):
            aliases.schema(local_summary._summary_schema(blocks), [])


if __name__ == '__main__':
    unittest.main()
