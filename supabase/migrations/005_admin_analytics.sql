-- Admin analytics RPC functions (SECURITY DEFINER bypasses RLS)

-- 1. Overall stats
CREATE OR REPLACE FUNCTION admin_stats()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSON;
BEGIN
  SELECT json_build_object(
    'total_users', (SELECT count(*) FROM profiles),
    'active_users_7d', (SELECT count(DISTINCT user_id) FROM read_history WHERE clicked_at > now() - interval '7 days'),
    'total_papers', (SELECT count(*) FROM papers),
    'papers_7d', (SELECT count(*) FROM papers WHERE fetched_at > now() - interval '7 days'),
    'total_feedbacks', (SELECT count(*) FROM feedbacks),
    'total_likes', (SELECT count(*) FROM feedbacks WHERE action = 'like'),
    'total_dislikes', (SELECT count(*) FROM feedbacks WHERE action = 'dislike'),
    'total_reads', (SELECT count(*) FROM read_history),
    'avg_dwell_seconds', (SELECT coalesce(round(avg(dwell_seconds)), 0) FROM read_history WHERE dwell_seconds > 0)
  ) INTO result;
  RETURN result;
END;
$$;

-- 2. Daily activity (last 30 days)
CREATE OR REPLACE FUNCTION admin_daily_activity()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result FROM (
    SELECT d::date as date,
      (SELECT count(DISTINCT user_id) FROM read_history WHERE clicked_at::date = d::date) as active_users,
      (SELECT count(*) FROM feedbacks WHERE created_at::date = d::date AND action = 'like') as likes,
      (SELECT count(*) FROM feedbacks WHERE created_at::date = d::date AND action = 'dislike') as dislikes,
      (SELECT count(*) FROM papers WHERE fetched_at::date = d::date) as new_papers
    FROM generate_series(now() - interval '30 days', now(), interval '1 day') d
  ) t;
  RETURN result;
END;
$$;

-- 3. Top papers (most liked)
CREATE OR REPLACE FUNCTION admin_top_papers(lim int DEFAULT 20)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result FROM (
    SELECT p.title, p.journal, p.pub_date, p.study_type, p.clinical_relevance,
      count(*) as like_count
    FROM feedbacks f
    JOIN papers p ON p.id = f.paper_id
    WHERE f.action = 'like'
    GROUP BY p.id, p.title, p.journal, p.pub_date, p.study_type, p.clinical_relevance
    ORDER BY like_count DESC
    LIMIT lim
  ) t;
  RETURN result;
END;
$$;

-- 4. Popular keywords across all users
CREATE OR REPLACE FUNCTION admin_popular_keywords()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result FROM (
    SELECT unnest(keywords) as keyword, count(*) as user_count
    FROM profiles
    WHERE keywords IS NOT NULL AND array_length(keywords, 1) > 0
    GROUP BY keyword
    ORDER BY user_count DESC
    LIMIT 30
  ) t;
  RETURN result;
END;
$$;

-- 5. Journal distribution (papers per journal)
CREATE OR REPLACE FUNCTION admin_journal_dist()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result FROM (
    SELECT journal, count(*) as paper_count,
      count(*) FILTER (WHERE fetched_at > now() - interval '7 days') as recent_count
    FROM papers
    WHERE journal IS NOT NULL
    GROUP BY journal
    ORDER BY paper_count DESC
    LIMIT 30
  ) t;
  RETURN result;
END;
$$;

-- 6. User engagement summary
CREATE OR REPLACE FUNCTION admin_user_engagement()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result FROM (
    SELECT p.name, p.institution,
      (SELECT count(*) FROM feedbacks WHERE user_id = p.id AND action = 'like') as likes,
      (SELECT count(*) FROM feedbacks WHERE user_id = p.id AND action = 'dislike') as dislikes,
      (SELECT count(*) FROM read_history WHERE user_id = p.id) as reads,
      (SELECT max(clicked_at) FROM read_history WHERE user_id = p.id) as last_active
    FROM profiles p
    ORDER BY last_active DESC NULLS LAST
  ) t;
  RETURN result;
END;
$$;
