import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
import zipfile
import xml.etree.ElementTree as ET
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from review_documents import parse_import,ris,csl,reproducible_archive,csv_text
from review_figures import forest,prisma


class ReviewDocumentsTests(unittest.TestCase):
    def test_ris_multiline_unicode_and_identifiers(self):
        data='TY  - JOUR\nTI  - 한글 title\n      continued\nAU  - Smith, Jane\nDO  - https://doi.org/10.1000/TEST\nPY  - 1998\nAN  - 12345\nER  -\n'
        parsed=parse_import(data,'ris');self.assertEqual(parsed['source_count'],1)
        b=parsed['items'][0]['bibliography'];self.assertEqual(b['title'],'한글 title continued');self.assertEqual(b['doi'],'10.1000/test')
        again=parse_import(ris([b]),'ris')['items'][0]['bibliography']
        for field in ('title','authors','doi','year','pmid'):self.assertEqual(again[field],b[field])
    def test_nbib_doi_not_pii_and_continuation(self):
        p=parse_import('PMID- 12345\nTI  - Trial\nFAU - Smith, Jane\nDP  - 2020 Jan\nAID - S000123 [pii]\nAID - 10.1000/test [doi]\nAB  - First\n      second','nbib')
        self.assertEqual(p['items'][0]['bibliography']['doi'],'10.1000/test')
        self.assertEqual(p['items'][0]['bibliography']['abstract'],'First second')
    def test_csl_and_bibtex(self):
        p=parse_import('@article{x,title={A {nested} title},author={Smith, Jane and Doe, John},year={2022},doi={10.1000/x}}','bibtex')
        b=p['items'][0]['bibliography'];self.assertEqual(b['title'],'A nested title');self.assertEqual(len(b['authors']),2)
        back=parse_import(json.dumps(csl([b])),'csl-json');self.assertEqual(back['items'][0]['bibliography']['title'],b['title'])
        with self.assertRaises(ValueError):parse_import('@string{a="title"} @article{x,title=a}','bibtex')
    def test_csv_requires_explicit_mapping_missing_not_zero(self):
        headers=parse_import('Title,Year\nTrial,2020','csv')
        self.assertTrue(headers['mapping_required']);self.assertEqual(headers['columns'],['Title','Year']);self.assertEqual(headers['items'],[])
        with self.assertRaises(ValueError):parse_import('Title,Year\nTrial,2020','csv',{'title':'Missing column'})
        p=parse_import('Title,Year\nTrial,2020','csv',{'title':'Title','year':'Year'});self.assertEqual(p['source_count'],1)
        self.assertIn("'=HYPERLINK",csv_text([['=HYPERLINK(\"evil\")']]))
        self.assertEqual(csv_text([[-0.125,None]]),'\ufeff-0.125,\r\n')
    def test_records_with_invalid_identifiers_are_reported(self):
        p=parse_import('TY  - JOUR\nTI  - Good\nER  -\nTY  - JOUR\nTI  - Bad\nDO  - invalid\nER  -','ris')
        self.assertEqual(p['source_count'],2);self.assertEqual(len(p['items']),1);self.assertEqual(p['errors'][0]['record'],2)
        with self.assertRaises(ValueError):parse_import('','ris')
    def test_reproducible_archive_checks_engine_and_hashes(self):
        code=(Path(__file__).resolve().parents[1]/'scripts/review_analysis.py').read_bytes()
        result={'engine':{'code_sha256':hashlib.sha256(code).hexdigest()},'rows':[]}
        run={'id':'test','project_id':10,'input_manifest':{'observations':[],'protocol':{},'screening':{'counts':{'records':10,'reports':8}},'search_history':[{'status':'partial'}]},'result':result,'config':{},'input_hash':'f'*64,'lease_token':'DO_NOT_EXPORT','worker_id':'PRIVATE'}
        archive=reproducible_archive(run)
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            self.assertNotIn(b'DO_NOT_EXPORT',z.read('run.json'));self.assertEqual(json.loads(z.read('screening-counts.json'))['counts']['records'],10)
            m=json.loads(z.read('manifest.json'))
            for name,meta in m['files'].items():self.assertEqual(hashlib.sha256(z.read(name)).hexdigest(),meta['sha256'])
            ET.fromstring(z.read('selection-flow.svg'))
        with self.assertRaises(ValueError):reproducible_archive(run,engine_source=b'different')
    def test_figure_labels_escape_markup(self):
        svg=forest({'config':{'measure':'RR'},'rows':[{'label':'<script>alert(1)</script>','estimate':.8,'ci':[.6,1.2]}]})
        ET.fromstring(svg);self.assertNotIn('<script>',svg)
        ET.fromstring(prisma({'counts':{}}))


if __name__=='__main__':unittest.main()
