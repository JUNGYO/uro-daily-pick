-- Apply after 005. Keep administrator authorization in the database.
BEGIN;
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.require_admin()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = auth.uid()
      AND lower(email) = 'crazyslime@gmail.com'
      AND email_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Administrator access required' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app_private.require_admin() FROM PUBLIC, anon, authenticated;

-- Admin analytics RPC functions (SECURITY DEFINER bypasses RLS)

-- 1. Overall stats
CREATE OR REPLACE FUNCTION public.admin_stats()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result JSON;
BEGIN
  PERFORM app_private.require_admin();
  SELECT json_build_object(
    'total_users', (SELECT count(*) FROM public.profiles),
    'active_users_7d', (SELECT count(DISTINCT user_id) FROM public.read_history WHERE clicked_at > now() - interval '7 days'),
    'total_papers', (SELECT count(*) FROM public.papers),
    'papers_7d', (SELECT count(*) FROM public.papers WHERE fetched_at > now() - interval '7 days'),
    'total_feedbacks', (SELECT count(*) FROM public.feedbacks),
    'total_likes', (SELECT count(*) FROM public.feedbacks WHERE action = 'like'),
    'total_dislikes', (SELECT count(*) FROM public.feedbacks WHERE action = 'dislike'),
    'total_reads', (SELECT count(*) FROM public.read_history),
    'avg_dwell_seconds', (SELECT coalesce(round(avg(dwell_seconds)), 0) FROM public.read_history WHERE dwell_seconds > 0)
  ) INTO result;
  RETURN result;
END;
$$;

-- 2. Daily activity (last 30 days)
CREATE OR REPLACE FUNCTION public.admin_daily_activity()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result JSON;
BEGIN
  PERFORM app_private.require_admin();
  SELECT json_agg(row_to_json(t)) INTO result FROM (
    SELECT d::date as date,
      (SELECT count(DISTINCT user_id) FROM public.read_history WHERE clicked_at::date = d::date) as active_users,
      (SELECT count(*) FROM public.feedbacks WHERE created_at::date = d::date AND action = 'like') as likes,
      (SELECT count(*) FROM public.feedbacks WHERE created_at::date = d::date AND action = 'dislike') as dislikes,
      (SELECT count(*) FROM public.papers WHERE fetched_at::date = d::date) as new_papers
    FROM generate_series(now() - interval '30 days', now(), interval '1 day') d
  ) t;
  RETURN result;
END;
$$;

-- 3. Top papers (most liked)
CREATE OR REPLACE FUNCTION public.admin_top_papers(lim int DEFAULT 20)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result JSON;
BEGIN
  PERFORM app_private.require_admin();
  SELECT json_agg(row_to_json(t)) INTO result FROM (
    SELECT p.title, p.journal, p.pub_date, p.study_type, p.clinical_relevance,
      count(*) as like_count
    FROM public.feedbacks f
    JOIN public.papers p ON p.id = f.paper_id
    WHERE f.action = 'like'
    GROUP BY p.id, p.title, p.journal, p.pub_date, p.study_type, p.clinical_relevance
    ORDER BY like_count DESC
    LIMIT lim
  ) t;
  RETURN result;
END;
$$;

-- 4. Popular keywords across all users
CREATE OR REPLACE FUNCTION public.admin_popular_keywords()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result JSON;
BEGIN
  PERFORM app_private.require_admin();
  SELECT json_agg(row_to_json(t)) INTO result FROM (
    SELECT unnest(keywords) as keyword, count(*) as user_count
    FROM public.profiles
    WHERE keywords IS NOT NULL AND array_length(keywords, 1) > 0
    GROUP BY keyword
    ORDER BY user_count DESC
    LIMIT 30
  ) t;
  RETURN result;
END;
$$;

-- 5. Journal distribution (papers per journal)
CREATE OR REPLACE FUNCTION public.admin_journal_dist()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result JSON;
BEGIN
  PERFORM app_private.require_admin();
  SELECT json_agg(row_to_json(t)) INTO result FROM (
    SELECT journal, count(*) as paper_count,
      count(*) FILTER (WHERE fetched_at > now() - interval '7 days') as recent_count
    FROM public.papers
    WHERE journal IS NOT NULL
    GROUP BY journal
    ORDER BY paper_count DESC
    LIMIT 30
  ) t;
  RETURN result;
END;
$$;

-- 6. User engagement summary
CREATE OR REPLACE FUNCTION public.admin_user_engagement()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result JSON;
BEGIN
  PERFORM app_private.require_admin();
  SELECT json_agg(row_to_json(t)) INTO result FROM (
    SELECT p.name, p.institution,
      (SELECT count(*) FROM public.feedbacks WHERE user_id = p.id AND action = 'like') as likes,
      (SELECT count(*) FROM public.feedbacks WHERE user_id = p.id AND action = 'dislike') as dislikes,
      (SELECT count(*) FROM public.read_history WHERE user_id = p.id) as reads,
      (SELECT max(clicked_at) FROM public.read_history WHERE user_id = p.id) as last_active
    FROM public.profiles p
    ORDER BY last_active DESC NULLS LAST
  ) t;
  RETURN result;
END;
$$;

-- Undo removes a feedback row; do not store the UI sentinel "none".
-- SECURITY INVOKER keeps the existing per-user RLS policies in effect.
CREATE OR REPLACE FUNCTION public.upsert_feedback(
  p_user_id UUID, p_paper_id BIGINT, p_action TEXT
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Own feedback only' USING ERRCODE = '42501';
  END IF;
  IF p_action = 'none' THEN
    DELETE FROM public.feedbacks WHERE user_id = auth.uid() AND paper_id = p_paper_id;
  ELSIF p_action IN ('like', 'dislike', 'save') THEN
    INSERT INTO public.feedbacks (user_id, paper_id, action)
    VALUES (auth.uid(), p_paper_id, p_action)
    ON CONFLICT (user_id, paper_id)
    DO UPDATE SET action = EXCLUDED.action, created_at = now();
  ELSE
    RAISE EXCEPTION 'Invalid feedback action' USING ERRCODE = '22023';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_feedback(UUID, BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_feedback(UUID, BIGINT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_stats() TO authenticated;

REVOKE ALL ON FUNCTION public.admin_daily_activity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_daily_activity() TO authenticated;

REVOKE ALL ON FUNCTION public.admin_top_papers(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_top_papers(integer) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_popular_keywords() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_popular_keywords() TO authenticated;

REVOKE ALL ON FUNCTION public.admin_journal_dist() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_journal_dist() TO authenticated;

REVOKE ALL ON FUNCTION public.admin_user_engagement() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_user_engagement() TO authenticated;

COMMIT;
