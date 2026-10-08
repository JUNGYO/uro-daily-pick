import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from knowledge_terms import build_index,MeshIndex,metadata_bytes,ensure_index,reconcile_terms
from knowledge import KnowledgeStore

def record(descriptor,concept,label,terms,root='C'):
    return f'<DescriptorRecord><DescriptorUI>{descriptor}</DescriptorUI><TreeNumberList><TreeNumber>{root}01</TreeNumber></TreeNumberList><ConceptList><Concept><ConceptUI>{concept}</ConceptUI><ConceptName><String>{label}</String></ConceptName><TermList>'+''.join(f'<Term><String>{t}</String></Term>' for t in terms)+'</TermList></Concept></ConceptList></DescriptorRecord>'

class KnowledgeTermsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.directory=Path(self.tmp.name)
        xml='<DescriptorRecordSet>'+record('D011471','M0017834','Prostate Cancer',['prostate cancer','Cancer of Prostate','ambiguous'])+record('D000001','M0000001','Other',['ambiguous'],'A')+'</DescriptorRecordSet>'
        self.path=self.directory/'mesh.sqlite3';build_index(io.BytesIO(xml.encode()),self.path,'a'*64)
        self.index=MeshIndex(self.path)
    def tearDown(self):self.index.close();self.tmp.cleanup()
    def test_synonyms_share_concept_without_model_category(self):
        a=self.index.resolve('PROSTATE CANCER');b=self.index.resolve('Cancer of Prostate')
        self.assertEqual(a['entity_id'],b['entity_id']);self.assertEqual(a['entity_id'],'80bfd686cfc3cbb697a4f15a');self.assertEqual(a['category'],'condition')
    def test_ambiguous_and_unmapped_are_not_guessed(self):
        for term,status in [('ambiguous','ambiguous'),('PCa','unmapped'),('not a concept','unmapped')]:
            r=self.index.resolve(term);self.assertEqual(r['status'],status);self.assertIsNone(r['entity_id']);self.assertEqual(r['category'],'unclassified')
    def test_broader_descriptor_does_not_collapse_distinct_concepts(self):
        xml='<DescriptorRecordSet>'+record('D011471','M0099999','Broader',['Prostatic Neoplasms'])+'</DescriptorRecordSet>'
        path=self.directory/'other.sqlite3';build_index(io.BytesIO(xml.encode()),path,'b'*64)
        with_other=MeshIndex(path)
        try:self.assertNotEqual(with_other.resolve('Prostatic Neoplasms')['entity_id'],self.index.resolve('prostate cancer')['entity_id'])
        finally:with_other.close()
    def test_failed_build_preserves_verified_index(self):
        before=self.path.read_bytes()
        with self.assertRaises(ValueError):build_index(io.BytesIO(b'<Wrong/>'),self.path,'b'*64)
        self.assertEqual(self.path.read_bytes(),before)
    def test_forbidden_metadata_hosts_and_missing_cache(self):
        for url in ['http://eutils.ncbi.nlm.nih.gov/x','https://example.com/x']:
            with self.assertRaises(ValueError):metadata_bytes(url)
        self.assertIsNone(ensure_index(self.directory,download=False))
    def test_reconciliation_is_durable_idempotent_and_preserves_raw_label(self):
        store=KnowledgeStore(self.directory/'knowledge')
        try:
            store.db.execute("INSERT INTO sources(pmid,paper,fingerprint,content_hash,updated_at) VALUES('123','{}','f','h','now')")
            store.db.execute("INSERT INTO concepts(id,label,label_ko,kind,aliases) VALUES(?,?,?,?,?)",('a'*24,'prostate cancer','label','method','[]'))
            store.db.execute("INSERT INTO memberships VALUES('123',?)",('a'*24,));store.db.commit()
            self.assertEqual(reconcile_terms(store,self.index),1);self.assertEqual(reconcile_terms(store,self.index),0)
            row=store.db.execute("SELECT payload,pending FROM publications WHERE kind='terms'").fetchone()
            self.assertEqual(row['pending'],1);self.assertEqual(json.loads(row['payload'])['items'][0]['category'],'condition')
            self.assertEqual(store.db.execute('SELECT kind FROM concepts').fetchone()[0],'method')
        finally:store.close()
