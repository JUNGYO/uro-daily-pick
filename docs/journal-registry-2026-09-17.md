# Journal registry: urology-centered 65

Registry version: `2026-09-17.urology-centered-65.v1`. Bibliographic review date: **2026-09-17**.

## Approved scope

The [Clarivate Master Journal List](https://mjl.clarivate.com/search-results), filtered to **Science Citation Index Expanded (SCIE)** and **UROLOGY & NEPHROLOGY**, returned 88 journal identities on the review date. SSCI, AHCI and ESCI were not included in that count. A JCR category total that includes ESCI is a different denominator.

The registry selects 48 journals concerning clinical urology, uro-oncology, andrology, sexual medicine, male health or pelvic floor disorders, plus two journals covering both urology and nephrology. It excludes the remaining 38 journals centered on nephrology, renal physiology, dialysis, renal nursing or nutrition. This is an editorial scope decision within the audited category, not a Clarivate subcategory and not a claim to include every potentially relevant journal from other categories.

The two mixed journals are [International Urology and Nephrology](https://link.springer.com/journal/11255/aims-and-scope) and [Minerva Urology and Nephrology](https://www.minervamedica.it/en/journals/minerva-urology-nephrology/aims-and-scope.php). Both publishers explicitly include urological and nephrological research.

The existing **Asian Journal of Urology** remains included as **ESCI**, separately from those 50 SCIE journals. The established eight oncology and six general medicine journals also remain, with their existing urology keyword filter. These 14 are retained sources, not additions to the category's SCIE count; this audit does not make a new edition-membership claim for them.

The total is **50 SCIE + 1 retained ESCI + 14 retained ancillary journals = 65 identities**, adding 35 to the earlier 30. All languages and publication types remain eligible at discovery. Existing date and downstream recommendation policies are applied by their existing callers.

## Search and checkpoint contract

[The registry](../scripts/journal_registry.py) has no network or filesystem activity when imported. Each journal has an explicit stable `id`, a display name, current ISSN/eISSN metadata, verified prior-title identifiers, a source and review date. The identifiers do not change when labels are corrected.

`journal_entries()` returns immutable records; `build_journal_queries()` returns their date-independent search strings. Queries combine **quoted ISSNs in the PubMed `[Journal]` field**. Journal identities do not fall back to title mapping, automatic translation or a general text search. Oncology and general medicine journals retain this exact filter, including PubMed's established mapping of its unqualified topic keywords:

```text
(urology OR urologic OR prostate OR bladder OR kidney OR renal OR testicular)
```

The caller continues to apply the 2000-01-01 publication cutoff, paging and PMID deduplication. A current ISSN does not automatically imply complete coverage of previous titles, and a title's SCIE inclusion does not imply that every historical volume is in PubMed.

`legacy_query` reproduces each of the earlier 30 query strings exactly. It identifies historical checkpoints; it does **not** assert equivalence with the new ISSN search. A changed query needs fresh reconciliation while its prior checkpoint and progress remain preserved. The 35 added identities have `legacy_query=None`, which lets the backfill scheduler prioritize them explicitly.

Two verified identifiers were not recognized in the count-only PubMed check on the review date: TAU print ISSN `2223-4683` and the Korean Journal of Andrology predecessor ISSN `1229-1692`. They remain auditable metadata in `metadata_only_issns`, and are excluded from generated queries. TAU is searched through `2223-4691`; World Journal of Men's Health is searched through its current identifiers. No journal is dropped because one alternative identifier is unindexed. An unrecognized whole query must not be treated as successfully completed.

## Live PubMed count validation

At **2026-09-17 05:26 KST**, all 65 final queries combined with `2000:3000[dp]` returned HTTP 200, positive counts and no ESearch errors or warnings. The public [NCBI ESearch endpoint](https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi) was called sequentially, below two requests per second, with normal certificate validation and `retmax=0`. No article records or original bodies were retrieved. No transport retries were needed.

| Exact OR-union scope | Distinct PubMed matches | Query SHA-256 |
| --- | ---: | --- |
| Final 65 registry queries | 240,504 | `19ca47f79a2aa814f3afc3708114887e669f928d5b34a7ddb3197b339a41fab3` |
| Earlier 30 exact legacy queries | 152,114 | `0405ee6a94d56647b6880e2c4ebd0630f450c5e61b423731d024c2a4dc8de698` |

Both unions used the same `2000:3000[dp]` range and returned no errors or warnings. The net difference is **88,390 matches (+58.1%)**. Because the journal query syntax and verified historical aliases changed, this is a comparison of result-set sizes, not a measured set difference or a claim that every legacy match is included. PubMed updates can change these counts; they do not establish registration, original availability or summary completion.

## Provenance and limits

Current identifiers for the 50 selected SCIE titles and the retained ESCI title were reviewed against MJL. The ancillary identifiers and the Scandinavian predecessor identifiers were checked against the [NLM MEDLINE journal metadata export](https://ftp.ncbi.nlm.nih.gov/pubmed/J_Medline.txt); the registry also records the corresponding public NLM Catalog URLs.

The seven relevant predecessor chains from the expansion audit are included, along with the two pre-existing BJU/Scandinavian aliases. The earlier Nature Reviews Nephrology and Advances in Kidney Disease and Health chains are outside the approved scope. This is a bounded title-history audit; it does not claim an exhaustive historical genealogy. In particular, PubMed coverage for Korean Journal of Urology begins in 2010, and the [World Journal of Men's Health history](https://www.wjmh.org/index.php?body=history) reports PubMed participation from 2013.

The dedicated registry tests verify the approved counts, explicit scope, unique identities, ISSN checksums, absence of cross-journal identifier collisions, exact search-field syntax, ancillary keyword filters, historical-query preservation and metadata-only identifiers. Search-match counts are distinct from registered citations, acquired originals and completed summaries.

## Current identities

The first 30 records preserve the original ordering. “Added” marks the 35 new identities. A missing eISSN below means that a separate eISSN was not supplied by the audited record; the primary ISSN can itself identify an online journal.

| Stable ID | Journal | ISSN | eISSN | Scope / edition | Status |
| --- | --- | --- | --- | --- | --- |
| `european-urology` | European Urology | 0302-2838 | 1873-7560 | urology / SCIE | Retained |
| `journal-of-urology` | Journal of Urology | 0022-5347 | 1527-3792 | urology / SCIE | Retained |
| `bju-international` | BJU International | 1464-4096 | 1464-410X | urology / SCIE | Retained |
| `urology` | Urology | 0090-4295 | 1527-9995 | urology / SCIE | Retained |
| `world-journal-of-urology` | World Journal of Urology | 0724-4983 | 1433-8726 | urology / SCIE | Retained |
| `nature-reviews-urology` | Nature Reviews Urology | 1759-4812 | 1759-4820 | urology / SCIE | Retained |
| `european-urology-focus` | European Urology Focus | 2405-4569 | - | urology / SCIE | Retained |
| `european-urology-oncology` | European Urology Oncology | 2588-9311 | - | urology / SCIE | Retained |
| `prostate-cancer-and-prostatic-diseases` | Prostate Cancer and Prostatic Diseases | 1365-7852 | 1476-5608 | urology / SCIE | Retained |
| `neurourology-and-urodynamics` | Neurourology and Urodynamics | 0733-2467 | 1520-6777 | urology / SCIE | Retained |
| `journal-of-endourology` | Journal of Endourology | 0892-7790 | 1557-900X | urology / SCIE | Retained |
| `international-journal-of-urology` | International Journal of Urology | 0919-8172 | 1442-2042 | urology / SCIE | Retained |
| `urologic-oncology` | Urologic Oncology | 1078-1439 | 1873-2496 | urology / SCIE | Retained |
| `prostate` | The Prostate | 0270-4137 | 1097-0045 | urology / SCIE | Retained |
| `scandinavian-journal-of-urology` | Scandinavian Journal of Urology | 2168-1805 | 2168-1813 | urology / SCIE | Retained |
| `asian-journal-of-urology` | Asian Journal of Urology | 2214-3882 | 2214-3890 | urology / ESCI | Retained |
| `journal-of-clinical-oncology` | Journal of Clinical Oncology | 0732-183X | 1527-7755 | ancillary / retained oncology | Retained |
| `lancet-oncology` | Lancet Oncology | 1470-2045 | 1474-5488 | ancillary / retained oncology | Retained |
| `jama-oncology` | JAMA Oncology | 2374-2437 | 2374-2445 | ancillary / retained oncology | Retained |
| `annals-of-oncology` | Annals of Oncology | 0923-7534 | 1569-8041 | ancillary / retained oncology | Retained |
| `clinical-cancer-research` | Clinical Cancer Research | 1078-0432 | 1557-3265 | ancillary / retained oncology | Retained |
| `cancer-research` | Cancer Research | 0008-5472 | 1538-7445 | ancillary / retained oncology | Retained |
| `cancer` | Cancer | 0008-543X | 1097-0142 | ancillary / retained oncology | Retained |
| `european-journal-of-cancer` | European Journal of Cancer | 0959-8049 | 1879-0852 | ancillary / retained oncology | Retained |
| `new-england-journal-of-medicine` | New England Journal of Medicine | 0028-4793 | 1533-4406 | ancillary / retained general | Retained |
| `lancet` | Lancet | 0140-6736 | 1474-547X | ancillary / retained general | Retained |
| `jama` | JAMA | 0098-7484 | 1538-3598 | ancillary / retained general | Retained |
| `bmj` | BMJ | 0959-8138 | 1756-1833 | ancillary / retained general | Retained |
| `nature-medicine` | Nature Medicine | 1078-8956 | 1546-170X | ancillary / retained general | Retained |
| `jama-network-open` | JAMA Network Open | - | 2574-3805 | ancillary / retained general | Retained |
| `actas-urologicas-espanolas` | Actas Urologicas Espanolas | 0210-4806 | 1699-7980 | urology / SCIE | Added |
| `aging-male` | Aging Male | 1368-5538 | 1473-0790 | urology / SCIE | Added |
| `aktuelle-urologie` | Aktuelle Urologie | 0001-7868 | 1438-8820 | urology / SCIE | Added |
| `archivos-espanoles-de-urologia` | Archivos Espanoles de Urologia | 0004-0614 | 1576-8260 | urology / SCIE | Added |
| `asian-journal-of-andrology` | Asian Journal of Andrology | 1008-682X | 1745-7262 | urology / SCIE | Added |
| `bladder-cancer` | Bladder Cancer | 2352-3727 | 2352-3735 | urology / SCIE | Added |
| `bmc-urology` | BMC Urology | 1471-2490 | - | urology / SCIE | Added |
| `canadian-journal-of-urology` | Canadian Journal of Urology | 1195-9479 | 1488-5581 | urology / SCIE | Added |
| `clinical-genitourinary-cancer` | Clinical Genitourinary Cancer | 1558-7673 | 1938-0682 | urology / SCIE | Added |
| `cuaj-canadian-urological-association-journal` | CUAJ-Canadian Urological Association Journal | 1911-6470 | 1920-1214 | urology / SCIE | Added |
| `current-opinion-in-urology` | Current Opinion in Urology | 0963-0643 | 1473-6586 | urology / SCIE | Added |
| `current-urology-reports` | Current Urology Reports | 1527-2737 | 1534-6285 | urology / SCIE | Added |
| `european-urology-open-science` | European Urology Open Science | 2666-1691 | 2666-1683 | urology / SCIE | Added |
| `french-journal-of-urology` | French Journal of Urology | 2950-4201 | 2950-3930 | urology / SCIE | Added |
| `international-braz-j-urol` | International Braz J Urol | 1677-5538 | 1677-6119 | urology / SCIE | Added |
| `international-journal-of-impotence-research` | International Journal of Impotence Research | 0955-9930 | 1476-5489 | urology / SCIE | Added |
| `international-neurourology-journal` | International Neurourology Journal | 2093-4777 | 2093-6931 | urology / SCIE | Added |
| `international-urogynecology-journal` | International Urogynecology Journal | 0937-3462 | 1433-3023 | urology / SCIE | Added |
| `international-urology-and-nephrology` | International Urology and Nephrology | 0301-1623 | 1573-2584 | mixed / SCIE | Added |
| `investigative-and-clinical-urology` | Investigative and Clinical Urology | 2466-0493 | 2466-054X | urology / SCIE | Added |
| `journal-of-pediatric-urology` | Journal of Pediatric Urology | 1477-5131 | 1873-4898 | urology / SCIE | Added |
| `journal-of-sexual-medicine` | Journal of Sexual Medicine | 1743-6095 | 1743-6109 | urology / SCIE | Added |
| `luts-lower-urinary-tract-symptoms` | LUTS-Lower Urinary Tract Symptoms | 1757-5664 | 1757-5672 | urology / SCIE | Added |
| `minerva-urology-and-nephrology` | Minerva Urology and Nephrology | 2724-6051 | 2724-6442 | mixed / SCIE | Added |
| `prostate-international` | Prostate International | 2287-8882 | 2287-903X | urology / SCIE | Added |
| `sexual-medicine` | Sexual Medicine | 2050-1161 | - | urology / SCIE | Added |
| `sexual-medicine-reviews` | Sexual Medicine Reviews | 2050-0513 | 2050-0521 | urology / SCIE | Added |
| `therapeutic-advances-in-urology` | Therapeutic Advances in Urology | 1756-2872 | 1756-2880 | urology / SCIE | Added |
| `translational-andrology-and-urology` | Translational Andrology and Urology | 2223-4683 | 2223-4691 | urology / SCIE | Added |
| `urolithiasis` | Urolithiasis | 2194-7228 | 2194-7236 | urology / SCIE | Added |
| `urologia-internationalis` | Urologia Internationalis | 0042-1138 | 1423-0399 | urology / SCIE | Added |
| `urologic-clinics-of-north-america` | Urologic Clinics of North America | 0094-0143 | 1558-318X | urology / SCIE | Added |
| `urologie` | Urologie | 2731-7064 | 2731-7072 | urology / SCIE | Added |
| `urology-journal` | Urology Journal | 1735-1308 | 1735-546X | urology / SCIE | Added |
| `world-journal-of-mens-health` | World Journal of Men's Health | 2287-4208 | 2287-4690 | urology / SCIE | Added |

## Verified prior titles

Prior-title identifiers are combined with the current identity, rather than counted as additional journals. The Korean Journal of Andrology row remains metadata only as described above.

| Current journal | Prior title | Prior ISSNs | Primary source |
| --- | --- | --- | --- |
| BJU International | British Journal of Urology | 0007-1331 | [NLM Catalog](https://www.ncbi.nlm.nih.gov/nlmcatalog/100886721) |
| Nature Reviews Urology | Nature clinical practice. Urology | 1743-4270 | [NLM Catalog](https://www.ncbi.nlm.nih.gov/nlmcatalog/101500082) |
| Scandinavian Journal of Urology | Scandinavian Journal of Urology and Nephrology | 0036-5599, 1651-2065 | [NLM Catalog](https://www.ncbi.nlm.nih.gov/nlmcatalog/0114501) |
| French Journal of Urology | Progres en urologie | 1166-7087 | [NLM Catalog](https://www.ncbi.nlm.nih.gov/nlmcatalog/9307844) |
| Investigative and Clinical Urology | Korean Journal of Urology | 2005-6737, 2005-6745 | [NLM Catalog](https://www.ncbi.nlm.nih.gov/nlmcatalog/101499376) |
| Minerva Urology and Nephrology | Minerva urologica e nefrologica | 0393-2249 | [NLM Catalog](https://www.ncbi.nlm.nih.gov/nlmcatalog/101777299) |
| Urolithiasis | Urological Research | 0300-5623 | [NLM Catalog](https://www.ncbi.nlm.nih.gov/nlmcatalog/101602699) |
| Urologie | Der Urologe. Ausg. A | 0340-2592, 1433-0563 | [NLM Catalog](https://www.ncbi.nlm.nih.gov/nlmcatalog?term=1304110%5Bnlmid%5D) |
| World Journal of Men's Health | Korean Journal of Andrology | 1229-1692 | [Publisher history](https://www.wjmh.org/index.php?body=history) |
