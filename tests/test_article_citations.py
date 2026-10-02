import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from fulltext import parse_document
from document_layout import validate_layout
from fulltext_viewer import Archive
from rebuild_reading_layout import rebuild


class ArticleCitationsTests(unittest.TestCase):
    def xml(self):
        return ('<article><body><sec><title>Introduction</title><p>🧬 Clinical assessment. '
                '[<xref ref-type="bibr" rid="R1">1</xref>, <xref ref-type="bibr" rid="R2">2</xref>]. '
                'N = 195, HR 0.72, 95% CI, 2026, mm<sup>2</sup>. '
                '<xref ref-type="fig" rid="F1">1</xref> '
                + 'Full study description. ' * 30 + '</p></sec></body><back><ref-list>'
                '<ref id="R1"><label>1</label><mixed-citation>Alpha. Clinical study. 2020.</mixed-citation></ref>'
                '<ref id="R2"><label>2</label><mixed-citation>Beta. Margin study. 2021.</mixed-citation></ref>'
                '</ref-list></back></article>').encode()

    def test_jats_citations_are_bound_to_exact_original_with_reference_text(self):
        doc = parse_document(self.xml());layout=doc['reading_layout']
        self.assertEqual(len(layout['citations']), 1)
        cite=layout['citations'][0]
        self.assertEqual(cite['text'], '[ 1 , 2 ]')
        self.assertEqual(cite['targets'], ['R1','R2'])
        self.assertEqual(doc['content_text'][cite['start']:cite['end']], cite['text'])
        self.assertEqual(len(layout['references']), 2)
        self.assertIn('Alpha. Clinical study.', layout['references'][0]['text'])
        self.assertNotIn('Alpha.', doc['content_text'])
        self.assertEqual(doc['content_hash'], hashlib.sha256(doc['content_text'].encode()).hexdigest())

    def test_html_superscripts_preserve_only_explicit_citations_and_missing_targets(self):
        raw=('<article><h2>Introduction</h2><p>Clinical assessment. '
             '<sup><a class="bibLink" href="#bju-bib-0001">1</a>, '
             '<a class="bibLink" href="#bju-bib-0002">2</a></sup> '
             'Area mm<sup>2</sup>, 195 participants in 2026. <a href="#figure1">1</a> '
             '<a href="#preferred-treatment">3</a><a href="http://[invalid">4</a>'
             + 'A complete body. '*40+'</p></article>').encode()
        doc=parse_document(raw);layout=doc['reading_layout']
        self.assertEqual([c['text'] for c in layout['citations']], ['1 , 2'])
        self.assertEqual(layout['references'], [])
        self.assertIn('195 participants in 2026', doc['content_text'])

    def test_html_reference_details_and_table_citations_are_plain_source_text(self):
        raw=('<article><h2>Results</h2><p>'+ 'Measured outcomes. '*40 + '</p>'
             '<table><tr><td>Group <a href="#ref1">1</a></td><td>123</td></tr></table>'
             '</article><ol><li id="ref1">1. Alpha <em>Study</em>. 2020.</li></ol>').encode()
        doc=parse_document(raw);layout=doc['reading_layout']
        self.assertEqual(layout['references'], [{'id':'ref1','text':'1. Alpha Study . 2020.'}])
        self.assertEqual(layout['citations'][0]['text'], '1')
        self.assertNotIn('<em>', json.dumps(layout))

    def test_elsevier_cross_reference_and_multiple_rids(self):
        raw=('<full-text-retrieval-response xmlns:ce="urn:test"><body><ce:section><ce:section-title>Results</ce:section-title>'
             '<ce:para>'+ 'Complete results. '*40+'<ce:cross-ref refid="bib1 bib2">1–2</ce:cross-ref>'
             '</ce:para></ce:section></body><ce:bib-reference id="bib1">1. Source A.</ce:bib-reference>'
             '<ce:bib-reference id="bib2">2. Source B.</ce:bib-reference></full-text-retrieval-response>').encode()
        layout=parse_document(raw)['reading_layout']
        self.assertEqual(layout['citations'][0]['targets'], ['bib1','bib2'])
        self.assertEqual(len(layout['references']),2)

    def test_invalid_annotations_are_rejected_without_overwriting_original(self):
        doc=parse_document(self.xml())
        for update in ({'start':-1}, {'text':'Wrong'}, {'targets':['<script>']}, {'end':999999}):
            layout=copy.deepcopy(doc['reading_layout']);layout['citations'][0].update(update)
            with self.subTest(update=update),self.assertRaises(ValueError):
                validate_layout(layout,doc['content_text'],doc['content_hash'])

    def test_upgrade_sidecar_supersedes_old_embedded_layout_and_invalid_sidecar_falls_back(self):
        doc=parse_document(self.xml());old=copy.deepcopy(doc)
        for key in ('citation_version','citations','references'):old['reading_layout'].pop(key)
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory).resolve();(state/'documents').mkdir();(state/'cloud-archive').mkdir()
            path=state/'documents/12345.json';path.write_text(json.dumps({'document':old}),encoding='utf-8')
            path.with_suffix('.xml').write_bytes(self.xml());before=path.read_bytes()
            summary=path.with_suffix('.summary.json');summary.write_text('unchanged summary')
            self.assertEqual(rebuild(path,apply=True),'restored')
            article=Archive(state).read('12345')
            self.assertEqual(article['reading_layout']['citations'],doc['reading_layout']['citations'])
            self.assertEqual(path.read_bytes(),before);self.assertEqual(summary.read_text(),'unchanged summary')
            self.assertEqual(rebuild(path,apply=True),'already_verified')
            broken=doc['reading_layout'];broken['citations'][0]['text']='wrong'
            path.with_suffix('.layout.json').write_text(json.dumps(broken))
            self.assertEqual(Archive(state).read('12345')['reading_layout'],old['reading_layout'])


if __name__ == '__main__':unittest.main()
