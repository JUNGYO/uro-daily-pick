-- Distinguish authentication from paper reading in the existing admin-only RPC.
BEGIN;
CREATE OR REPLACE FUNCTION public.admin_user_engagement()
RETURNS JSON LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result JSON;
BEGIN
  PERFORM app_private.require_admin();
  SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) INTO result FROM (
    SELECT p.name, p.institution,
      (SELECT count(*) FROM public.feedbacks WHERE user_id = p.id AND action = 'like') AS likes,
      (SELECT count(*) FROM public.feedbacks WHERE user_id = p.id AND action = 'dislike') AS dislikes,
      history.reads,
      u.last_sign_in_at,
      history.last_read_at,
      -- Preserve the old field for already-open clients; new clients use explicit fields.
      history.last_read_at AS last_active
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    CROSS JOIN LATERAL (
      SELECT count(*) AS reads, max(clicked_at) AS last_read_at
      FROM public.read_history WHERE user_id = p.id
    ) history
    ORDER BY greatest(u.last_sign_in_at, history.last_read_at) DESC NULLS LAST, p.id
  ) t;
  RETURN result;
END;
$$;
-- CREATE OR REPLACE retains the existing administrator check and EXECUTE grants.
COMMIT;
