"""Bounded, fully mocked checks for expanded daily journal discovery."""
import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import fetch_papers as fetch


def pubmed_xml(*ids):
    articles = [
        '<PubmedArticle><MedlineCitation><PMID>' + str(pmid) + '</PMID><Article>'
        '<ArticleTitle>Paper ' + str(pmid) + '</ArticleTitle><Journal><JournalIssue>'
        '<PubDate><Year>2026</Year><Month>01</Month><Day>01</Day></PubDate>'
        '</JournalIssue></Journal></Article></MedlineCitation></PubmedArticle>'
        for pmid in ids
    ]
    return ('<PubmedArticleSet>' + ''.join(articles) + '</PubmedArticleSet>').encode()


class DailyJournalScopeTests(unittest.TestCase):
    def test_capacity_pause_prevents_daily_discovery_and_writes(self):
        status = {"database_bytes": 487 * 1048576, "budget_bytes": 450 * 1048576}
        with patch.object(fetch, "SUPABASE_URL", "https://example.invalid"), \
             patch.object(fetch, "SUPABASE_KEY", "test"), \
             patch.object(fetch, "get_json", return_value=status), \
             patch.object(fetch, "search_pmids") as search, \
             patch.object(fetch, "insert_papers") as insert:
            fetch.main()
        search.assert_not_called()
        insert.assert_not_called()

    def test_capacity_is_checked_before_each_batch_and_committed_batch_survives_pause(self):
        rows = [{"pmid": str(pmid)} for pmid in range(1, 52)]
        response = Mock(status_code=201)
        response.json.return_value = rows[:50]
        with patch.object(fetch, "ensure_catalog_capacity", side_effect=[None, fetch.StorageCapacityReached()]) as capacity, \
             patch.object(fetch, "supabase_request", return_value=response) as insert:
            with self.assertRaises(fetch.StorageCapacityReached):
                fetch.insert_papers(rows)
        self.assertEqual(capacity.call_count, 2)
        self.assertEqual(insert.call_count, 1)
        self.assertEqual(insert.call_args.args[2], rows[:50])

    def test_post_conflict_target_is_pmid_and_returns_only_inserted_identifiers(self):
        with patch.object(fetch.requests, "post") as post:
            fetch.supabase_request("POST", "papers", [{"pmid": "1"}])
        request = post.call_args.kwargs
        self.assertEqual(request["params"]["on_conflict"], "pmid")
        self.assertEqual(request["params"]["select"], "pmid")
        self.assertIn("resolution=ignore-duplicates", request["headers"]["Prefer"])
        self.assertIn("return=representation", request["headers"]["Prefer"])

    def test_reported_insert_count_excludes_concurrent_duplicates(self):
        response = Mock(status_code=201)
        response.json.return_value = [{"pmid": "2"}]
        with patch.object(fetch, "ensure_catalog_capacity"), \
             patch.object(fetch, "supabase_request", return_value=response):
            self.assertEqual(fetch.insert_papers([{"pmid": "1"}, {"pmid": "2"}]), 1)

    def test_efetch_error_missing_duplicate_and_unrequested_records_are_rejected(self):
        cases = [
            b'<PubmedArticleSet><ERROR>Temporarily unavailable</ERROR></PubmedArticleSet>',
            pubmed_xml("1"),
            pubmed_xml("1", "1"),
            pubmed_xml("1", "99"),
            pubmed_xml("1", "2").replace(b'<ArticleTitle>Paper 2</ArticleTitle>', b'<ArticleTitle/>'),
        ]
        for xml in cases:
            with self.subTest(xml=xml), patch.object(fetch.requests, "get", return_value=Mock(content=xml)):
                with self.assertRaises(ValueError):
                    fetch.fetch_details(["1", "2"])

    def test_efetch_batches_are_bounded_and_retain_all_requested_records(self):
        batch_sizes = []
        def respond(url, *, params, timeout):
            ids = params["id"].split(",")
            batch_sizes.append(len(ids))
            return Mock(content=pubmed_xml(*ids))
        ids = [str(pmid) for pmid in range(1, 206)]
        with patch.object(fetch.requests, "get", side_effect=respond), patch.object(fetch.time, "sleep"):
            result = fetch.fetch_details(ids)
        self.assertEqual(batch_sizes, [100, 100, 5])
        self.assertEqual([row["pmid"] for row in result], ids)

    def test_search_page_size_does_not_cap_the_complete_result(self):
        requested_offsets = []
        ids = [str(pmid) for pmid in range(1, 124)]
        def respond(url, *, params, timeout):
            offset = params["retstart"]
            requested_offsets.append(offset)
            response = Mock()
            response.json.return_value = {"esearchresult": {"count": "123", "idlist": ids[offset:offset + 50]}}
            return response
        with patch.object(fetch.requests, "get", side_effect=respond), patch.object(fetch.time, "sleep"):
            result = fetch.search_pmids('"1234-5678"[Journal]', max_results=50)
        self.assertEqual(result, ids)
        self.assertEqual(requested_offsets, [0, 50, 100])

    def test_search_rejects_truncation_unrecognized_issns_and_duplicate_pages(self):
        cases = [
            [{"count": "10000", "idlist": ["1"]}],
            [{"count": "0", "idlist": [], "warninglist": {"quotedphrasesnotfound": ['"bad"[Journal]']}}],
            [{"count": "2", "idlist": ["1"]}, {"count": "2", "idlist": ["1"]}],
            [{"count": "2", "idlist": ["1"]}, {"count": "2", "idlist": []}],
        ]
        for pages in cases:
            responses = []
            for page in pages:
                response = Mock()
                response.json.return_value = {"esearchresult": page}
                responses.append(response)
            with self.subTest(pages=pages), patch.object(fetch.requests, "get", side_effect=responses), \
                 patch.object(fetch.time, "sleep"):
                with self.assertRaises(ValueError):
                    fetch.search_pmids('"1234-5678"[Journal]')

    def test_database_lookup_is_bounded_to_unique_discovered_ids(self):
        ids = [str(pmid) for pmid in range(1, 406)]
        queried = []
        def read(url, *, headers, params):
            batch = params["pmid"][4:-1].split(",")
            queried.append(batch)
            return [{"pmid": pmid} for pmid in batch]
        with patch.object(fetch, "get_json", side_effect=read):
            result = fetch.get_existing_pmids(ids + ["1", "2"])
        self.assertEqual([len(batch) for batch in queried], [200, 200, 5])
        self.assertEqual(result, set(ids))

    def test_partial_query_commit_is_discovered_on_retry_without_reinserting_existing_ids(self):
        paper = lambda pmid: {"pmid": pmid, "title": "Paper " + pmid, "pub_date": "2026-01-01"}
        with patch.object(fetch, "SUPABASE_URL", "https://example.invalid"), \
             patch.object(fetch, "SUPABASE_KEY", "test"), \
             patch.object(fetch, "URO_QUERIES", ["query-one", "query-two"]), \
             patch.object(fetch, "ensure_catalog_capacity"), \
             patch.object(fetch, "search_pmids", side_effect=[["1", "2"], ["1", "2"]]), \
             patch.object(fetch, "get_existing_pmids", side_effect=[set(), {"1"}]), \
             patch.object(fetch, "fetch_details", side_effect=[[paper("1"), paper("2")], [paper("2")]]) as details, \
             patch.object(fetch, "insert_papers", side_effect=[RuntimeError("Second insert batch failed"), 1]) as insert, \
             patch.object(fetch.time, "sleep"):
            with self.assertRaises(SystemExit):
                fetch.main()
        self.assertEqual(details.call_args_list[1].args[0], ["2"])
        self.assertEqual(insert.call_args_list[1].args[0], [paper("2")])

    def test_later_capacity_pause_does_not_turn_an_earlier_query_failure_into_success(self):
        paper = {"pmid": "1", "title": "Paper 1", "pub_date": "2026-01-01"}
        with patch.object(fetch, "SUPABASE_URL", "https://example.invalid"), \
             patch.object(fetch, "SUPABASE_KEY", "test"), \
             patch.object(fetch, "URO_QUERIES", ["failed-query", "later-query"]), \
             patch.object(fetch, "ensure_catalog_capacity"), \
             patch.object(fetch, "search_pmids", side_effect=[requests.Timeout("temporary error"), ["1"]]), \
             patch.object(fetch, "get_existing_pmids", return_value=set()), \
             patch.object(fetch, "fetch_details", return_value=[paper]), \
             patch.object(fetch, "insert_papers", side_effect=fetch.StorageCapacityReached()), \
             patch.object(fetch.time, "sleep"):
            with self.assertRaises(SystemExit) as stopped:
                fetch.main()
        self.assertNotEqual(stopped.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
