-- Explicit opening actions are separate from legacy dwell-time observations.
BEGIN;
CREATE TABLE app_private.reader_open_events (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  paper_id bigint NOT NULL REFERENCES public.papers(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('detail', 'original', 'publisher')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX reader_open_events_user_time ON app_private.reader_open_events(user_id, opened_at DESC);
CREATE INDEX reader_open_events_paper ON app_private.reader_open_events(paper_id);
ALTER TABLE app_private.reader_open_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.reader_open_events FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.record_reader_open(p_pmid text, p_kind text, p_event_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := auth.uid(); target_paper bigint;
BEGIN
  IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = actor) THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('detail','original','publisher')
      OR p_pmid IS NULL OR p_pmid !~ '^[0-9]{1,10}$' THEN
    RAISE EXCEPTION 'Invalid opening event' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO target_paper FROM public.papers WHERE pmid = p_pmid;
  IF target_paper IS NULL THEN
    RAISE EXCEPTION 'Paper unavailable' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app_private.reader_open_events(user_id,event_id,paper_id,kind)
    VALUES(actor,p_event_id,target_paper,p_kind)
    ON CONFLICT(user_id,event_id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM app_private.reader_open_events
      WHERE user_id=actor AND event_id=p_event_id AND paper_id=target_paper AND kind=p_kind) THEN
    RAISE EXCEPTION 'Opening event does not match' USING ERRCODE = '22023';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.record_reader_open(text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_reader_open(text,text,uuid) TO authenticated;

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
      history.last_read_at AS last_active,
      openings.open_clicks, openings.opened_papers, openings.last_opened_at,
      openings.detail_clicks, openings.original_clicks, openings.publisher_clicks
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    LEFT JOIN app_private.reader_visits visits ON visits.user_id = p.id
    CROSS JOIN LATERAL (
      SELECT count(*) AS reads, count(DISTINCT paper_id) AS read_papers,
        max(clicked_at) AS last_read_at
      FROM public.read_history WHERE user_id = p.id
    ) history
    CROSS JOIN LATERAL (
      SELECT count(*) AS open_clicks, count(DISTINCT paper_id) AS opened_papers,
        max(opened_at) AS last_opened_at,
        count(*) FILTER(WHERE kind='detail') AS detail_clicks,
        count(*) FILTER(WHERE kind='original') AS original_clicks,
        count(*) FILTER(WHERE kind='publisher') AS publisher_clicks
      FROM app_private.reader_open_events WHERE user_id = p.id
    ) openings
    ORDER BY greatest(visits.last_seen_at, u.last_sign_in_at, openings.last_opened_at) DESC NULLS LAST, p.id
  ) t;
  RETURN result;
END;
$$;
COMMIT;
