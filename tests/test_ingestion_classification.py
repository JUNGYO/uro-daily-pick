import sys
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import fetch_papers as fetch
from catalog_policy import automatic_paper


def pubmed_article(mesh_terms=(), pub_types=("Journal Article",), year=2024):
    """A local PubMed XML fixture with normal citation and index structures."""
    mesh_xml = "".join(
        f'<MeshHeading><DescriptorName MajorTopicYN="N">{escape(term)}</DescriptorName></MeshHeading>'
        for term in mesh_terms
    )
    types_xml = "".join(f"<PublicationType>{escape(kind)}</PublicationType>" for kind in pub_types)
    return ET.fromstring(f"""
        <PubmedArticle>
          <MedlineCitation Status="MEDLINE">
            <PMID Version="1">12345678</PMID>
            <Article>
              <Journal>
                <JournalIssue><Volume>12</Volume><Issue>3</Issue>
                  <PubDate><Year>{year}</Year><Month>Mar</Month><Day>5</Day></PubDate>
                </JournalIssue>
                <Title>Urology</Title>
              </Journal>
              <ArticleTitle>Outcomes of <i>active surveillance</i> in selected patients</ArticleTitle>
              <Pagination><MedlinePgn>120-125</MedlinePgn></Pagination>
              <Abstract>
                <AbstractText Label="OBJECTIVE">We assessed patient outcomes.</AbstractText>
                <AbstractText Label="RESULTS">Follow-up included <b>100</b> patients.</AbstractText>
              </Abstract>
              <AuthorList><Author><LastName>Lee</LastName><ForeName>Grace</ForeName></Author></AuthorList>
              <PublicationTypeList>{types_xml}</PublicationTypeList>
            </Article>
            <MeshHeadingList>{mesh_xml}</MeshHeadingList>
            <KeywordList><Keyword>active surveillance</Keyword></KeywordList>
          </MedlineCitation>
          <PubmedData><ArticleIdList>
            <ArticleId IdType="pubmed">12345678</ArticleId>
            <ArticleId IdType="doi">10.0000/fixture.2024.1</ArticleId>
          </ArticleIdList></PubmedData>
        </PubmedArticle>
    """)


class IngestionClassificationTests(unittest.TestCase):
    def test_mesh_only_design_survives_ingestion(self):
        for term, expected in (("Retrospective Studies", "retrospective"),
                               ("Prospective Studies", "prospective")):
            with self.subTest(term=term):
                paper = fetch.parse_article(pubmed_article(mesh_terms=[term]))
                self.assertEqual(paper["study_type"], expected)
                self.assertEqual(paper["mesh_terms"], [term])

    def test_publication_type_priority_over_mesh_is_preserved(self):
        for publication_type, expected in (("Randomized Controlled Trial", "rct"),
                                            ("Meta-Analysis", "meta_analysis")):
            with self.subTest(publication_type=publication_type):
                paper = fetch.parse_article(pubmed_article(
                    mesh_terms=["Retrospective Studies", "Prospective Studies"],
                    pub_types=["Journal Article", publication_type],
                ))
                self.assertEqual(paper["study_type"], expected)

    def test_mesh_rct_retains_existing_priority(self):
        paper = fetch.parse_article(pubmed_article(
            mesh_terms=["Prospective Studies", "Retrospective Studies", "Randomized Controlled Trial"],
            pub_types=["Meta-Analysis"],
        ))
        self.assertEqual(paper["study_type"], "rct")

    def test_unknown_design_remains_explicit_other(self):
        paper = fetch.parse_article(pubmed_article(
            mesh_terms=["Humans", "Cohort Studies"],
            pub_types=["Journal Article", "Clinical Trial, Phase II"],
        ))
        self.assertEqual(paper["study_type"], "other")

    def test_three_argument_helper_still_uses_conservative_text_fallback(self):
        self.assertEqual(fetch.classify_study_type("Patient outcomes", "A retrospective analysis.", []),
                         "retrospective")
        self.assertEqual(fetch.classify_study_type("Single-arm phase III trial", "Patient outcomes.", []),
                         "other")

    def test_citation_metadata_is_preserved(self):
        paper = fetch.parse_article(pubmed_article(mesh_terms=["Retrospective Studies"]))
        expected = {
            "pmid": "12345678",
            "title": "Outcomes of active surveillance in selected patients",
            "abstract": "We assessed patient outcomes. Follow-up included 100 patients.",
            "authors": ["Lee Grace"],
            "journal": "Urology",
            "pub_date": "2024-03-05",
            "mesh_terms": ["Retrospective Studies"],
            "keywords": ["active surveillance"],
            "doi": "10.0000/fixture.2024.1",
            "paper_type": "article",
            "pub_types": ["Journal Article"],
            "publication_types": ["Journal Article"],
            "volume": "12",
            "issue": "3",
            "pages": "120-125",
            "integrity_status": "current",
            "related_notices": [],
        }
        self.assertEqual({key: paper[key] for key in expected}, expected)

    def test_metadata_classification_does_not_change_publication_cutoff(self):
        for year, eligible in ((1999, False), (2000, True)):
            with self.subTest(year=year):
                paper = fetch.parse_article(pubmed_article(mesh_terms=["Retrospective Studies"], year=year))
                self.assertEqual(paper["pub_date"], f"{year}-03-05")
                self.assertEqual(paper["study_type"], "retrospective")
                self.assertEqual(automatic_paper(paper), eligible)


if __name__ == "__main__":
    unittest.main()
