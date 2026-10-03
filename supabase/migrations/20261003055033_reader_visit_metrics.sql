-- Only the latest observed visit is kept; historical visits are never inferred.
BEGIN;
CREATE TABLE app_private.reader_visits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_private.reader_visits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.reader_visits FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.record_reader_visit()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := auth.uid();
BEGIN
  IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = actor) THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app_private.reader_visits(user_id, last_seen_at) VALUES(actor, now())
  ON CONFLICT(user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
  WHERE reader_visits.last_seen_at < EXCLUDED.last_seen_at - interval '1 minute';
END;
$$;
REVOKE ALL ON FUNCTION public.record_reader_visit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_reader_visit() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_user_engagement()
RETURNS JSON LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result JSON;
BEGIN
  PERFORM app_private.require_admin();
  SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) INTO result FROM (
    SELECT p.name, p.institution,
      (SELECT count(*) FROM public.feedbacks WHERE user_id = p.id AND action = 'like') AS likes,
      (SELECT count(*) FROM public.feedbacks WHERE user_id = p.id AND action = 'dislike') AS dislikes,
      history.reads, history.read_papers,
      visits.last_seen_at, u.last_sign_in_at, history.last_read_at,
      history.last_read_at AS last_active
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    LEFT JOIN app_private.reader_visits visits ON visits.user_id = p.id
    CROSS JOIN LATERAL (
      SELECT count(*) AS reads, count(DISTINCT paper_id) AS read_papers,
        max(clicked_at) AS last_read_at
      FROM public.read_history WHERE user_id = p.id
    ) history
    ORDER BY greatest(visits.last_seen_at, u.last_sign_in_at, history.last_read_at) DESC NULLS LAST, p.id
  ) t;
  RETURN result;
END;
$$;
COMMIT;
