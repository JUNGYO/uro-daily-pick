"""Synthetic-only numeric format regressions; no model, document, or service I/O."""
import copy
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from evidence import BASE_FIELDS, DETAIL_FIELDS, numeric_values, source_blocks, validate_evidence
import local_summary
from summarize_papers import validate_summary
from summary_wire import SourceAliases


def draft(body, value):
    location = source_blocks(body)[0]['id']
    claims = {key: [] for key in (*BASE_FIELDS, *DETAIL_FIELDS, 'qa_1')}
    claims.update({key: [location] for key in ('summary_1', 'summary_2', 'summary_3')})
    return {
        'summary_ko': f'보고된 값은 {value}이었다.\n연구 결과를 보고했다.\n연구의 한계를 확인했다.',
        'structured': dict.fromkeys(BASE_FIELDS, 'Not reported'),
        'clinical_relevance': 3,
        'qa': [{'q': '보고된 값은?', 'a': 'Not reported'}],
        'research_details': dict.fromkeys(DETAIL_FIELDS, 'Not reported'),
        'evidence': claims,
    }


def model_reply(value, body):
    wire = copy.deepcopy(value)
    aliases = SourceAliases(source_blocks(body))
    if 'evidence' in wire:
        wire['evidence'] = {key: aliases.encode_refs(refs) for key, refs in wire['evidence'].items()}
    else:
        for change in wire.values():
            change['sources'] = aliases.encode_refs(change['sources'])
    return json.dumps(wire, ensure_ascii=False)


