"""Versioned, reviewed journal identities for the 2000-onward literature catalog.

The registry contains public bibliographic metadata only. Importing it performs
no I/O. Date limits, paging, acquisition and recommendation policy remain with
their existing callers. See docs/journal-registry-2026-09-17.md for the audit.
"""

from dataclasses import dataclass
from types import MappingProxyType


REGISTRY_VERSION = "2026-09-17.urology-centered-65.v1"
REGISTRY_REVIEWED_ON = "2026-09-17"
MJL_SOURCE = "https://mjl.clarivate.com/search-results"
MJL_CATEGORY = "UROLOGY & NEPHROLOGY"
NLM_EXPORT_SOURCE = "https://ftp.ncbi.nlm.nih.gov/pubmed/J_Medline.txt"
UROLOGY_KEYWORD_FILTER = (
    "(urology OR urologic OR prostate OR bladder OR kidney OR renal OR testicular)"
)


@dataclass(frozen=True)
class JournalAlias:
    """A verified prior title, with its own identifiers and public source."""

    title: str
    issns: tuple[str, ...]
    source_url: str


@dataclass(frozen=True)
class JournalSpec:
    # IDs are explicitly assigned, never derived from query text or display names.
    id: str
    display_name: str
    issn: str | None
    eissn: str | None
    group: str = "urology"
    scope: str = "urology"
    edition: str | None = "SCIE"
    category: str | None = MJL_CATEGORY
    source_url: str = MJL_SOURCE
    source_date: str = REGISTRY_REVIEWED_ON
    aliases: tuple[JournalAlias, ...] = ()
    legacy_title: str | None = None
    metadata_only_issns: tuple[str, ...] = ()

    @property
    def issns(self) -> tuple[str, ...]:
        """Current print/online identifiers, deduplicated without losing order."""
        return tuple(dict.fromkeys(x for x in (self.issn, self.eissn) if x))

    @property
    def query_issns(self) -> tuple[str, ...]:
        """Verified identifiers usable in PubMed, including eligible prior titles."""
        identifiers = self.issns + tuple(
            issn for alias in self.aliases for issn in alias.issns
        )
        return tuple(
            issn for issn in dict.fromkeys(identifiers)
            if issn not in self.metadata_only_issns
        )

    @property
    def query(self) -> str:
        # Do not fall back to journal-title mapping or All Fields when an ISSN
        # has no PubMed coverage. A reviewed exclusion remains metadata only.
        identifiers = self.query_issns
        if not identifiers:
            raise ValueError(f"Journal {self.id} has no searchable ISSN")
        query = "(" + " OR ".join(f'"{issn}"[Journal]' for issn in identifiers) + ")"
        if self.group in ("oncology", "general"):
            query += " AND " + UROLOGY_KEYWORD_FILTER
        return query

    @property
    def legacy_query(self) -> str | None:
        """Exact pre-expansion query, for retaining and identifying old checkpoints.

        It is historical metadata, not proof that this query equals ``query``.
        Callers must not transfer a completed cursor across changed queries.
        """
        title = self.legacy_title
        if title is None:
            return None
        if self.group in ("oncology", "general"):
            return f"({title}[Journal]) AND {UROLOGY_KEYWORD_FILTER}"
        prior = {
            "BJU International": "British Journal of Urology",
            "Scandinavian Journal of Urology": (
                "Scandinavian Journal of Urology and Nephrology"
            ),
        }.get(title)
        if prior:
            return f"({title}[Journal] OR {prior}[Journal])"
        return f"{title}[Journal]"


_ALIASES = {
    "bju-international": (
        JournalAlias("British Journal of Urology", ("0007-1331",),
                     "https://www.ncbi.nlm.nih.gov/nlmcatalog/100886721"),
    ),
    "scandinavian-journal-of-urology": (
        JournalAlias("Scandinavian Journal of Urology and Nephrology",
                     ("0036-5599", "1651-2065"),
                     "https://www.ncbi.nlm.nih.gov/nlmcatalog/0114501"),
    ),
    "french-journal-of-urology": (
        JournalAlias("Progres en urologie", ("1166-7087",),
                     "https://www.ncbi.nlm.nih.gov/nlmcatalog/9307844"),
    ),
    "investigative-and-clinical-urology": (
        JournalAlias("Korean Journal of Urology", ("2005-6737", "2005-6745"),
                     "https://www.ncbi.nlm.nih.gov/nlmcatalog/101499376"),
    ),
    "urolithiasis": (
        JournalAlias("Urological Research", ("0300-5623",),
                     "https://www.ncbi.nlm.nih.gov/nlmcatalog/101602699"),
    ),
    "minerva-urology-and-nephrology": (
        JournalAlias("Minerva urologica e nefrologica", ("0393-2249",),
                     "https://www.ncbi.nlm.nih.gov/nlmcatalog/101777299"),
    ),
    "urologie": (
        JournalAlias("Der Urologe. Ausg. A", ("0340-2592", "1433-0563"),
                     "https://www.ncbi.nlm.nih.gov/nlmcatalog?term=1304110%5Bnlmid%5D"),
    ),
    "world-journal-of-mens-health": (
        JournalAlias("Korean Journal of Andrology", ("1229-1692",),
                     "https://www.wjmh.org/index.php?body=history"),
    ),
    "nature-reviews-urology": (
        JournalAlias("Nature clinical practice. Urology", ("1743-4270",),
                     "https://www.ncbi.nlm.nih.gov/nlmcatalog/101500082"),
    ),
}


