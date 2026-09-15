-- Keep administrative counts responsive as the all-time catalog grows.
BEGIN;
CREATE INDEX papers_ready_summary_model ON public.papers(summary_model, summary_basis)
  WHERE summary_source_hash IS NOT NULL AND summarized_at IS NOT NULL;
CREATE INDEX papers_available_fulltext ON public.papers(id) WHERE fulltext_available;

CREATE OR REPLACE FUNCTION public.catalog_backfill_status()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 WITH totals AS MATERIALIZED (
   SELECT (SELECT count(*) FROM public.papers) AS n,
     (SELECT count(*) FROM public.papers
      WHERE summary_model='spark/nvidia/Qwen3.8-27B-NVFP4'
        AND summary_source_hash IS NOT NULL AND summarized_at IS NOT NULL) AS ready
 ), jobs AS MATERIALIZED (
   SELECT coalesce(sum(processed),0) AS examined,
     coalesce(sum(jsonb_array_length(unavailable_pmids)),0) AS unavailable,
     max(updated_at) AS updated FROM public.catalog_backfill_jobs
 )
 SELECT jsonb_build_object(
   'catalog_papers',totals.n,
   'oldest_publication',(SELECT min(pub_date) FROM public.papers),
   'newest_publication',(SELECT max(pub_date) FROM public.papers),
   'qwen_summaries',totals.ready,
   'awaiting_qwen',totals.n-totals.ready,
   'shards',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM
     (SELECT status,count(*) n FROM public.catalog_backfill_jobs GROUP BY status) s),
   'metadata_examined',jobs.examined,'metadata_unavailable',jobs.unavailable,
   'updated_at',jobs.updated) FROM totals CROSS JOIN jobs;
$$;

-- Group each input once instead of scanning all papers once for every day.
-- Calendar days use the same Asia/Seoul boundary as daily recommendations.
CREATE OR REPLACE FUNCTION public.admin_daily_activity()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result json; today date := (now() AT TIME ZONE 'Asia/Seoul')::date;
  since_at timestamptz := (today-29)::timestamp AT TIME ZONE 'Asia/Seoul';
  until_at timestamptz := (today+1)::timestamp AT TIME ZONE 'Asia/Seoul';
BEGIN
  PERFORM app_private.require_admin();
  WITH reads AS (
    SELECT (clicked_at AT TIME ZONE 'Asia/Seoul')::date AS day,
      count(DISTINCT user_id) AS active_users FROM public.read_history
    WHERE clicked_at>=since_at AND clicked_at<until_at GROUP BY 1
  ), votes AS (
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
      count(*) FILTER(WHERE action='like') AS likes,
      count(*) FILTER(WHERE action='dislike') AS dislikes FROM public.feedbacks
    WHERE created_at>=since_at AND created_at<until_at GROUP BY 1
  ), papers AS (
    SELECT (fetched_at AT TIME ZONE 'Asia/Seoul')::date AS day,
      count(*) AS new_papers FROM public.papers
    WHERE fetched_at>=since_at AND fetched_at<until_at GROUP BY 1
  )
  SELECT json_agg(row_to_json(t) ORDER BY t.date) INTO result FROM (
    SELECT today-29+i AS date, coalesce(r.active_users,0) AS active_users,
      coalesce(v.likes,0) AS likes, coalesce(v.dislikes,0) AS dislikes,
      coalesce(p.new_papers,0) AS new_papers
    FROM generate_series(0,29) AS days(i)
    LEFT JOIN reads r ON r.day=today-29+i
    LEFT JOIN votes v ON v.day=today-29+i
    LEFT JOIN papers p ON p.day=today-29+i
  ) t;
  RETURN result;
END;
$$;
-- CREATE OR REPLACE retains the existing service/admin-only grants.
COMMIT;
