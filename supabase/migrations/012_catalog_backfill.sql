BEGIN;
CREATE TABLE public.catalog_backfill_jobs (
  job_key text PRIMARY KEY CHECK(job_key ~ '^[0-9a-f]{64}$'),
  query text NOT NULL CHECK(length(query) BETWEEN 1 AND 3000),
  lower_uid bigint NOT NULL DEFAULT 1 CHECK(lower_uid>0),
  upper_uid bigint CHECK(upper_uid>=lower_uid),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','split','done','error')),
  source_count bigint,
  pmids jsonb CHECK(pmids IS NULL OR jsonb_typeof(pmids)='array'),
  processed integer NOT NULL DEFAULT 0 CHECK(processed>=0),
  unavailable_pmids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(unavailable_pmids)='array'),
  error_code text,
  retry_after timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.catalog_backfill_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_backfill_jobs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.catalog_backfill_jobs TO service_role;
CREATE INDEX catalog_backfill_pending ON public.catalog_backfill_jobs(status,lower_uid DESC,updated_at);
CREATE INDEX papers_pending_qwen ON public.papers(pub_date DESC,id) WHERE summary_model IS DISTINCT FROM 'spark/nvidia/Qwen3.8-27B-NVFP4';

CREATE FUNCTION public.catalog_backfill_status()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object(
  'catalog_papers',(SELECT count(*) FROM public.papers),
  'oldest_publication',(SELECT min(pub_date) FROM public.papers),
  'newest_publication',(SELECT max(pub_date) FROM public.papers),
  'qwen_summaries',(SELECT count(*) FROM public.papers WHERE summary_model='spark/nvidia/Qwen3.8-27B-NVFP4' AND summary_source_hash IS NOT NULL AND summarized_at IS NOT NULL),
  'awaiting_qwen',(SELECT count(*) FROM public.papers WHERE summary_model IS DISTINCT FROM 'spark/nvidia/Qwen3.8-27B-NVFP4' OR summary_source_hash IS NULL OR summarized_at IS NULL),
  'shards',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM (SELECT status,count(*) n FROM public.catalog_backfill_jobs GROUP BY status) s),
  'metadata_examined',(SELECT coalesce(sum(processed),0) FROM public.catalog_backfill_jobs),
  'metadata_unavailable',(SELECT coalesce(sum(jsonb_array_length(unavailable_pmids)),0) FROM public.catalog_backfill_jobs),
  'updated_at',(SELECT max(updated_at) FROM public.catalog_backfill_jobs));
$$;
REVOKE ALL ON FUNCTION public.catalog_backfill_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.catalog_backfill_status() TO service_role;

CREATE FUNCTION public.admin_catalog_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM app_private.require_admin();
 RETURN public.catalog_backfill_status();
END;
$$;
REVOKE ALL ON FUNCTION public.admin_catalog_status() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_catalog_status() TO authenticated;
COMMIT;
