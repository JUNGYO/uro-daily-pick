import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from knowledge import PAGE_VERSION, KnowledgeStore, validate_fragment, accepted_fragment, validate_page, concept_id, digest, communities
from knowledge_worker import extract_step, page_step, sync_step


TEXT = 'Patients with prostate cancer were assessed. The study included 25 patients. Veterans Affairs supplied data.'
BLOCKS = {'p-0000000': TEXT}
FRAGMENT = {'concepts': [{'label': 'prostate cancer', 'label_ko': '전립선암', 'kind': 'condition', 'aliases': [],
    'evidence': [{'location': 'p-0000000', 'quote': 'Patients with prostate cancer were assessed.'}]}],
    'findings': [{'text': '연구에는 25명이 포함되었다.', 'context': '전립선암 환자 대상의 관찰 연구이다.', 'basis': 'own_result',
    'concepts': ['prostate cancer'], 'evidence': [{'location': 'p-0000000', 'quote': 'The study included 25 patients.'}]}]}


class KnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = KnowledgeStore(Path(self.temp.name))
        self.paper = {'pmid': '12345', 'title': 'Original study', 'pub_date': '2024-01-01'}
        self.document = {'content_text': TEXT, 'content_hash': hashlib.sha256(TEXT.encode()).hexdigest()}
        self.store.observe(self.paper, self.document)

    def tearDown(self):
        self.store.close(); self.temp.cleanup()

    def row(self):
        return self.store.db.execute('SELECT * FROM sources').fetchone()

    def test_source_quotes_and_numbers_are_checked(self):
        validate_fragment(FRAGMENT, BLOCKS)
        for mutate in [lambda f: f['findings'][0].update(text='연구에는 250명이 포함되었다.'),
                       lambda f: f['findings'][0]['evidence'][0].update(quote='Not in the original document'),
                       lambda f: f['findings'][0]['evidence'][0].update(location='p-9999999'),
                       lambda f: f.update(extra='private payload')]:
            f = copy.deepcopy(FRAGMENT); mutate(f)
            with self.assertRaises(ValueError): validate_fragment(f, BLOCKS)

    def test_ai_in_affairs_is_not_a_concept_alias(self):
        f = copy.deepcopy(FRAGMENT); f['concepts'][0]['aliases'] = ['ai']
        with self.assertRaises(ValueError): validate_fragment(f, BLOCKS)
        self.assertEqual(accepted_fragment(f,BLOCKS),FRAGMENT)

    def test_typographic_hyphens_share_identity_without_partial_word_matches(self):
        self.assertEqual(concept_id('method','Imbalanced\u2010ResNet50'),concept_id('method','Imbalanced-ResNet50'))
        f=copy.deepcopy(FRAGMENT)
        f['concepts'][0]['label']='Imbalanced-ResNet50'
        f['concepts'][0]['aliases']=[]
        f['concepts'][0]['evidence'][0]['quote']='Imbalanced\u2010ResNet50 produced these results.'
        f['findings']=[]
        validate_fragment(f,{'p-0000000':'Imbalanced\u2010ResNet50 produced these results.'})
        self.store.complete(self.row(),[f])
        payload=json.loads(self.store.db.execute("SELECT payload FROM publications").fetchone()[0])
        self.assertEqual(payload['concepts'][0]['label'],'imbalanced-resnet50')

    def test_rejected_candidate_never_publishes_or_discards_other_valid_facts(self):
        f=copy.deepcopy(FRAGMENT)
        f['findings'].append({**copy.deepcopy(f['findings'][0]),'text':'연구에 250명이 포함되었다.'})
        self.assertEqual(accepted_fragment(f,BLOCKS),FRAGMENT)
        f['findings']=[f['findings'][1]]
        with self.assertRaises(ValueError):accepted_fragment(f,BLOCKS)

    def test_source_change_invalidates_local_findings(self):
        self.store.complete(self.row(), [FRAGMENT])
        self.assertEqual(self.row()['state'], 'done')
        self.assertFalse(self.store.observe(self.paper, self.document))
        changed = dict(self.document, content_text=TEXT+' changed', content_hash=hashlib.sha256((TEXT+' changed').encode()).hexdigest())
        self.store.observe(self.paper, changed)
        self.assertEqual(self.row()['state'], 'pending')
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM findings').fetchone()[0], 0)

    def test_partial_publication_ack_cannot_clear_new_revision(self):
        with self.store.db: first = self.store.stage('page', 'x', {'version': 1})
        with self.store.db: second = self.store.stage('page', 'x', {'version': 2})
        self.store.acknowledge('page', 'x', first)
        self.assertEqual(self.store.db.execute('SELECT pending FROM publications').fetchone()[0], 1)
        self.store.acknowledge('page', 'x', second)
        self.assertEqual(self.store.db.execute('SELECT pending FROM publications').fetchone()[0], 0)

    def test_cloud_payload_never_contains_original_quotes(self):
        self.store.complete(self.row(), [FRAGMENT])
        payload = json.loads(self.store.db.execute('SELECT payload FROM publications').fetchone()[0])
        self.assertNotIn('evidence', json.dumps(payload))
        self.assertNotIn(TEXT, json.dumps(payload))
        inputs = self.store.page_inputs(concept_id('condition', 'prostate cancer'))
        page = validate_page({'paragraphs': [{'text': 'The observational study included 25 patients.', 'finding_ids': [inputs[0]['id']]}]}, inputs)
        self.assertEqual(page[0]['sources'][0]['locations'], ['p-0000000'])
        self.assertNotIn('quote', json.dumps(page))
        with self.assertRaises(ValueError): validate_page({'paragraphs': [{'text': 'The study included 250 patients.', 'finding_ids': [inputs[0]['id']]}]}, inputs)

    def test_korean_findings_can_support_english_pages_but_never_korean_prose(self):
        self.store.complete(self.row(), [FRAGMENT])
        inputs = self.store.page_inputs(concept_id('condition', 'prostate cancer'))
        for text in ['연구에는 25명이 포함되었다.', 'This 연구 included 25 patients.', '25 patients 研究']:
            with self.assertRaisesRegex(ValueError, 'English'):
                validate_page({'paragraphs': [{'text': text, 'finding_ids': [inputs[0]['id']]}]}, inputs)

    def test_page_recipe_upgrade_preserves_source_checkpoints_and_requeues_once(self):
        self.store.complete(self.row(), [FRAGMENT])
        cid = concept_id('condition', 'prostate cancer')
        self.store.stage('page', cid, {'version': 'corpus-v1', 'paragraphs': []})
        self.store.db.execute('UPDATE concepts SET dirty=0'); self.store.db.commit()
        before = [tuple(r) for r in self.store.db.execute('SELECT * FROM findings')]
        self.store.prepare_pages()
        self.assertEqual(self.row()['state'], 'done')
        self.assertEqual(before, [tuple(r) for r in self.store.db.execute('SELECT * FROM findings')])
        self.assertEqual(self.store.db.execute('SELECT dirty FROM concepts').fetchone()[0], 1)
        self.assertEqual(self.store.db.execute("SELECT pending FROM publications WHERE kind='page'").fetchone()[0], 0)
        with patch('knowledge_worker.ask', return_value=[{'text':'The study included 25 patients.','sources':[]}]) as ask:
            self.assertTrue(page_step(self.store, self.store.directory, None))
        self.assertIn('English knowledge page', ask.call_args.args[0])
        self.assertEqual(json.loads(ask.call_args.args[1])['findings'][0]['source_excerpts'], ['The study included 25 patients.'])
        self.assertEqual(json.loads(self.store.db.execute("SELECT payload FROM publications WHERE kind='page'").fetchone()[0])['version'], PAGE_VERSION)
        self.store.prepare_pages()
        self.assertEqual(self.store.db.execute('SELECT dirty FROM concepts').fetchone()[0], 0)

    def test_checkpoint_resumes_without_model_call(self):
        with self.store.db:
            self.store.db.execute('INSERT INTO fragments VALUES (?,?,?,?)', ('12345', self.row()['fingerprint'], 0, json.dumps(FRAGMENT)))
        with patch('knowledge_worker.load_original', return_value=self.document), patch('knowledge_worker.ask') as ask:
            extract_step(self.store, Path(self.temp.name), None)
        ask.assert_not_called()
        self.assertEqual(self.row()['state'], 'done')

    def test_invalid_cached_candidate_guides_first_retry_without_publishing_it(self):
        from knowledge_worker import ask
        from knowledge import VERSION
        from local_summary import MODEL
        cache=self.store.directory/'candidates';cache.mkdir()
        bad=copy.deepcopy(FRAGMENT);bad['findings'][0]['text']='250 patients participated.'
        (cache/(digest([VERSION,MODEL,'system','content',{}])+'.json')).write_text(
            json.dumps({'response':json.dumps(bad)}),encoding='utf-8')
        with patch('knowledge_worker.chat',return_value=json.dumps(FRAGMENT)) as chat:
            actual=ask('system','content',{},lambda v:validate_fragment(v,BLOCKS),self.store.directory,None,cache_directory=cache)
        self.assertEqual(actual,FRAGMENT)
        self.assertEqual(chat.call_count,1)
        self.assertIn('250',chat.call_args.args[0])
        self.assertIn('context',chat.call_args.args[0])

    def test_failed_sync_retains_outbox(self):
        self.store.complete(self.row(), [FRAGMENT])
        class Service:
            config = {'id': 'fake-worker'}
            token = 'synthetic-token'
            def request(self, *_): raise RuntimeError('unavailable')
        sync_step(self.store, Service(), None)
        self.assertEqual(self.store.db.execute('SELECT pending FROM publications').fetchone()[0], 1)

    def test_communities_are_deterministic(self):
        edges = [('a','b',10),('c','d',10),('b','c',1)]
        self.assertEqual(communities(edges), communities(list(reversed(edges))))
        self.assertEqual(communities(edges)['a'], communities(edges)['b'])

    def test_network_publication_contains_only_derived_concept_groups(self):
        self.store.complete(self.row(),[FRAGMENT])
        self.store.build_groups()
        payload=json.loads(self.store.db.execute("SELECT payload FROM publications WHERE kind='network'").fetchone()[0])
        self.assertEqual(payload['source_documents'],1)
        self.assertEqual(payload['scope_concepts'],1)
        self.assertEqual(payload['groups'],[])
        self.assertNotIn('quote',json.dumps(payload))


if __name__ == '__main__': unittest.main()
