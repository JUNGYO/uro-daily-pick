BEGIN;
SET LOCAL lock_timeout='5s';
-- Summary availability, provenance and shape change together. Independent
-- selectivities estimated one eligible row in a corpus with tens of thousands,
-- making the planner scan every ready paper instead of using text postings.
CREATE STATISTICS IF NOT EXISTS public.papers_daily_readiness_stats (mcv)
ON fulltext_available, summary_basis,
 (summary_source_hash IS NOT NULL), (summarized_at IS NOT NULL),
 (coalesce(summary_model,'')<>''),
 (pg_catalog.array_length(pg_catalog.string_to_array(pg_catalog.btrim(summary_ko),pg_catalog.chr(10)),1)=3),
 summary_review_required, integrity_status
FROM public.papers;
ANALYZE public.papers;
COMMIT;