class NumericEvidenceTests(unittest.TestCase):
    def test_source_ordinals_first_through_twentieth_are_exact_and_source_only(self):
        ordinals = ('first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
                    'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
                    'eighteenth', 'nineteenth', 'twentieth')
        for number, ordinal in enumerate(ordinals, start=1):
            with self.subTest(ordinal=ordinal):
                self.assertEqual(numeric_values(ordinal.upper() + ' assessment', source=True), {Decimal(number)})
                self.assertEqual(numeric_values(ordinal + ' assessment'), set())
        self.assertEqual(numeric_values('third-line therapy', source=True), {Decimal(3)})
        self.assertNotIn(Decimal(1), numeric_values('twenty-first assessment', source=True))

    def test_tertiary_is_numeric_only_for_explicit_care_or_referral_centers(self):
        for source in ('tertiary care hospital', 'TERTIARY-CARE institution',
                       'tertiary referral center', 'tertiary referral centres'):
            with self.subTest(source=source):
                self.assertEqual(numeric_values(source, source=True), {Decimal(3)})
                self.assertEqual(numeric_values(source), set())
        for source in ('tertiary outcome', 'tertiary prevention', 'tertiary protein structure'):
            self.assertEqual(numeric_values(source, source=True), set())

    def test_only_narrow_whole_decade_phrases_supply_ten_in_the_source(self):
        for source in ('the first decade', 'a decade', 'one decade', 'the past decade', 'the last decade'):
            with self.subTest(source=source):
                self.assertIn(Decimal(10), numeric_values(source, source=True))
                self.assertEqual(numeric_values(source), set())
        for source in ('a century', 'decades', 'two decades', 'second decade',
                       'half a decade', 'half of the last decade', 'a quarter of a decade',
                       'one-half a decade', 'one and a half decades', 'a fraction of one decade'):
            with self.subTest(source=source):
                self.assertNotIn(Decimal(10), numeric_values(source, source=True))

    def test_ascii_grouping_requires_explicit_total_prose_and_exact_groups(self):
        for source, expected in [('A total of 622 330 solid organ transplant recipients', 622330),
                                 ('total of 1 234 567 participants', 1234567),
                                 ('A TOTAL OF 12 345 patients', 12345)]:
            with self.subTest(source=source):
                self.assertEqual(numeric_values(source, source=True), {Decimal(expected)})
                self.assertNotIn(Decimal(expected), numeric_values(source))
        for source in ('622 330', 'Group A 622; Group B 330', 'total of 622\n330',
                       'total of\n622 330', 'total of 622\t330', 'total of 62 33',
                       'total of 622 330 45', 'total of 622 and 330'):
            with self.subTest(source=source):
                self.assertNotIn(Decimal(622330), numeric_values(source, source=True))
        self.assertEqual(numeric_values('622 330', source=True), {Decimal(622), Decimal(330)})

    def test_proven_ordinal_duration_and_total_formats_pass_the_real_evidence_path(self):
        cases = [('The third referral institution conducted this study.', '3'),
                 ('The study took place at a tertiary care institution.', '3'),
                 ('The results describe the first decade of follow-up.', '10'),
                 ('A total of 622 330 solid organ transplant recipients were included.', '622,330')]
        for body, value in cases:
            with self.subTest(source=body):
                raw = draft(body, value)
                with patch.object(local_summary, 'chat', return_value=model_reply(raw, body)) as chat:
                    result = local_summary.generate_summary({'title': 'Synthetic source format'}, {'content_text': body})
                self.assertEqual(chat.call_count, 1)
                self.assertEqual(result['evidence']['claims'], raw['evidence'])

    def test_source_normalization_does_not_allow_changed_quantities_rounding_or_arithmetic(self):
        for body, value in [('The third referral institution conducted the study.', '4'),
                            ('A tertiary care institution conducted the study.', '33'),
                            ('The first decade was evaluated.', '100'),
                            ('The first decade was evaluated.', '9.9'),
                            ('A total of 622 330 patients were included.', '622,331'),
                            ('A total of 622 330 patients were included.', '622,300'),
                            ('A total of 622 and 330 patients were included.', '952'),
                            ('Half a decade was evaluated.', '10')]:
            with self.subTest(source=body, claim=value):
                raw = draft(body, value)
                with self.assertRaisesRegex(ValueError, 'Number absent'):
                    validate_evidence(raw, validate_summary(json.dumps(raw)), body)
        body = 'The first decade was evaluated.\nThe outcome was reported in a separate cohort.'
        raw = draft(body, '10')
        raw['evidence']['summary_1'] = [source_blocks(body)[1]['id']]
        with self.assertRaisesRegex(ValueError, 'Number absent'):
            validate_evidence(raw, validate_summary(json.dumps(raw)), body)

    def test_known_identifier_hyphens_keep_positive_version_values(self):
        for label, value in [('GPT-4o', 4), ('gpt-4o', 4), ('GPT-5', 5),
                             ('PD-1', 1), ('PD-L1', 1), ('IL-6', 6),
                             ('GPT\u20114o', 4), ('GPT\u20104o', 4), ('GPT\u22124o', 4)]:
            with self.subTest(label=label):
                self.assertEqual(numeric_values(label), {Decimal(value)})
        for value in ('X-4', 'HR-4', 'CHANGE-4', 'change-4', 'change -4',
                      'value=-4', '변화-4', '-4', '\u22124'):
            with self.subTest(value=value):
                self.assertEqual(numeric_values(value), {Decimal(-4)})
        self.assertEqual(numeric_values('17-20'), {Decimal(17), Decimal(20)})

    def test_identifier_format_equivalence_does_not_erase_versions_or_numeric_signs(self):
        for source, claim in [('GPT4o', 'GPT-4o'), ('GPT\u20114o', 'GPT-4o'),
                              ('GPT-4o', 'gpt-4o'), ('PD1', 'PD-1'), ('IL\u20116', 'IL-6')]:
            with self.subTest(source=source, claim=claim):
                body = 'Synthetic identifier ' + source + ' was evaluated.'
                raw = draft(body, claim)
                validate_evidence(raw, validate_summary(json.dumps(raw)), body)
        for source, claim in [('GPT-5o', 'GPT-4o'), ('GPT-4o', 'GPT-5o'),
                              ('IL-6', 'IL-7'), ('measured -4 units', 'GPT-4o'),
                              ('GPT-4o', '-4'), ('measured -6 units', 'IL-6')]:
            with self.subTest(source=source, claim=claim):
                body = 'Synthetic observation: ' + source
                raw = draft(body, claim)
                with self.assertRaisesRegex(ValueError, 'Number absent'):
                    validate_evidence(raw, validate_summary(json.dumps(raw)), body)

    def test_exact_equivalent_formats_have_the_same_decimal_value(self):
        for source, claim in [('.05', '0.05'), ('0.050', '0.05'), ('1\u2009234', '1,234'),
                              ('1\u00a0234', '1234'), ('1\u202f234', '1234'), ('17.', '17'),
                              ('0.050.', '.05'), ('-0.05', '\u22120.050'), ('+17.0', '17')]:
            with self.subTest(source=source, claim=claim):
                self.assertEqual(numeric_values(source, source=True), numeric_values(claim))
        self.assertEqual(numeric_values('six patients', source=True), {Decimal(6)})

    def test_each_equivalent_format_passes_both_real_validation_stages(self):
        for source, claim in [('.05 percent', '0.05'), ('0.050 percent', '0.05'),
                              ('1\u2009234 patients', '1,234'), ('17.', '17'), ('\u22120.050 units', '-0.05')]:
            with self.subTest(source=source, claim=claim):
                body = 'The reported measurement was ' + source
                raw = draft(body, claim)
                with patch.object(local_summary, 'chat', return_value=model_reply(raw, body)) as chat:
                    result = local_summary.generate_summary({'title': 'Synthetic format test'}, {'content_text': body})
                self.assertEqual(chat.call_count, 1)
                self.assertEqual(result['evidence']['content_hash'], hashlib.sha256(body.encode()).hexdigest())
                self.assertEqual(result['evidence']['claims'], raw['evidence'])

    def test_different_values_signs_or_grouping_are_not_equivalent(self):
        for source, claim in [('0.06', '.05'), ('17.5', '17'), ('-17', '17'), ('17', '-17'),
                              ('\u221217', '17'), ('1.234', '1,234'), ('1,23', '123'),
                              ('1\u200923', '123'), ('1,234\u2009567', '1234567'),
                              ('0.05000000000000000000001', '0.05'), ('1.2.3', '1.2')]:
            with self.subTest(source=source, claim=claim):
                body = 'The reported measurement was ' + source
                raw = draft(body, claim)
                with self.assertRaisesRegex(ValueError, 'Number absent'):
                    validate_evidence(raw, validate_summary(json.dumps(raw)), body)

    def test_comma_grouping_does_not_become_a_decimal_or_partial_number(self):
        self.assertEqual(numeric_values('1,234,567.00'), {Decimal('1234567')})
        for invalid in ('1,23', '12,34,567', '0.05\u2009123', '1.2.3', '1,234\u2009567'):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, 'Invalid numeric grouping'):
                    numeric_values(invalid)
                self.assertEqual(numeric_values(invalid, source=True), set())

    def test_ranges_and_signed_numbers_keep_their_signs(self):
        self.assertEqual(numeric_values('17-20; 17\u201320'), {Decimal(17), Decimal(20)})
        self.assertEqual(numeric_values('value=-17; (\u221220); +6'), {Decimal(-17), Decimal(-20), Decimal(6)})
        self.assertEqual(numeric_values('값은-17'), {Decimal(-17)})

    def test_scientific_notation_is_neither_converted_nor_split_into_supporting_numbers(self):
        for value in ('1e3', '1E-3', '.5e+2', '10^3', '10^{-3}', '10\u207b\u00b3', '2 \u00d7 10^3'):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, 'Unsupported scientific notation'):
                    numeric_values(value)
                self.assertEqual(numeric_values(value, source=True), set())
        self.assertFalse(numeric_values('1000').issubset(numeric_values('1e3', source=True)))

    def test_equal_number_elsewhere_cannot_replace_correct_source_location(self):
        body = 'The first measurement was 0.050.\nThe second measurement was 0.06.'
        raw = draft(body, '0.05')
        raw['evidence']['summary_1'] = [source_blocks(body)[1]['id']]
        with self.assertRaisesRegex(ValueError, 'Number absent'):
            validate_evidence(raw, validate_summary(json.dumps(raw)), body)
        raw['evidence']['summary_1'] = ['p-9999999']
        with self.assertRaisesRegex(ValueError, 'Invalid source location'):
            validate_evidence(raw, validate_summary(json.dumps(raw)), body)

    def test_global_question_number_guard_keeps_exact_values_and_rejects_different_values(self):
        body = 'The measurement was 0.050.'
        raw = draft(body, '0.05')
        raw['qa'][0]['q'] = '0.05가 보고되었는가?'
        with patch.object(local_summary, 'chat', return_value=model_reply(raw, body)):
            self.assertIn('summary_ko', local_summary.generate_summary({'title': 'Synthetic'}, {'content_text': body}))
        unsupported = copy.deepcopy(raw)
        unsupported['qa'][0]['q'] = '0.06이 보고되었는가?'
        still_unsupported = {'qa_1': {**unsupported['qa'][0], 'sources': unsupported['evidence']['qa_1']}}
        with patch.object(local_summary, 'chat', side_effect=[model_reply(value, body)
                for value in (unsupported, still_unsupported, still_unsupported)]) as chat:
            with self.assertRaisesRegex(ValueError, 'qa_1'):
                local_summary.generate_summary({'title': 'Synthetic'}, {'content_text': body})
            self.assertEqual(chat.call_count, 3)
            for call in chat.call_args_list[1:]:
                self.assertEqual(set(json.loads(call.args[1])['failed_claims']), {'qa_1'})


if __name__ == '__main__':
    unittest.main()
