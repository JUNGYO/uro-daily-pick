# All-time catalog audit and Qwen conversion

Audit baseline on 2026-09-14: the production catalog contained 977 papers, all published in 2026, with dates from March 1 through September 13. There were 177 Gemini full-text summaries, 33 Qwen full-text summaries and 767 records without a model summary at the first snapshot. All ready summaries had structured details and Q&A.

## Findings

- Daily ingestion searched only the previous seven publication days. It had no all-time historical backfill.
- Quoted short journal names returned zero results for Journal of Urology, International Journal of Urology, Journal of Clinical Oncology, Lancet Oncology, Annals of Oncology, Clinical Cancer Research and New England Journal of Medicine. Unquoted journal-field queries correctly map these names to PubMed's journal identifiers. For example, Journal of Urology then returned 58,112 all-time records.
- Articles without abstracts were discarded on ingestion and again excluded from recommendations, even when a verified full-text summary could be available.
- The Qwen worker selected missing summaries only, leaving existing Gemini summaries outside its candidate queue.

## Applied design

The 30 configured journal searches now use PubMed journal mapping, including the former British Journal of Urology and Scandinavian Journal of Urology and Nephrology titles. Oncology and general-journal queries retain their urology subject scope.

All-time catalog backfill has no publication-date or import-date filter. It recursively partitions oversized searches into disjoint PMID ranges, retaining an open-ended right range. Each leaf must return its complete unique identifier list. This avoids PubMed's ESearch retrieval ceiling without silently taking only the first page. Citation batches are stored idempotently before their durable database checkpoint advances. Missing metadata remains recorded for retry.

Daily ingestion uses entry date for new arrivals, including late-indexed older papers. It retains citations without abstracts and all publication types. Recommendation filters still distinguish research articles from editorial material, but no longer require an abstract when a valid body summary exists.

Every catalog paper whose summary is absent, stale, lacks required details, or uses another model enters the Qwen queue without a date cutoff. Existing originals in the Z8 cloud-archive are reused after hash verification. A valid existing summary remains visible until its Qwen replacement is ready. Qwen produces three lines, study design, sample size, population, key findings and Q&A. Bodies stay on Z8; only summaries and metadata are published.

The all-time cloud workflow runs hourly and resumes for up to 20 minutes per run. The Z8 worker runs hourly for up to 55 minutes without a paper-count cap. These are execution windows, not collection-period limits. Access restrictions, unavailable metadata and invalid generated summaries remain visible retry states; they are not represented as completed articles.

The admin page reports catalog size, publication span, Qwen completion/pending counts and historical metadata progress. It distinguishes citation collection from body acquisition and model processing.

## Primary references

[PubMed Help](https://pubmed.ncbi.nlm.nih.gov/help/) documents journal-name mapping, date fields and the absence of abstracts in many older records. [NCBI E-utilities documentation](https://www.ncbi.nlm.nih.gov/books/NBK25499/) documents the PubMed search retrieval limit and supported Entrez query syntax.
