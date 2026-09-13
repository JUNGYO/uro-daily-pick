import io
import json
import sys
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import fulltext
import summarize_papers as summary
import classify_papers as classify
import fetch_papers as fetch
import send_digest as digest
from common import paginate
from pypdf import PdfWriter
from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject


class ServiceTests(unittest.TestCase):
    def test_elsevier_requests_full_xml_with_credentials_only_in_headers(self):
        with patch.dict(fulltext.os.environ, {"ELSEVIER_API_KEY":"fixture-key","ELSEVIER_INST_TOKEN":"fixture-token"}), patch.object(fulltext,"download",return_value=b"xml") as get:
            _, url = fulltext.fetch_elsevier("123")
            self.assertIn("view=FULL",url)
            self.assertNotIn("fixture-key",url)
            self.assertEqual(get.call_args.args[1]["Accept"],"text/xml")
            self.assertEqual(get.call_args.args[1]["X-ELS-Insttoken"],"fixture-token")

    def test_summary_rejects_malformed_or_incomplete_model_output(self):
        valid = {"summary_ko":"First line\nSecond line\nThird line", "structured":dict.fromkeys(["study_design","sample_size","key_finding","population"],"Not reported"), "clinical_relevance":3, "qa":[{"q":"Question","a":"Answer"}]}
        result = summary.validate_summary(json.dumps(valid))
        self.assertIsInstance(result["structured_data"], dict)
        self.assertIsInstance(result["qa_data"], list)
        for change in [{"summary_ko":"Only one line"},{"clinical_relevance":True},{"clinical_relevance":6},{"qa":[]},{"structured":[]}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                summary.validate_summary(json.dumps({**valid, **change}))
        for raw in [None, "invalid json", "[]"]:
            with self.assertRaises(ValueError): summary.validate_summary(raw)

    def test_trial_phase_and_cohort_mesh_do_not_imply_randomization_or_retrospective_design(self):
        self.assertNotEqual(classify.classify([], ["Clinical Trial, Phase II"], "Single-arm phase II trial", "")[0], "rct")
        self.assertNotEqual(classify.classify(["Cohort Studies"], [], "Observational cohort", "")[0], "retrospective")
        self.assertEqual(classify.classify([], ["Randomized Controlled Trial"], "Trial", "")[0], "rct")
        self.assertNotEqual(classify.classify([], [], "A non-randomized trial", "")[0], "rct")
        self.assertNotEqual(fetch.classify_study_type("phase iii trial", "single arm", []), "rct")

    def test_body_sections_and_tables_are_extracted_from_jats(self):
        content = ("<article><front><abstract>ABSTRACT ONLY</abstract></front><body><sec><title>Methods</title><p>" + "Study participants. "*35 + "</p><table-wrap><table><tr><td>Outcome 123</td></tr></table></table-wrap></sec></body></article>").encode()
        parsed = fulltext.parse_document(content)
        self.assertIn("Outcome 123", parsed["content_text"])
        self.assertNotIn("ABSTRACT ONLY", parsed["content_text"])
        self.assertEqual(parsed["source"], "xml")
        self.assertEqual(parsed["content_hash"], fulltext.parse_document(content)["content_hash"])

    def test_html_body_is_extracted_without_navigation_or_scripts(self):
        parsed = fulltext.parse_document(("<!doctype html><html><body><nav>PRIVATE NAV</nav><article><h2>Results</h2><p>" + "Article result. "*50 + "</p><script>PRIVATE SCRIPT</script></article></body></html>").encode())
        self.assertEqual(parsed["source"], "html")
        self.assertNotIn("PRIVATE", parsed["content_text"])

    def test_login_challenge_metadata_and_scanned_pdf_are_not_full_text(self):
        cases = [b"<html><body>Login required</body></html>",
                 ("<main><p>Verify you are human. "*50+"</p></main>").encode(),
                 ("<article><front><abstract><p>"+"Only abstract. "*50+"</p></abstract></front></article>").encode()]
        writer = PdfWriter(); writer.add_blank_page(width=600,height=800)
        pdf = io.BytesIO(); writer.write(pdf); cases.append(pdf.getvalue())
        for content in cases:
            with self.subTest(content=content[:30]), self.assertRaises(ValueError): fulltext.parse_document(content)

    def test_pdf_text_preserves_reported_numbers(self):
        writer = PdfWriter(); page = writer.add_blank_page(width=600,height=800)
        font = DictionaryObject({NameObject("/Type"):NameObject("/Font"),NameObject("/Subtype"):NameObject("/Type1"),NameObject("/BaseFont"):NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"):DictionaryObject({NameObject("/F1"):font})})
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 20 700 Td (" + b"Reported outcome: 123 patients, HR 0.72. "*20 + b") Tj ET")
        page[NameObject("/Contents")] = stream
        document = io.BytesIO(); writer.write(document)
        parsed = fulltext.parse_document(document.getvalue())
        self.assertEqual(parsed["source"],"pdf")
        self.assertIn("123 patients, HR 0.72",parsed["content_text"])

    def test_sent_delivery_is_skipped_and_pending_payload_is_reused(self):
        now = datetime(2026,9,14,6,tzinfo=digest.KST)
        user = {"id":"reader","digest_frequency":"daily"}
        row = {"status":"sent", "frequency":"daily", "created_at":now.isoformat(), "payload":{"to":["reader@example.test"],"html":"Original"}}
        with patch.object(digest,"sb_get",return_value=[row]), patch.object(digest,"delivery_write") as write:
            self.assertIsNone(digest.prepare_delivery(user,"reader@example.test","New subject","Changed HTML",now))
            write.assert_not_called()
            row["status"]="pending"
            prepared = digest.prepare_delivery(user,"reader@example.test","New subject","Changed HTML",now)
            self.assertEqual(prepared[0]["payload"]["html"], "Original")
            row["created_at"]=(now-timedelta(hours=24)).isoformat()
            with self.assertRaisesRegex(ValueError,"retry window"):
                digest.prepare_delivery(user,"reader@example.test","Subject","HTML",now)

    def test_weekly_digest_deduplicates_papers(self):
        rows=[{"paper":{"pmid":"1"}},{"paper":{"pmid":"1"}},{"paper":{"pmid":"2"}}, {"paper":None}]
        with patch.object(digest,"sb_get",return_value=rows) as get:
            self.assertEqual(len(digest.get_today_recs("reader","weekly")),2)
            self.assertTrue(get.call_args.args[1]["rec_date"].startswith("gte."))

    def test_pagination_crosses_server_row_limit(self):
        get=Mock(side_effect=[[1,2],[3]])
        self.assertEqual(paginate(get,"papers",{"order":"id"},size=2),[1,2,3])
        self.assertEqual(get.call_args.args[1]["offset"],"2")


if __name__ == "__main__": unittest.main()
