-- Add the reviewed 65-journal scope without resetting prior checkpoints.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.catalog_backfill_jobs
 ADD COLUMN journal_id text,
 ADD COLUMN query_version text,
 ADD COLUMN registry_version text,
 ADD COLUMN priority smallint NOT NULL DEFAULT 20;
CREATE INDEX catalog_backfill_registry_queue ON public.catalog_backfill_jobs
 (registry_version,start_date,priority,status,lower_uid DESC,updated_at);
CREATE TABLE app_private.catalog_registry_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 registry_version text NOT NULL,
 target_journals integer NOT NULL CHECK(target_journals>0),
 urology_journals integer NOT NULL CHECK(urology_journals>0),
 ancillary_journals integer NOT NULL CHECK(ancillary_journals>=0),
 CHECK(target_journals=urology_journals+ancillary_journals)
);
ALTER TABLE app_private.catalog_registry_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.catalog_registry_state FROM PUBLIC,anon,authenticated;
INSERT INTO app_private.catalog_registry_state VALUES
 (true,'2026-09-17.urology-centered-65.v1',65,51,14);
CREATE OR REPLACE FUNCTION public.catalog_backfill_status()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 WITH active_jobs AS MATERIALIZED (
   SELECT j.* FROM public.catalog_backfill_jobs j
   JOIN app_private.catalog_registry_state r ON r.registry_version=j.registry_version
   WHERE r.singleton AND j.start_date=DATE '2000-01-01'
 ), totals AS MATERIALIZED (
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
     max(updated_at) AS updated FROM active_jobs
 )
 SELECT jsonb_build_object(
   'automatic_start_date','2000-01-01','recent_years',5,
   'scope',(SELECT jsonb_build_object('registry_version',r.registry_version,
     'target_journals',r.target_journals,'urology_journals',r.urology_journals,
     'ancillary_journals',r.ancillary_journals) FROM app_private.catalog_registry_state r WHERE r.singleton),
   'catalog_papers',totals.n,'automatic_papers',totals.eligible,
   'archived_papers',totals.archived,'undated_papers',totals.undated,
   'oldest_publication',totals.oldest,'newest_publication',totals.newest,
   'qwen_summaries',ready.n,'awaiting_qwen',totals.eligible-ready.n,
   'originals_acquired',stages.originals,'summaries_ready',stages.summaries,
   'shards',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM
     (SELECT status,count(*) n FROM active_jobs GROUP BY status) s),
   'metadata_examined',jobs.examined,'metadata_unavailable',jobs.unavailable,
   'updated_at',jobs.updated) FROM totals CROSS JOIN ready CROSS JOIN jobs CROSS JOIN stages;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
