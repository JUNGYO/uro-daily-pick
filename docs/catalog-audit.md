# Catalog audit and full-text processing

Audit baseline on 2026-09-14: the production catalog contained 977 papers, all published in 2026, with dates from March 1 through September 13. There were 177 Gemini full-text summaries, 33 Qwen full-text summaries and 767 records without a model summary at the first snapshot. All ready summaries had structured details and Q&A.

The 30 corrected queries were then checked against the official API with no date filters: 238,421 query matches in total, before PMID deduplication, with no zero-result queries or query warnings. See [the per-query inventory](catalog-search-inventory-2026-09-14.md). This source total is not an import or summary completion count.

All original 977 PMIDs were also retrieved again successfully. Current PubMed metadata differed in 335 publication dates, 54 titles, 75 abstracts, 18 author lists, 469 MeSH lists and 268 publication-type lists. These include subsequent indexing and publisher corrections, not just parser defects. A durable snapshot audits every already-collected PMID, even outside the configured journal searches. Citation upserts update source metadata while preserving summary fields and user activity. Title corrections invalidate stale summary provenance through the database guard and enter the Qwen queue again. A matching DOI and closely matching corrected title allow reuse of the hash-verified Z8 original.

## Findings

- Daily ingestion searched only the previous seven publication days. It had no all-time historical backfill.
- Quoted short journal names returned zero results for Journal of Urology, International Journal of Urology, Journal of Clinical Oncology, Lancet Oncology, Annals of Oncology, Clinical Cancer Research and New England Journal of Medicine. Unquoted journal-field queries correctly map these names to PubMed's journal identifiers. For example, Journal of Urology then returned 58,112 all-time records.
- Articles without abstracts were discarded on ingestion and again excluded from recommendations, even when a verified full-text summary could be available.
- The Qwen worker selected missing summaries only, leaving existing Gemini summaries outside its candidate queue.

## Applied design

The 30 configured journal searches now use PubMed journal mapping, including the former British Journal of Urology and Scandinavian Journal of Urology and Nephrology titles. Oncology and general-journal queries retain their urology subject scope.

Automatic catalog backfill uses publication dates from 2000-01-01 inclusive. The cutoff is part of each checkpoint identity; earlier all-time checkpoints and stored citations remain preserved outside automatic processing. It recursively partitions oversized searches into disjoint PMID ranges, retaining an open-ended right range. Each leaf must return its complete unique identifier list. This avoids PubMed's ESearch retrieval ceiling without silently taking only the first page. Citation batches are stored idempotently before their durable database checkpoint advances. Missing metadata remains recorded for retry.

Daily ingestion uses entry date for new arrivals, including late-indexed older papers. It retains citations without abstracts and all publication types. Recommendation filters still distinguish research articles from editorial material, but no longer require an abstract when a valid body summary exists.

Catalog papers published from 2000-01-01 whose summaries are absent, stale, incomplete, or use another model enter the Qwen queue. Older and undated citations stay preserved, with explicit PMID requests available for selected older papers. Existing originals in the Z8 cloud-archive are reused after hash verification. A valid existing summary remains visible until its Qwen replacement is ready. Qwen produces three lines, study design, sample size, population, key findings and Q&A. Bodies stay on Z8; only summaries and metadata are published.

The date-scoped cloud workflow runs hourly and resumes for up to 20 minutes per run. The Z8 worker runs hourly for up to 55 minutes without a paper-count cap. These are execution windows, not collection-period limits. Access restrictions, unavailable metadata and invalid generated summaries remain visible retry states; they are not represented as completed articles.

The admin page separates registered citation metadata, acquired originals, and completed body summaries for the same 2000-onward scope. Acquisition receipts register an original before inference. It shows acquisition and summary percentages with explicit denominators, separate pending counts, and a storage meter. Hardware/model names and internal queue details are omitted from product copy. Recommendations prioritize the last five calendar years, with eligible older papers filling remaining places; saved reading history remains unchanged.

The first production run completed successfully with 47,919 catalog papers, reaching February 17, 1866, and no unresolved metadata omissions at that checkpoint. Qwen had produced 83 validated summaries at the same snapshot. These stages continue independently.

The current free database has a 500 MB allowance. Collection checks a private 450 MiB database budget and preserves its checkpoint before exceeding it, leaving room for the running service. This is a storage safeguard, not a date or paper-count restriction. Capacity must be adjusted only after the owner approves a suitable plan. Unchanged citations are skipped before upsert to avoid unnecessary writes and table bloat. Admin shows database usage and a capacity-waiting message when applicable.

## Primary references

[PubMed Help](https://pubmed.ncbi.nlm.nih.gov/help/) documents journal-name mapping, date fields and the absence of abstracts in many older records. [NCBI E-utilities documentation](https://www.ncbi.nlm.nih.gov/books/NBK25499/) documents the PubMed search retrieval limit and supported Entrez query syntax.
