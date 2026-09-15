"""Institution reader contracts, with synthetic article text only."""
import hashlib
from pathlib import Path
import sys
import unittest
import queue
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from institution_worker import Browser, parsed_result, next_retry

PAPER = {"title": "A controlled study", "doi": "10.1000/study"}
PARA = "A synthetic study paragraph records the measured results and limitations. " * 30


class InstitutionTests(unittest.TestCase):
    def test_stalled_browser_is_bounded_and_stopped_before_retry(self):
        browser=Browser.__new__(Browser)
        browser.responses=Mock()
        browser.responses.get.side_effect=queue.Empty
        browser.kill=Mock()
        with self.assertRaises(TimeoutError): browser.response(20000)
        browser.responses.get.assert_called_once_with(timeout=35)
        browser.kill.assert_called_once()
        browser.responses.get.side_effect=None
        browser.responses.get.return_value=None
        with self.assertRaises(OSError): browser.response(20000)

    def result(self, html=None):
        return {"status": "downloaded", "title": PAPER["title"], "doi": PAPER["doi"],
                "url": "https://www.sciencedirect.com/science/article/pii/fixture?via=ihub",
                "html": html or f'<div id="body"><h2>Methods</h2><div class="para"><p>{PARA}</p></div>'
                    '<h2>Results</h2><div class="para">Observed endpoint.</div>'
                    '<table><tr><td>Outcome</td><td>17</td></tr></table></div>'}

    def test_div_paragraphs_and_tables_are_retained_once(self):
        doc = parsed_result(PAPER, self.result())
        self.assertEqual(doc["content_text"].count("A synthetic study paragraph"), 30)
        self.assertIn("Outcome 17", doc["content_text"])
        self.assertEqual(len(doc["sections"]), 2)
        self.assertEqual(doc["content_hash"], hashlib.sha256(doc["content_text"].encode()).hexdigest())
        self.assertNotIn("?", doc["source_url"])

    def test_wrong_title_or_doi_is_rejected(self):
        for key, value in [("title", "An unrelated paper"), ("doi", "10.1000/other")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                parsed_result(PAPER, {**self.result(), key: value})

    def test_sciencedirect_numbered_div_paragraphs_are_not_lost(self):
        html = (f'<div id="body"><h2>Methods</h2><div class="u-margin-s-bottom">'
                f'<div id="p0010" class="u-margin-s-bottom">{PARA}</div></div>'
                '<h2>Results</h2><div id="p0015" class="u-margin-s-bottom">Outcome 17.</div></div>')
        doc = parsed_result(PAPER, self.result(html))
        self.assertEqual(doc["content_text"].count("A synthetic study paragraph"), 30)
        self.assertEqual(doc["sections"][1]["title"], "Results")

    def test_unavailable_or_single_section_is_not_a_body(self):
        self.assertIsNone(parsed_result(PAPER, {"status": "access_required"}))
        with self.assertRaises(ValueError):
            parsed_result(PAPER, self.result(f'<article><h2>Abstract</h2><p>{PARA}</p></article>'))
        with self.assertRaises(ValueError):
            parsed_result(PAPER, self.result('<article><h2>Methods</h2><p>Loading...</p></article>'))

    def test_retry_policy_does_not_hammer_unavailable_publishers(self):
        self.assertEqual(next_retry("retryable_error", 10), 910)
        self.assertEqual(next_retry("challenge", 10), 86410)
        self.assertEqual(next_retry("access_required", 10), 604810)


if __name__ == "__main__":
    unittest.main()
