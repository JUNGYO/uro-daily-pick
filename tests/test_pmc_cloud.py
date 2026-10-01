"""Official repository fixture downloads only; no network or source credentials."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pmc_cloud import BASE, fetch_pmc_cloud, document_media
from fulltext import FulltextUnavailable


class PMCCloudTests(unittest.TestCase):
    def setUp(self):
        self.paper = {'pmid': '123', 'doi': '10.1234/test'}
        self.xml = b'<article><front><article-meta><article-id pub-id-type="pmid">123</article-id><article-id pub-id-type="doi">10.1234/test</article-id></article-meta></front><body/></article>'
        self.prefix = 'PMC456.2/'
        self.meta = {'pmcid': 'PMC456', 'version': 2, 'pmid': 123, 'doi': '10.1234/test',
                     'is_manuscript': True, 'license_code': 'TDM',
                     'xml_url': 's3://pmc-oa-opendata/' + self.prefix + 'PMC456.2.xml?md5=' + hashlib.md5(self.xml).hexdigest(),
                     'media_urls': ['s3://pmc-oa-opendata/' + self.prefix + 'fig1.jpg?md5=' + 'a'*32]}
        self.listing = '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>PMC456.2/</Prefix></CommonPrefixes></ListBucketResult>'
        self.calls = []

    def fetch(self, url, **kwargs):
        self.calls.append(url)
        if 'list-type' in url: return self.listing.encode()
        if url.endswith('.json'): return json.dumps(self.meta).encode()
        if urlsplit(url).path.endswith('.xml'): return self.xml
        self.fail('Unexpected download')

    def run_fetch(self):
        return fetch_pmc_cloud(self.paper, 'PMC456', download=self.fetch)

    def test_manuscript_version_two_identity_hash_and_media_are_preserved(self):
        content, url, repository = self.run_fetch()
        self.assertEqual(content, self.xml)
        self.assertEqual(url, BASE + 'PMC456.2/PMC456.2.xml')
        self.assertEqual(repository['version'], 2)
        self.assertTrue(repository['is_manuscript'])
        self.assertEqual(repository['license'], 'TDM')
        self.assertEqual(document_media({'source_url': url, 'repository': repository}, '123'),
                         [BASE + 'PMC456.2/fig1.jpg?md5=' + 'a'*32])
        self.assertEqual(len(self.calls), 3)

    def test_metadata_identity_mismatch_never_downloads_original(self):
        for field, value in [('pmid', 999), ('pmcid', 'PMC999'), ('version', 1), ('doi', '10.1234/wrong')]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.meta); self.meta[field] = value; self.calls.clear()
                with self.assertRaises(ValueError): self.run_fetch()
                self.assertEqual(len(self.calls), 2)
                self.meta = original

    def test_unknown_license_and_tdm_nonmanuscript_are_not_downloaded(self):
        for values in [{'license_code': 'unknown'}, {'is_manuscript': False}]:
            with self.subTest(values=values):
                original = copy.deepcopy(self.meta); self.meta.update(values); self.calls.clear()
                with self.assertRaises(FulltextUnavailable): self.run_fetch()
                self.assertEqual(len(self.calls), 2); self.meta = original

    def test_xml_checksum_and_own_front_matter_identity_required(self):
        self.xml += b'\n'
        with self.assertRaisesRegex(ValueError, 'checksum'): self.run_fetch()
        self.xml = self.xml.replace(b'>123<', b'>999<')
        self.meta['xml_url'] = 's3://pmc-oa-opendata/PMC456.2/PMC456.2.xml?md5=' + hashlib.md5(self.xml).hexdigest()
        with self.assertRaisesRegex(ValueError, 'PMID'): self.run_fetch()

    def test_incomplete_listing_does_not_become_cached_absence(self):
        self.listing = self.listing.replace('false', 'true')
        with self.assertRaises(ValueError): self.run_fetch()
        self.assertEqual(len(self.calls), 1)

    def test_empty_complete_listing_is_current_absence(self):
        self.listing = self.listing.replace('<CommonPrefixes><Prefix>PMC456.2/</Prefix></CommonPrefixes>', '')
        with self.assertRaises(FulltextUnavailable): self.run_fetch()

    def test_manifest_cannot_redirect_to_another_host_article_or_path(self):
        for url in ['https://other.example/PMC456.2/PMC456.2.xml?md5='+'a'*32,
                    BASE+'PMC456.1/PMC456.1.xml?md5='+'a'*32,
                    BASE+'PMC456.2/../other.xml?md5='+'a'*32]:
            with self.subTest(url=url):
                self.meta['xml_url'] = url
                with self.assertRaises(ValueError): self.run_fetch()

    def test_media_must_match_exact_stored_original_version(self):
        _, url, repository = self.run_fetch()
        with self.assertRaises(ValueError):
            document_media({'source_url': url.replace('.2', '.1'), 'repository': repository}, '123')
        with self.assertRaises(ValueError): document_media({'source_url': url, 'repository': repository}, '999')
        self.assertIsNone(document_media({'source_url': 'https://example.test'}, '123'))
