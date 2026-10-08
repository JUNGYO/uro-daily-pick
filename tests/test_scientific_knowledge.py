import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from xml.etree import ElementTree as ET

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from scientific_knowledge import validate, accepted, date_record, pubmed_metadata, bibliography, publication
from knowledge import KnowledgeStore

TEXT='Among 195 men, adjusted HR 0.70 (95% confidence interval 0.50 to 0.90) was reported for recurrence at 12 months.'
EVIDENCE=[{'location':'p-0000000','quote':TEXT}]
RESULT={'measure':'HR','estimate':'0.70','ci_low':'0.50','ci_high':'0.90','ci_level':'95','outcome':'recurrence',
        'population':'195 men','comparison':None,'timepoint':'12 months','unit':None,'adjustment':'adjusted','evidence':EVIDENCE}

class ScientificKnowledgeTests(unittest.TestCase):
    def test_context_and_estimates_must_be_in_the_exact_quote(self):
        value={'facts':[{'field':'sample_size','value':'195 men','evidence':EVIDENCE}],'results':[RESULT]}
        self.assertEqual(validate(value,{'p-0000000':TEXT}),value)
        for key,bad in [('estimate','0.71'),('population','195 women'),('ci_high','0.60'),('adjustment','unadjusted'),('ci_level',None),('measure','OR')]:
            test=copy.deepcopy(value);test['results'][0][key]=bad
            with self.subTest(key=key), self.assertRaises(ValueError):validate(test,{'p-0000000':TEXT+' 195 women 0.71'})

    def test_range_is_not_a_confidence_interval(self):
        test=copy.deepcopy(RESULT);text=TEXT.replace('confidence interval','interquartile range')
        test['evidence']=[{'location':'p-0000000','quote':text}]
        with self.assertRaisesRegex(ValueError,'confidence'):validate({'facts':[],'results':[test]},{'p-0000000':text})

    def test_percentage_scale_and_missing_units_are_not_inferred(self):
        text='The sensitivity was 91.3% in this group.'
        r={**RESULT,'measure':'sensitivity','estimate':'91.3','unit':'%','ci_low':None,'ci_high':None,'ci_level':None,
           'population':None,'comparison':None,'outcome':None,'timepoint':None,'adjustment':'not_reported','evidence':[{'location':'p-0000000','quote':text}]}
        validate({'facts':[],'results':[r]},{'p-0000000':text})
        with self.assertRaises(ValueError):validate({'facts':[],'results':[{**r,'unit':None}]},{'p-0000000':text})

    def test_individual_bad_results_are_counted_not_replaced(self):
        value={'facts':[],'results':[RESULT,{**RESULT,'estimate':'3.0'}]}
        valid,rejected=accepted(value,{'p-0000000':TEXT})
        self.assertEqual(valid['results'],[RESULT]);self.assertEqual(rejected,1)

    def test_dates_retain_precision_ranges_and_online_print_distinction(self):
        self.assertEqual(date_record(ET.fromstring('<PubDate><Year>2001</Year></PubDate>'),'journal')['date'],'2001')
        self.assertEqual(date_record(ET.fromstring('<PubDate><Year>2001</Year><Month>Mar</Month></PubDate>'),'journal')['precision'],'month')
        d=date_record(ET.fromstring('<PubDate><MedlineDate>2001 Dec-2002 Jan</MedlineDate></PubDate>'),'journal')
        self.assertEqual(d['precision'],'range');self.assertEqual(d['raw'],'2001 Dec-2002 Jan')
        xml='''<PubmedArticle><MedlineCitation><PMID>123</PMID><Article><ArticleTitle>Study</ArticleTitle><Journal><Title>Journal</Title><JournalIssue><PubDate><Year>2024</Year><Month>Mar</Month></PubDate></JournalIssue></Journal><ArticleDate DateType="Electronic"><Year>2023</Year><Month>12</Month><Day>14</Day></ArticleDate><AuthorList><Author><CollectiveName>Trial Group</CollectiveName></Author></AuthorList><DataBankList><DataBank><AccessionNumberList><AccessionNumber>NCT12345678</AccessionNumber></AccessionNumberList></DataBank></DataBankList></Article><MeshHeadingList><MeshHeading><DescriptorName UI="D011471">Prostatic Neoplasms</DescriptorName></MeshHeading></MeshHeadingList></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1234/test</ArticleId></ArticleIdList><ReferenceList><Reference><ArticleIdList><ArticleId IdType="pubmed">122</ArticleId></ArticleIdList></Reference></ReferenceList></PubmedData></PubmedArticle>'''
        b=pubmed_metadata(ET.fromstring(xml),'123')
        self.assertEqual(b['authors'],['Trial Group']);self.assertEqual(b['dates'][1]['date'],'2023-12-14')
        self.assertEqual(b['mesh'][0]['id'],'D011471');self.assertEqual(b['references'][0]['pmid'],'122')
        self.assertEqual(b['registry_ids'],['NCT12345678'])
        with self.assertRaises(ValueError):pubmed_metadata(ET.fromstring(xml),'999')

    def test_unknown_dates_remain_unknown_and_no_raw_quotes_leave_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            store=KnowledgeStore(Path(directory));paper={'pmid':'123','title':'Study','pub_date':'2024-01-01'}
            doc={'content_text':TEXT,'content_hash':hashlib.sha256(TEXT.encode()).hexdigest(),
                 'reading_layout':{'references':[{'id':'r1','text':'Example reference doi:10.1234/example. PMID: 456'}]}}
            store.observe(paper,doc);row=store.db.execute('SELECT * FROM sources').fetchone()
            b=bibliography(paper,Path(directory),fetch=False)
            self.assertEqual(b['dates'][0]['precision'],'unknown')
            f={'concepts':[],'findings':[],'science':{'facts':[],'results':[RESULT]},'science_rejected':1}
            p=publication(row,[f],b,doc)
            self.assertEqual(p['bibliography']['references'][0]['pmid'],'456')
            self.assertEqual(p['provenance']['review_status'],'unreviewed')
            self.assertNotIn('quote',json.dumps(p));self.assertNotIn(TEXT,json.dumps(p))
            store.complete(row,[f],science=p)
            self.assertEqual(store.db.execute('SELECT count(*) FROM scientific_history').fetchone()[0],1)
            oldfingerprint=row['fingerprint']
            store.observe({**paper,'pub_date':'2023-12-14'},doc)
            self.assertEqual(store.db.execute('SELECT fingerprint FROM sources').fetchone()[0],oldfingerprint)
            self.assertEqual(json.loads(store.db.execute('SELECT paper FROM sources').fetchone()[0])['pub_date'],'2023-12-14')
            store.withdraw('123')
            self.assertEqual(store.db.execute("SELECT count(*) FROM publications WHERE kind='science'").fetchone()[0],0)
            self.assertEqual(store.db.execute('SELECT count(*) FROM scientific_history').fetchone()[0],1)
            store.close()

if __name__=='__main__':unittest.main()