def _j(id, display_name, issn, eissn=None, **kwargs):
    return JournalSpec(id, display_name, issn, eissn,
                       aliases=_ALIASES.get(id, ()), **kwargs)


# Keep the established 30 entries in their original order. New identities follow
# them; backfill may explicitly prioritize entries whose legacy_query is None.
JOURNALS: tuple[JournalSpec, ...] = (
    _j("european-urology", "European Urology", "0302-2838", "1873-7560", legacy_title="European Urology"),
    _j("journal-of-urology", "Journal of Urology", "0022-5347", "1527-3792", legacy_title="Journal of Urology"),
    _j("bju-international", "BJU International", "1464-4096", "1464-410X", legacy_title="BJU International"),
    _j("urology", "Urology", "0090-4295", "1527-9995", legacy_title="Urology"),
    _j("world-journal-of-urology", "World Journal of Urology", "0724-4983", "1433-8726", legacy_title="World Journal of Urology"),
    _j("nature-reviews-urology", "Nature Reviews Urology", "1759-4812", "1759-4820", legacy_title="Nature Reviews Urology"),
    _j("european-urology-focus", "European Urology Focus", "2405-4569", None, legacy_title="European Urology Focus"),
    _j("european-urology-oncology", "European Urology Oncology", "2588-9311", None, legacy_title="European Urology Oncology"),
    _j("prostate-cancer-and-prostatic-diseases", "Prostate Cancer and Prostatic Diseases", "1365-7852", "1476-5608", legacy_title="Prostate Cancer and Prostatic Diseases"),
    _j("neurourology-and-urodynamics", "Neurourology and Urodynamics", "0733-2467", "1520-6777", legacy_title="Neurourology and Urodynamics"),
    _j("journal-of-endourology", "Journal of Endourology", "0892-7790", "1557-900X", legacy_title="Journal of Endourology"),
    _j("international-journal-of-urology", "International Journal of Urology", "0919-8172", "1442-2042", legacy_title="International Journal of Urology"),
    _j("urologic-oncology", "Urologic Oncology", "1078-1439", "1873-2496", legacy_title="Urologic Oncology"),
    _j("prostate", "The Prostate", "0270-4137", "1097-0045", legacy_title="The Prostate"),
    _j("scandinavian-journal-of-urology", "Scandinavian Journal of Urology", "2168-1805", "2168-1813", legacy_title="Scandinavian Journal of Urology"),
    _j("asian-journal-of-urology", "Asian Journal of Urology", "2214-3882", "2214-3890", edition="ESCI", legacy_title="Asian Journal of Urology"),
    _j("journal-of-clinical-oncology", "Journal of Clinical Oncology", "0732-183X", "1527-7755", group="oncology", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/8309333", legacy_title="Journal of Clinical Oncology"),
    _j("lancet-oncology", "Lancet Oncology", "1470-2045", "1474-5488", group="oncology", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/100957246", legacy_title="Lancet Oncology"),
    _j("jama-oncology", "JAMA Oncology", "2374-2437", "2374-2445", group="oncology", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/101652861", legacy_title="JAMA Oncology"),
    _j("annals-of-oncology", "Annals of Oncology", "0923-7534", "1569-8041", group="oncology", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/9007735", legacy_title="Annals of Oncology"),
    _j("clinical-cancer-research", "Clinical Cancer Research", "1078-0432", "1557-3265", group="oncology", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/9502500", legacy_title="Clinical Cancer Research"),
    _j("cancer-research", "Cancer Research", "0008-5472", "1538-7445", group="oncology", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/2984705R", legacy_title="Cancer Research"),
    _j("cancer", "Cancer", "0008-543X", "1097-0142", group="oncology", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/0374236", legacy_title="Cancer"),
    _j("european-journal-of-cancer", "European Journal of Cancer", "0959-8049", "1879-0852", group="oncology", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/9005373", legacy_title="European Journal of Cancer"),
    _j("new-england-journal-of-medicine", "New England Journal of Medicine", "0028-4793", "1533-4406", group="general", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/0255562", legacy_title="New England Journal of Medicine"),
    _j("lancet", "Lancet", "0140-6736", "1474-547X", group="general", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/2985213R", legacy_title="Lancet"),
    _j("jama", "JAMA", "0098-7484", "1538-3598", group="general", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/7501160", legacy_title="JAMA"),
    _j("bmj", "BMJ", "0959-8138", "1756-1833", group="general", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/8900488", legacy_title="BMJ"),
    _j("nature-medicine", "Nature Medicine", "1078-8956", "1546-170X", group="general", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/9502015", legacy_title="Nature Medicine"),
    _j("jama-network-open", "JAMA Network Open", None, "2574-3805", group="general", scope="ancillary", edition=None, category=None, source_url="https://www.ncbi.nlm.nih.gov/nlmcatalog/101729235", legacy_title="JAMA Network Open"),
    _j("actas-urologicas-espanolas", "Actas Urologicas Espanolas", "0210-4806", "1699-7980"),
    _j("aging-male", "Aging Male", "1368-5538", "1473-0790"),
    _j("aktuelle-urologie", "Aktuelle Urologie", "0001-7868", "1438-8820"),
    _j("archivos-espanoles-de-urologia", "Archivos Espanoles de Urologia", "0004-0614", "1576-8260"),
    _j("asian-journal-of-andrology", "Asian Journal of Andrology", "1008-682X", "1745-7262"),
    _j("bladder-cancer", "Bladder Cancer", "2352-3727", "2352-3735"),
    _j("bmc-urology", "BMC Urology", "1471-2490", None),
    _j("canadian-journal-of-urology", "Canadian Journal of Urology", "1195-9479", "1488-5581"),
    _j("clinical-genitourinary-cancer", "Clinical Genitourinary Cancer", "1558-7673", "1938-0682"),
    _j("cuaj-canadian-urological-association-journal", "CUAJ-Canadian Urological Association Journal", "1911-6470", "1920-1214"),
    _j("current-opinion-in-urology", "Current Opinion in Urology", "0963-0643", "1473-6586"),
    _j("current-urology-reports", "Current Urology Reports", "1527-2737", "1534-6285"),
    _j("european-urology-open-science", "European Urology Open Science", "2666-1691", "2666-1683"),
    _j("french-journal-of-urology", "French Journal of Urology", "2950-4201", "2950-3930"),
    _j("international-braz-j-urol", "International Braz J Urol", "1677-5538", "1677-6119"),
    _j("international-journal-of-impotence-research", "International Journal of Impotence Research", "0955-9930", "1476-5489"),
    _j("international-neurourology-journal", "International Neurourology Journal", "2093-4777", "2093-6931"),
    _j("international-urogynecology-journal", "International Urogynecology Journal", "0937-3462", "1433-3023"),
    _j("international-urology-and-nephrology", "International Urology and Nephrology", "0301-1623", "1573-2584", scope="mixed"),
    _j("investigative-and-clinical-urology", "Investigative and Clinical Urology", "2466-0493", "2466-054X"),
    _j("journal-of-pediatric-urology", "Journal of Pediatric Urology", "1477-5131", "1873-4898"),
    _j("journal-of-sexual-medicine", "Journal of Sexual Medicine", "1743-6095", "1743-6109"),
    _j("luts-lower-urinary-tract-symptoms", "LUTS-Lower Urinary Tract Symptoms", "1757-5664", "1757-5672"),
    _j("minerva-urology-and-nephrology", "Minerva Urology and Nephrology", "2724-6051", "2724-6442", scope="mixed"),
    _j("prostate-international", "Prostate International", "2287-8882", "2287-903X"),
    _j("sexual-medicine", "Sexual Medicine", "2050-1161", None),
    _j("sexual-medicine-reviews", "Sexual Medicine Reviews", "2050-0513", "2050-0521"),
    _j("therapeutic-advances-in-urology", "Therapeutic Advances in Urology", "1756-2872", "1756-2880"),
    _j("translational-andrology-and-urology", "Translational Andrology and Urology", "2223-4683", "2223-4691", metadata_only_issns=("2223-4683",)),
    _j("urolithiasis", "Urolithiasis", "2194-7228", "2194-7236"),
    _j("urologia-internationalis", "Urologia Internationalis", "0042-1138", "1423-0399"),
    _j("urologic-clinics-of-north-america", "Urologic Clinics of North America", "0094-0143", "1558-318X"),
    _j("urologie", "Urologie", "2731-7064", "2731-7072"),
    _j("urology-journal", "Urology Journal", "1735-1308", "1735-546X"),
    _j("world-journal-of-mens-health", "World Journal of Men's Health", "2287-4208", "2287-4690", metadata_only_issns=("1229-1692",)),
)

JOURNALS_BY_ID = MappingProxyType({journal.id: journal for journal in JOURNALS})


def journal_entries() -> tuple[JournalSpec, ...]:
    return JOURNALS


def build_journal_queries() -> list[str]:
    """Compatibility list for callers that only consume date-independent queries."""
    return [journal.query for journal in JOURNALS]
