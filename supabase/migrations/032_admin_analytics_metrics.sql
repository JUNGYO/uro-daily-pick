-- Read catalog analytics from the compact ledger, never the full paper payloads.
-- Initialization is explicit: partial ledger counts must not look like zero or a total.
BEGIN;

CREATE OR REPLACE FUNCTION public.admin_stats()
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  result json;
  metrics_ready boolean;
  paper_count bigint;
  recent_paper_count bigint;
BEGIN
  PERFORM app_private.require_admin();
  SELECT coalesce((SELECT complete FROM app_private.admin_catalog_metrics_state WHERE singleton),false)
    INTO metrics_ready;
  IF metrics_ready THEN
    SELECT count(*),count(*) FILTER(WHERE fetched_at>now()-interval '7 days')
      INTO paper_count,recent_paper_count FROM app_private.admin_catalog_metrics;
  END IF;
  SELECT json_build_object(
    'total_users',(SELECT count(*) FROM public.profiles),
    'active_users_7d',(SELECT count(DISTINCT user_id) FROM public.read_history WHERE clicked_at>now()-interval '7 days'),
    'total_papers',paper_count,
    'papers_7d',recent_paper_count,
    'total_feedbacks',(SELECT count(*) FROM public.feedbacks),
    'total_likes',(SELECT count(*) FROM public.feedbacks WHERE action='like'),
    'total_dislikes',(SELECT count(*) FROM public.feedbacks WHERE action='dislike'),
    'total_reads',(SELECT count(*) FROM public.read_history),
    'avg_dwell_seconds',(SELECT coalesce(round(avg(dwell_seconds)),0) FROM public.read_history WHERE dwell_seconds>0)
  ) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_daily_activity()
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  result json;
  metrics_ready boolean;
  today date := (now() AT TIME ZONE 'Asia/Seoul')::date;
  since_at timestamptz := (today-29)::timestamp AT TIME ZONE 'Asia/Seoul';
  until_at timestamptz := (today+1)::timestamp AT TIME ZONE 'Asia/Seoul';
BEGIN
  PERFORM app_private.require_admin();
  SELECT coalesce((SELECT complete FROM app_private.admin_catalog_metrics_state WHERE singleton),false)
    INTO metrics_ready;
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
      count(*) AS new_papers FROM app_private.admin_catalog_metrics
    WHERE metrics_ready AND fetched_at>=since_at AND fetched_at<until_at GROUP BY 1
  )
  SELECT json_agg(row_to_json(t) ORDER BY t.date) INTO result FROM (
    SELECT today-29+i AS date,coalesce(r.active_users,0) AS active_users,
      coalesce(v.likes,0) AS likes,coalesce(v.dislikes,0) AS dislikes,
      CASE WHEN metrics_ready THEN coalesce(p.new_papers,0) ELSE NULL::bigint END AS new_papers
    FROM generate_series(0,29) AS days(i)
    LEFT JOIN reads r ON r.day=today-29+i
    LEFT JOIN votes v ON v.day=today-29+i
    LEFT JOIN papers p ON p.day=today-29+i
  ) t;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_journal_dist()
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result json;
BEGIN
  PERFORM app_private.require_admin();
  IF NOT coalesce((SELECT complete FROM app_private.admin_catalog_metrics_state WHERE singleton),false) THEN
    RETURN NULL;
  END IF;
  SELECT json_agg(row_to_json(t)) INTO result FROM (
    SELECT journal,count(*) AS paper_count,
      count(*) FILTER(WHERE fetched_at>now()-interval '7 days') AS recent_count
    FROM app_private.admin_catalog_metrics
    WHERE journal IS NOT NULL
    GROUP BY journal
    ORDER BY paper_count DESC
    LIMIT 30
  ) t;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_stats() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_stats() TO authenticated;
REVOKE ALL ON FUNCTION public.admin_daily_activity() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_daily_activity() TO authenticated;
REVOKE ALL ON FUNCTION public.admin_journal_dist() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_journal_dist() TO authenticated;

COMMIT;
