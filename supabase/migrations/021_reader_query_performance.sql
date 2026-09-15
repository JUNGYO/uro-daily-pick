BEGIN;
-- Allow PostgreSQL to inline readiness checks and use the existing partial
-- fulltext_available index instead of materializing every catalog row.
CREATE OR REPLACE FUNCTION public.paper_ready(p public.papers) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT p.fulltext_available AND p.summary_basis='fulltext'
 AND p.summary_source_hash IS NOT NULL AND p.summarized_at IS NOT NULL
 AND coalesce(p.summary_model,'')<>''
 AND pg_catalog.array_length(pg_catalog.string_to_array(pg_catalog.btrim(p.summary_ko),pg_catalog.chr(10)),1)=3
$$;
ALTER FUNCTION public.paper_ready(public.papers) RESET search_path;
CREATE INDEX papers_integrity_refresh ON public.papers(integrity_checked_at ASC NULLS FIRST,id)
 WHERE pub_date>='2000-01-01';
COMMIT;
