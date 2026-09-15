-- Scope new automatic work without deleting historical papers or checkpoints.
BEGIN;
ALTER TABLE public.catalog_backfill_jobs ADD COLUMN start_date date;
CREATE INDEX catalog_backfill_scope ON public.catalog_backfill_jobs(start_date,status,lower_uid DESC);

CREATE OR REPLACE FUNCTION public.catalog_backfill_status()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 WITH totals AS MATERIALIZED (
   SELECT count(*) AS n,
     count(*) FILTER(WHERE pub_date >= DATE '2000-01-01') AS eligible,
     count(*) FILTER(WHERE pub_date < DATE '2000-01-01') AS archived,
     count(*) FILTER(WHERE pub_date IS NULL) AS undated,
     min(pub_date) AS oldest, max(pub_date) AS newest
   FROM public.papers
 ), stages AS MATERIALIZED (
   SELECT count(*) AS originals,
     count(*) FILTER(WHERE p.fulltext_available AND p.summary_basis='fulltext'
       AND p.summary_source_hash=s.summary_source_hash AND p.summarized_at IS NOT NULL
       AND p.summary_model IS NOT NULL AND p.summary_ko IS NOT NULL) AS summaries
   FROM app_private.local_fulltext_sources s JOIN public.papers p ON p.id=s.paper_id
   WHERE p.pub_date >= DATE '2000-01-01'
 ), ready AS MATERIALIZED (
   SELECT count(*) AS n FROM public.papers
   WHERE pub_date >= DATE '2000-01-01'
     AND summary_model='spark/nvidia/Qwen3.8-27B-NVFP4'
     AND summary_source_hash IS NOT NULL AND summarized_at IS NOT NULL
 ), jobs AS MATERIALIZED (
   SELECT coalesce(sum(processed),0) AS examined,
     coalesce(sum(jsonb_array_length(unavailable_pmids)),0) AS unavailable,
     max(updated_at) AS updated FROM public.catalog_backfill_jobs
   WHERE start_date=DATE '2000-01-01'
 )
 SELECT jsonb_build_object(
   'automatic_start_date','2000-01-01','recent_years',5,
   'catalog_papers',totals.n,'automatic_papers',totals.eligible,
   'archived_papers',totals.archived,'undated_papers',totals.undated,
   'oldest_publication',totals.oldest,'newest_publication',totals.newest,
   'qwen_summaries',ready.n,'awaiting_qwen',totals.eligible-ready.n,
   'originals_acquired',stages.originals,'summaries_ready',stages.summaries,
   'shards',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM
     (SELECT status,count(*) n FROM public.catalog_backfill_jobs
      WHERE start_date=DATE '2000-01-01' GROUP BY status) s),
   'metadata_examined',jobs.examined,'metadata_unavailable',jobs.unavailable,
   'updated_at',jobs.updated) FROM totals CROSS JOIN ready CROSS JOIN jobs CROSS JOIN stages;
$$;
-- CREATE OR REPLACE preserves the existing service/admin-only grants.
COMMIT;
