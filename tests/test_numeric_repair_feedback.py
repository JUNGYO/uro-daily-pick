"""Numeric repair instructions preserve evidence checks and never invent totals."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from evidence import BASE_FIELDS, DETAIL_FIELDS, source_blocks
from summary_repair import numeric_repair_feedback


def claim(body, value, key='sample_size', cited_line=0):
    refs = [source_blocks(body)[cited_line]['id']]
    data = {
        'summary_ko': '연구의 설계와 모집 방법을 검토했다.\n연구 결과와 그 근거를 함께 검토했다.\n연구의 한계를 고려하여 결과를 해석한다.',
        'structured': dict.fromkeys(BASE_FIELDS, 'Not reported'),
        'research_details': dict.fromkeys(DETAIL_FIELDS, 'Not reported'),
        'clinical_relevance': 3,
        'qa': [{'q': '이 연구에서 확인한 결과는 무엇인가?', 'a': '보고된 결과를 검토했다.'}],
        'evidence': {key: refs},
    }
    if key.startswith('qa_'):
        data['qa'][0]['a'] = value
    elif key in BASE_FIELDS:
        data['structured'][key] = value
    else:
        data['research_details'][key] = value
    return data


class NumericRepairFeedbackTests(unittest.TestCase):
    def feedback(self, data, body, key='sample_size'):
        return numeric_repair_feedback(data, {key: 'Failed evidence check'}, body)[key]

    def test_total_99_is_not_inferred_from_explicit_group_counts(self):
        body = 'The treatment group enrolled 48 patients and the control group enrolled 51 patients.'
        data = claim(body, '99 patients (48 treatment and 51 control)')
        before = copy.deepcopy(data)
        result = self.feedback(data, body)
        self.assertEqual(result['absent_from_cited'], ['99'])
        self.assertEqual(result['present_elsewhere_in_body'], [])
        self.assertEqual(result['absent_from_body'], ['99'])
        self.assertIn('group labels', result['sample_size_guidance'])
        self.assertIn('Never add group counts', result['sample_size_guidance'])
        self.assertEqual(data, before)
        self.assertNotIn(body, json.dumps(result))
        self.assertNotIn(data['evidence']['sample_size'][0], json.dumps(result))

    def test_missing_group_citation_and_unstated_total_are_distinguished(self):
        body = 'The control group enrolled 33 children.\nThe treatment group enrolled 34 children.'
        result = self.feedback(claim(body, '67 children (34 treatment and 33 control)'), body)
        self.assertEqual(result['absent_from_cited'], ['34', '67'])
        self.assertEqual(result['present_elsewhere_in_body'], ['34'])
        self.assertEqual(result['absent_from_body'], ['67'])
        self.assertIn('same study, population, outcome and time point', result['guidance'])
        self.assertIn('a numeric match alone is insufficient', result['guidance'])

    def test_number_elsewhere_does_not_assign_a_new_citation(self):
        body = 'Follow-up occurred at the clinic.\nResults were assessed at 3 months.'
        data = claim(body, '3 months', key='follow_up')
        refs = copy.deepcopy(data['evidence'])
        result = self.feedback(data, body, key='follow_up')
        self.assertEqual(result['absent_from_cited'], ['3'])
        self.assertEqual(result['present_elsewhere_in_body'], ['3'])
        self.assertEqual(result['absent_from_body'], [])
        self.assertEqual(data['evidence'], refs)

    def test_adjacent_table_counts_are_not_concatenated_into_total(self):
        body = 'Table cells: group A=622; group B=330.'
        result = self.feedback(claim(body, '622,330 patients'), body)
        self.assertEqual(result['absent_from_body'], ['622330'])
        self.assertIn('concatenate', result['sample_size_guidance'])

    def test_explicit_prose_total_is_not_mislabeled_as_a_fabricated_total(self):
        body = 'A total of 622 330 participants were enrolled.'
        result = self.feedback(claim(body, '622,330 participants'), body)
        self.assertEqual(result['absent_from_cited'], [])
        self.assertEqual(result['absent_from_body'], [])

    def test_decimal_feedback_is_exact_and_canonical_without_rounding(self):
        body = 'No numeric endpoint was reported.'
        result = self.feedback(claim(body, '.050 and 17.0 and -0.060', key='outcome'), body, 'outcome')
        self.assertEqual(result['absent_from_body'], ['-0.06', '0.05', '17'])

    def test_unsupported_notation_is_not_treated_as_a_verified_absent_value(self):
        body = 'The group included 3 patients.'
        result = self.feedback(claim(body, '1e3 patients'), body)
        self.assertEqual(result['numeric_check'], 'unsupported_numeric_notation')
        self.assertNotIn('absent_from_body', result)

    def test_qa_question_values_are_checked_even_when_answer_is_supported(self):
        body = 'The endpoint occurred in 17 participants.'
        data = claim(body, '17 participants', key='qa_1')
        data['qa'][0]['q'] = '18명에서 발생한 사건은 무엇인가?'
        result = self.feedback(data, body, 'qa_1')
        self.assertEqual(result['absent_from_cited'], [])
        self.assertEqual(result['question_absent_from_body'], ['18'])

    def test_feedback_bounds_count_and_length_without_partial_numeric_values(self):
        body = 'A qualitative result was reported.'
        value = ', '.join(map(str, range(21, 36))) + '; ' + ('9' * 90)
        result = self.feedback(claim(body, value), body)
        self.assertEqual(result['absent_from_body'], list(map(str, range(21, 33))))
        self.assertEqual(result['omitted_value_count'], 8)
        self.assertNotIn('9' * 80, json.dumps(result))


if __name__ == '__main__':
    unittest.main()
