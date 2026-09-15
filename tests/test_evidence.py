import copy
import hashlib
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from evidence import source_blocks, validate_evidence, validate_metadata, DETAIL_FIELDS, BASE_FIELDS

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.body='Methods\nA cohort enrolled 60 participants.\nResults\nThe outcome occurred in 17 participants.\nTable 1: 17 outcomes.\nFigure 1: 17 outcomes.'
        self.blocks=source_blocks(self.body)
        self.summary={'summary_ko':'참가자 60명을 관찰했다.\n사건이 17명에서 발생했다.\n관찰 연구로 해석에 한계가 있다.','structured_data':dict.fromkeys(BASE_FIELDS,'Not reported'),'qa_data':[{'q':'결과는?','a':'17 participants'}]}
        self.raw={'research_details':dict.fromkeys(DETAIL_FIELDS,'Not reported'),'evidence':dict.fromkeys((*BASE_FIELDS,*DETAIL_FIELDS),[])}
        self.raw['evidence'].update(summary_1=[self.blocks[1]['id']],summary_2=[self.blocks[3]['id']],summary_3=[self.blocks[1]['id']],qa_1=[self.blocks[3]['id']])
    def test_stable_locations_include_table_and_figure_captions(self):
        self.assertTrue(self.blocks[-2]['id'].startswith('table-'))
        self.assertTrue(self.blocks[-1]['id'].startswith('figure-'))
        for b in self.blocks:self.assertEqual(b['text'],self.body[b['start']:b['end']])
        self.assertEqual(self.blocks,source_blocks(self.body))
    def test_valid_derived_metadata_has_identifiers_without_original_text(self):
        support=validate_evidence(self.raw,self.summary,self.body)
        validate_metadata(support['evidence'],support['research_details'])
        self.assertEqual(support['evidence']['content_hash'],hashlib.sha256(self.body.encode()).hexdigest())
        self.assertNotIn('content_text',support)
        self.assertNotIn(self.body,str(support))
    def test_number_elsewhere_in_article_does_not_validate_wrong_citation(self):
        self.raw['evidence']['summary_2']=[self.blocks[1]['id']]
        with self.assertRaisesRegex(ValueError,'Number absent'):validate_evidence(self.raw,self.summary,self.body)
    def test_unknown_location_and_unanchored_claim_are_rejected(self):
        for refs in (['p-9999999'],[],[self.blocks[1]['id']]*2):
            raw=copy.deepcopy(self.raw);raw['evidence']['summary_1']=refs
            with self.assertRaises(ValueError):validate_evidence(raw,self.summary,self.body)
    def test_cloud_metadata_rejects_source_text(self):
        support=validate_evidence(self.raw,self.summary,self.body)
        support['evidence']['claims']['summary_1']=[self.body]
        with self.assertRaises(ValueError):validate_metadata(support['evidence'],support['research_details'])

if __name__=='__main__':unittest.main()
