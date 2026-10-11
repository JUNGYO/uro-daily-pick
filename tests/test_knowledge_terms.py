import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from knowledge_terms import build_index,MeshIndex,metadata_bytes,ensure_index,reconcile_terms,document_term,definitions,reconcile_document_terms
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

    def test_unique_mesh_abbreviation_is_not_a_global_expansion(self):
        xml='<DescriptorRecordSet>'+record('D010323','M0001234','Passive Cutaneous Anaphylaxis',['PCA'])+record('D011471','M0017834','Prostate Cancer',['prostate cancer'])+record('D025341','M0032742','Principal Component Analysis',['principal component analysis'],'E')+'</DescriptorRecordSet>'
        path=self.directory/'abbreviations.sqlite3';build_index(io.BytesIO(xml.encode()),path,'c'*64)
        index=MeshIndex(path)
        try:
            self.assertEqual(index.resolve('PCa')['status'],'unmapped')
            cancer=document_term(index,'pca','We studied prostate cancer (PCa).','1')
            allergy=document_term(index,'pca','Passive cutaneous anaphylaxis (PCA) was measured.','2')
            self.assertEqual(cancer['label'],'Prostate Cancer')
            self.assertEqual(cancer['resolution'],'definition')
            self.assertNotEqual(cancer['entity_id'],allergy['entity_id'])
            self.assertEqual(allergy['label'],'Passive Cutaneous Anaphylaxis')
            statistics=document_term(index,'PCA','We used principal component analysis (PCA).','3')
            self.assertEqual(statistics['label'],'Principal Component Analysis')
            self.assertEqual(len({cancer['entity_id'],allergy['entity_id'],statistics['entity_id']}),3)
        finally:index.close()

    def test_ordinary_entry_words_do_not_become_unresolved_acronyms(self):
        path=self.directory/'ordinary.sqlite3'
        xml='<DescriptorRecordSet>'+record('D009369','M0014583','Neoplasms',['cancer'])+'</DescriptorRecordSet>'
        build_index(io.BytesIO(xml.encode()),path,'d'*64)
        index=MeshIndex(path)
        try:
            result=document_term(index,'cancer','Cancer was diagnosed.','1')
            self.assertEqual(result['resolution'],'exact')
            self.assertEqual(result['label'],'Neoplasms')
        finally:index.close()

    def test_conflicts_missing_definitions_and_reference_mentions_do_not_guess(self):
        for text in ['PCa was measured.','PCa was measured.\nReferences\nProstate cancer (PCa).',
                     'Prostate cancer (PCA) and principal component analysis (PCA).']:
            r=document_term(self.index,'PCA',text,'1')
            self.assertIn(r['resolution'],('unresolved','ambiguous'))
            self.assertIsNone(r['concept_ui'])
        a=document_term(self.index,'PCA','No definition.','1')
        b=document_term(self.index,'PCA','No definition.','2')
        self.assertNotEqual(a['entity_id'],b['entity_id'],'Unknown short forms cannot link unrelated papers')

    def test_spelled_out_terms_and_source_defined_short_forms_share_identity(self):
        long=document_term(self.index,'radical prostatectomy','','1')
        short=document_term(self.index,'RP','Men had radical prostatectomy (RP).','2')
        self.assertEqual(long['entity_id'],short['entity_id'])
        self.assertEqual(document_term(self.index,'PCa','PCa (prostate cancer) was diagnosed.','3')['label'],'Prostate Cancer')
        self.assertEqual(document_term(self.index,'PCA','We used PCA (principal component analysis).','4')['label'],'principal component analysis')
        self.assertEqual(definitions('Changes to PCa (not the acronym definition).','PCa'),[])

    def test_document_reconciliation_preserves_source_and_is_revision_bound(self):
        store=KnowledgeStore(self.directory/'context')
        try:
            source={'pmid':'123','title':'Study','content_hash':'a'*64,'concepts':[{'id':'a'*24,'label':'pca'}]}
            store.db.execute("INSERT INTO sources(pmid,paper,fingerprint,content_hash,updated_at) VALUES('123',?,'f',?,'now')",(json.dumps({'pmid':'123','title':'Study'}),'a'*64))
            store.stage('source','123',source);store.db.commit()
            with patch('knowledge_worker.load_original',return_value={'content_hash':'a'*64,'content_text':'prostate cancer (PCa)'}) as read:
                self.assertEqual(reconcile_document_terms(store,self.index,self.directory),1)
                self.assertEqual(reconcile_document_terms(store,self.index,self.directory),0)
                self.assertEqual(read.call_count,1)
            row=store.db.execute("SELECT payload,pending FROM publications WHERE kind='document_terms'").fetchone()
            self.assertEqual(json.loads(row['payload'])['items'][0]['label'],'Prostate Cancer')
            self.assertEqual(row['pending'],1)
            self.assertEqual(json.loads(store.db.execute("SELECT payload FROM publications WHERE kind='source'").fetchone()[0]),source)
        finally:store.close()
