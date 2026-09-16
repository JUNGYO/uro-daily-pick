import dataclasses
import re
import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from journal_registry import (
    JOURNALS,
    JOURNALS_BY_ID,
    MJL_CATEGORY,
    MJL_SOURCE,
    REGISTRY_REVIEWED_ON,
    REGISTRY_VERSION,
    UROLOGY_KEYWORD_FILTER,
    JournalSpec,
    build_journal_queries,
    journal_entries,
)


class JournalRegistryTests(unittest.TestCase):
    def test_approved_scope_and_new_journal_count(self):
        self.assertEqual(len(JOURNALS), 65)
        self.assertEqual(Counter(j.group for j in JOURNALS),
                         {"urology": 51, "oncology": 8, "general": 6})
        scie = [j for j in JOURNALS if j.edition == "SCIE"]
        self.assertEqual(Counter(j.scope for j in scie),
                         {"urology": 48, "mixed": 2})
        self.assertEqual([j.id for j in JOURNALS if j.edition == "ESCI"],
                         ["asian-journal-of-urology"])
        self.assertEqual(sum(j.legacy_query is None for j in JOURNALS), 35)
        self.assertEqual(sum(j.legacy_query is not None and j.edition == "SCIE"
                             for j in JOURNALS), 15)
        self.assertNotIn("nephrology", {j.scope for j in JOURNALS})
        for excluded in ("kidney-international", "nature-reviews-nephrology",
                         "advances-in-kidney-disease-and-health", "bmc-nephrology"):
            self.assertNotIn(excluded, JOURNALS_BY_ID)

    def test_stable_identities_and_immutable_metadata(self):
        self.assertIs(journal_entries(), JOURNALS)
        self.assertEqual(len(JOURNALS_BY_ID), 65)
        self.assertEqual(REGISTRY_VERSION, "2026-09-17.urology-centered-65.v1")
        for journal in JOURNALS:
            self.assertRegex(journal.id, r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
            self.assertIs(JOURNALS_BY_ID[journal.id], journal)
        self.assertEqual(JOURNALS_BY_ID["prostate"].legacy_title, "The Prostate")
        self.assertEqual(JOURNALS_BY_ID["urologic-oncology"].issn, "1078-1439")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            JOURNALS[0].id = "changed"
        with self.assertRaises(TypeError):
            JOURNALS_BY_ID["unexpected"] = JOURNALS[0]
        # A display-name correction does not rewrite a checkpoint identity.
        self.assertEqual(dataclasses.replace(JOURNALS[0], display_name="New label").id,
                         "european-urology")

    def test_issn_checksums_and_cross_journal_identity_collisions(self):
        owners = {}
        for journal in JOURNALS:
            identifiers = journal.issns + tuple(
                issn for alias in journal.aliases for issn in alias.issns
            )
            self.assertTrue(journal.issns, journal.id)
            for issn in identifiers:
                self.assertRegex(issn, r"^\d{4}-\d{3}[\dX]$")
                digits = issn.replace("-", "")
                values = [10 if c == "X" else int(c) for c in digits]
                self.assertEqual(sum(x * weight for x, weight in zip(values, range(8, 0, -1))) % 11,
                                 0, (journal.id, issn))
                self.assertIn(owners.setdefault(issn, journal.id), [journal.id], issn)
            self.assertLessEqual(set(journal.metadata_only_issns), set(identifiers))

    def test_queries_use_only_exact_journal_identifiers_and_existing_filter(self):
        self.assertEqual(build_journal_queries(), [j.query for j in JOURNALS])
        self.assertEqual(len(set(build_journal_queries())), 65)
        for journal in JOURNALS:
            query = journal.query
            ids = re.findall(r'"(\d{4}-\d{3}[\dX])"\[Journal\]', query)
            self.assertEqual(ids, list(journal.query_issns), journal.id)
            self.assertEqual(len(ids), len(set(ids)), journal.id)
            remainder = re.sub(r'"\d{4}-\d{3}[\dX]"\[Journal\]', "ID", query)
            journal_part = "(" + " OR ".join("ID" for _ in ids) + ")"
            expected = journal_part
            if journal.group != "urology":
                expected += " AND " + UROLOGY_KEYWORD_FILTER
            self.assertEqual(remainder, expected, journal.id)
            self.assertNotIn("[All Fields]", query)
            self.assertNotIn("[dp]", query)  # Caller retains its established date policy.
        self.assertNotIn("Cancer[", JOURNALS_BY_ID["cancer"].query)
        self.assertNotIn("JAMA[", JOURNALS_BY_ID["jama"].query)

    def test_verified_predecessors_are_searchable_without_title_fallback(self):
        expected = {
            "bju-international": {"0007-1331"},
            "scandinavian-journal-of-urology": {"0036-5599", "1651-2065"},
            "french-journal-of-urology": {"1166-7087"},
            "investigative-and-clinical-urology": {"2005-6737", "2005-6745"},
            "urolithiasis": {"0300-5623"},
            "minerva-urology-and-nephrology": {"0393-2249"},
            "urologie": {"0340-2592", "1433-0563"},
            "nature-reviews-urology": {"1743-4270"},
        }
        for ident, aliases in expected.items():
            journal = JOURNALS_BY_ID[ident]
            self.assertLessEqual(aliases, set(journal.query_issns), ident)
            for alias in journal.aliases:
                self.assertTrue(alias.source_url.startswith("https://"))
                self.assertNotIn(alias.title, journal.query)

    def test_unindexed_identifiers_remain_metadata_without_dropping_journals(self):
        tau = JOURNALS_BY_ID["translational-andrology-and-urology"]
        self.assertIn("2223-4683", tau.issns)
        self.assertEqual(tau.query, '("2223-4691"[Journal])')
        wjmh = JOURNALS_BY_ID["world-journal-of-mens-health"]
        self.assertIn("1229-1692", wjmh.aliases[0].issns)
        self.assertNotIn("1229-1692", wjmh.query)
        self.assertEqual(set(wjmh.query_issns), {"2287-4208", "2287-4690"})
        no_searchable = JournalSpec("empty", "Never search by label", None, None)
        with self.assertRaisesRegex(ValueError, "no searchable ISSN"):
            _ = no_searchable.query

    def test_membership_provenance_does_not_relabel_retained_ancillary_journals(self):
        for journal in JOURNALS:
            self.assertEqual(journal.source_date, REGISTRY_REVIEWED_ON)
            if journal.group == "urology":
                self.assertEqual(journal.source_url, MJL_SOURCE)
                self.assertEqual(journal.category, MJL_CATEGORY)
            else:
                self.assertIsNone(journal.edition)
                self.assertIsNone(journal.category)
                self.assertTrue(journal.source_url.startswith(
                    "https://www.ncbi.nlm.nih.gov/nlmcatalog/"))

    def test_legacy_queries_are_exact_historical_strings_not_equivalence_claims(self):
        # Independent pre-expansion fixture: preserve old checkpoint keys even
        # when the new ISSN query has different PubMed mapping or prior titles.
        old_urology = [
            "European Urology", "Journal of Urology", "BJU International", "Urology",
            "World Journal of Urology", "Nature Reviews Urology", "European Urology Focus",
            "European Urology Oncology", "Prostate Cancer and Prostatic Diseases",
            "Neurourology and Urodynamics", "Journal of Endourology",
            "International Journal of Urology", "Urologic Oncology", "The Prostate",
            "Scandinavian Journal of Urology", "Asian Journal of Urology",
        ]
        old_ancillary = [
            "Journal of Clinical Oncology", "Lancet Oncology", "JAMA Oncology",
            "Annals of Oncology", "Clinical Cancer Research", "Cancer Research", "Cancer",
            "European Journal of Cancer", "New England Journal of Medicine", "Lancet",
            "JAMA", "BMJ", "Nature Medicine", "JAMA Network Open",
        ]
        expected = [f"{name}[Journal]" for name in old_urology]
        expected[2] = "(BJU International[Journal] OR British Journal of Urology[Journal])"
        expected[14] = ("(Scandinavian Journal of Urology[Journal] OR "
                        "Scandinavian Journal of Urology and Nephrology[Journal])")
        old_filter = "(urology OR urologic OR prostate OR bladder OR kidney OR renal OR testicular)"
        expected.extend(f"({name}[Journal]) AND {old_filter}" for name in old_ancillary)
        self.assertEqual([j.legacy_query for j in JOURNALS[:30]], expected)
        self.assertTrue(all(j.legacy_query is None for j in JOURNALS[30:]))
        self.assertTrue(all(j.legacy_query != j.query for j in JOURNALS[:30]))


if __name__ == "__main__":
    unittest.main()
