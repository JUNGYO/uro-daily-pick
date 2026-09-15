import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from refresh_integrity import merge_integrity

class IntegrityTests(unittest.TestCase):
    def test_incomplete_response_cannot_clear_retraction(self):
        notice={'pmid':'123','relation':'RetractionIn'}
        old={'integrity_status':'retracted','related_notices':[notice]}
        result=merge_integrity(old,{'integrity_status':'current','related_notices':[],'volume':'7'})
        self.assertEqual(result['integrity_status'],'retracted')
        self.assertEqual(result['related_notices'],[notice])
        self.assertEqual(result['volume'],'7')

    def test_new_concern_preserves_correction_without_duplicate(self):
        notice={'pmid':'123','relation':'ErratumIn'}
        concern={'pmid':'456','relation':'ExpressionOfConcernIn'}
        old={'integrity_status':'corrected','related_notices':[notice]}
        result=merge_integrity(old,{'integrity_status':'concern','related_notices':[notice,concern]})
        self.assertEqual(result['integrity_status'],'concern')
        self.assertEqual(result['related_notices'],[notice,concern])
