import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import article_images as images

PNG = b'\x89PNG\r\n\x1a\n' + b'synthetic fixture'
HTML = '''<figure><a href="https://bjui-journals.onlinelibrary.wiley.com/cms/large.jpg"><img src="/small.png"></a>
<figcaption><div class="figure__title">Fig. 1</div><button>Open in viewer</button><div class="figure__caption-text">Actual caption</div></figcaption></figure>'''


class ImageCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.docs = self.root / 'documents'
        self.docs.mkdir()
        self.record = {'document': {'content_hash': 'body-hash', 'source_url': 'https://bjui-journals.onlinelibrary.wiley.com/doi/10.1/example'}}
        (self.docs / '12345.html').write_text(HTML, encoding='utf-8')

    def tearDown(self):
        self.temp.cleanup()

    def test_automatic_queue_skips_archived_dates_but_explicit_request_can_read_them(self):
        for pmid in ('1','2'):
            (self.docs/(pmid+'.json')).write_text(json.dumps(self.record),encoding='utf-8')
        before=(self.docs/'1.json').read_bytes()
        with patch.dict(sys.modules,{'msvcrt':Mock()}), \
             patch('institution_worker.local_service') as service, \
             patch('institution_worker.Browser'), \
             patch.object(images,'collect_images',return_value={'figures':[]}) as collect:
            service.return_value.automatic_figure_pmids.return_value={'2'}
            images.run_image_queue(self.root,'node',60)
            self.assertEqual([call.args[1] for call in collect.call_args_list],['2'])
            collect.reset_mock();service.reset_mock()
            images.run_image_queue(self.root,'node',60,'1')
            service.assert_not_called()
            self.assertEqual([call.args[1] for call in collect.call_args_list],['1'])
        self.assertEqual((self.docs/'1.json').read_bytes(),before)

    def test_replaced_draft_and_disappearing_original_do_not_abort_other_figures(self):
        for name in ('1.json','2.json','2.notes.draft.json'):
            (self.docs/name).write_text(json.dumps(self.record),encoding='utf-8')
        original_stat=Path.stat
        checked=[]
        def stat(path,*args,**kwargs):
            checked.append(path.name)
            if path in (self.docs/'1.json',self.docs/'2.notes.draft.json'):
                raise FileNotFoundError('Synthetic concurrent replacement')
            return original_stat(path,*args,**kwargs)
        with patch.dict(sys.modules,{'msvcrt':Mock()}), \
             patch('institution_worker.local_service') as service, \
             patch('institution_worker.Browser'), \
             patch.object(Path,'stat',stat), \
             patch.object(images,'collect_images',return_value={'figures':[]}) as collect:
            service.return_value.automatic_figure_pmids.return_value={'1','2'}
            images.run_image_queue(self.root,'node',60)
        self.assertEqual([call.args[1] for call in collect.call_args_list],['2'])
        self.assertNotIn('2.notes.draft.json',checked)

    def test_original_disappearing_after_stat_uses_archive_and_keeps_other_papers(self):
        archive=self.root/'cloud-archive'
        archive.mkdir()
        for path in (self.docs/'1.json',self.docs/'2.json',archive/'1.json'):
            path.write_text(json.dumps(self.record),encoding='utf-8')
        original_read=Path.read_text
        def read(path,*args,**kwargs):
            if path==self.docs/'1.json':
                raise FileNotFoundError('Synthetic replacement after stat')
            return original_read(path,*args,**kwargs)
        with patch.dict(sys.modules,{'msvcrt':Mock()}), \
             patch('institution_worker.local_service') as service, \
             patch('institution_worker.Browser'), \
             patch.object(Path,'read_text',read), \
             patch.object(images,'collect_images',return_value={'figures':[]}) as collect:
            service.return_value.automatic_figure_pmids.return_value={'1','2'}
            images.run_image_queue(self.root,'node',60)
        self.assertCountEqual([call.args[1] for call in collect.call_args_list],['1','2'])

    def test_high_resolution_caption_and_tables(self):
        result = images.html_figures(HTML + '<figure><a href="/tables/1">Table 1</a></figure>', self.record['document']['source_url'])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['caption'], 'Actual caption')
        self.assertTrue(result[0]['urls'][0].endswith('/large.jpg'))
        self.assertFalse(images.allowed_image_url('https://elsewhere.example/image.jpg'))
        with self.assertRaises(ValueError): images.image_type(b'<svg>not a raster</svg>')

    def test_real_bytes_saved_and_repeat_does_not_download_again(self):
        with patch.object(images, 'fetch_bytes', return_value=PNG) as fetch:
            result = images.collect_images(self.root, '12345', self.record)
            self.assertEqual(result['status'], 'complete')
            asset = result['figures'][0]['asset_id']
            self.assertEqual((self.docs / '12345.images' / asset).read_bytes(), PNG)
            images.collect_images(self.root, '12345', self.record)
            fetch.assert_called_once()

    def test_partial_resumes_without_losing_other_figure(self):
        (self.docs / '12345.html').write_text(HTML + HTML.replace('large.jpg', 'second.jpg'), encoding='utf-8')
        with patch.object(images, 'fetch_bytes', side_effect=[PNG, OSError(), OSError()]):
            result = images.collect_images(self.root, '12345', self.record)
        self.assertEqual([f['status'] for f in result['figures']], ['ready', 'pending'])
        manifest = self.docs / '12345.images.json'
        result['retry_after'] = 0
        manifest.write_text(json.dumps(result), encoding='utf-8')
        with patch.object(images, 'fetch_bytes', return_value=PNG) as fetch:
            result = images.collect_images(self.root, '12345', self.record)
        self.assertEqual(result['status'], 'complete')
        fetch.assert_called_once()

    def test_image_budget_and_low_disk_keep_body_intact(self):
        with patch.object(images.shutil, 'disk_usage', return_value=Mock(free=0)), patch.object(images, 'fetch_bytes', return_value=PNG):
            result = images.collect_images(self.root, '12345', self.record)
        self.assertEqual(result['status'], 'partial')
        self.assertFalse(list((self.docs / '12345.images').iterdir()))
        self.assertEqual((self.docs / '12345.html').read_text(), HTML)

    def test_jats_package_preserves_figure_order_and_caption(self):
        self.record['document']['source_url'] = 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC123456/fullTextXML'
        (self.docs / '12345.xml').write_text('''<article xmlns:xlink="http://www.w3.org/1999/xlink"><body><fig><label>Figure 1</label><caption>Study flow</caption><graphic xlink:href="sample-g1"/></fig></body></article>''')
        package = io.BytesIO()
        with zipfile.ZipFile(package, 'w') as archive:
            archive.writestr('nested/sample-g1.png', PNG)
            archive.writestr('unrelated.txt', 'Ignored')
        with patch.object(images, 'pmc_image_urls', return_value=[]), patch.object(images, 'fetch_bytes', return_value=package.getvalue()):
            result = images.collect_images(self.root, '12345', self.record)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['figures'][0]['caption'], 'Study flow')
        self.assertEqual(result['figures'][0]['asset_id'], hashlib.sha256(PNG).hexdigest())

    def test_current_pmc_media_checks_article_identity_and_published_version(self):
        listing=b'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CommonPrefixes><Prefix>PMC123456.2/</Prefix></CommonPrefixes></ListBucketResult>'
        url='s3://pmc-oa-opendata/PMC123456.2/study-g1.jpg?md5=fixture'
        meta={'pmid':'12345','is_manuscript':'no','media_urls':[url]}
        with patch.object(images,'fetch_bytes',side_effect=[listing,json.dumps(meta).encode()]):
            self.assertEqual(images.pmc_image_urls('PMC123456','12345'),[url.replace('s3://pmc-oa-opendata/','https://pmc-oa-opendata.s3.amazonaws.com/')])
        meta['pmid']='67890'
        with patch.object(images,'fetch_bytes',side_effect=[listing,json.dumps(meta).encode()]):
            self.assertEqual(images.pmc_image_urls('PMC123456','12345'),[])


if __name__ == '__main__': unittest.main()
