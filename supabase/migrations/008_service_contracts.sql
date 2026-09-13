BEGIN;

-- New accounts opt in during onboarding; existing preferences are preserved.
ALTER TABLE public.profiles ALTER COLUMN email_digest SET DEFAULT false;

-- A stable identifier prevents concurrent clicks from creating duplicate system collections.
ALTER TABLE public.collections ADD COLUMN system_key text CHECK (system_key IN ('liked', 'saved'));
CREATE UNIQUE INDEX collections_system_key ON public.collections(user_id, system_key);
UPDATE public.collections c SET system_key = 'liked'
WHERE c.name = 'Liked Papers' AND c.id = (
  SELECT min(x.id) FROM public.collections x WHERE x.user_id = c.user_id AND x.name = 'Liked Papers'
);

CREATE FUNCTION public.set_paper_feedback(p_paper_id bigint, p_action text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid(); cid bigint; skey text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('like', 'dislike', 'save', 'none') THEN
    RAISE EXCEPTION 'Invalid feedback action' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));
  PERFORM public.upsert_feedback(uid, p_paper_id, p_action);
  DELETE FROM public.collection_papers cp USING public.collections c
    WHERE cp.collection_id = c.id AND c.user_id = uid AND c.system_key IS NOT NULL
      AND cp.paper_id = p_paper_id;
  IF p_action IN ('like', 'save') THEN
    skey := CASE p_action WHEN 'like' THEN 'liked' ELSE 'saved' END;
    INSERT INTO public.collections (user_id, name, system_key)
      VALUES (uid, CASE skey WHEN 'liked' THEN 'Liked Papers' ELSE 'Saved Papers' END, skey)
      ON CONFLICT (user_id, system_key) DO UPDATE SET system_key = EXCLUDED.system_key
      RETURNING id INTO cid;
    INSERT INTO public.collection_papers (collection_id, paper_id) VALUES (cid, p_paper_id)
      ON CONFLICT DO NOTHING;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_paper_feedback(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_paper_feedback(bigint, text) TO authenticated;

CREATE FUNCTION public.delete_own_account() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  DELETE FROM auth.users WHERE id = auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public.delete_own_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_own_account() TO authenticated;

-- Replacing a day's recommendations either succeeds completely or leaves the old set intact.
DELETE FROM public.recommendations a USING public.recommendations b
WHERE a.user_id = b.user_id AND a.rec_date = b.rec_date AND a.paper_id = b.paper_id AND a.id > b.id;
CREATE UNIQUE INDEX recommendations_unique_pick ON public.recommendations(user_id, rec_date, paper_id);
CREATE FUNCTION public.replace_daily_recommendations(p_user_id uuid, p_date date, p_recs jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_recs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_recs) > 5 THEN
    RAISE EXCEPTION 'Expected up to five recommendations' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || p_date::text, 0));
  DELETE FROM public.recommendations WHERE user_id = p_user_id AND rec_date = p_date;
  INSERT INTO public.recommendations(user_id, paper_id, score, reasons, rec_date)
    SELECT p_user_id, r.paper_id, r.score, r.reasons, p_date
    FROM jsonb_to_recordset(p_recs) AS r(paper_id bigint, score real, reasons jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.replace_daily_recommendations(uuid, date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_daily_recommendations(uuid, date, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.profiles(id, name) VALUES (NEW.id, left(COALESCE(NEW.raw_user_meta_data->>'name', ''), 100));
  RETURN NEW;
END;
$$;

ALTER TABLE public.papers ADD COLUMN summary_basis text CHECK (summary_basis IN ('abstract', 'fulltext'));
ALTER TABLE public.papers ADD COLUMN summary_model text;
ALTER TABLE public.papers ADD COLUMN summarized_at timestamptz;
ALTER TABLE public.papers ADD COLUMN summary_source_hash text;
ALTER TABLE public.papers ADD COLUMN fulltext_available boolean NOT NULL DEFAULT false;

-- Repair historic double-encoded JSON without interpreting invalid text as valid content.
CREATE FUNCTION app_private.normalize_json(value jsonb, expected text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(value) = 'string' THEN
    BEGIN value := (value #>> '{}')::jsonb; EXCEPTION WHEN invalid_text_representation THEN value := NULL; END;
  END IF;
  IF jsonb_typeof(value) IS DISTINCT FROM expected THEN
    RETURN CASE expected WHEN 'array' THEN '[]'::jsonb ELSE '{}'::jsonb END;
  END IF;
  RETURN value;
END;
$$;
UPDATE public.papers SET authors = app_private.normalize_json(authors, 'array'),
  keywords = app_private.normalize_json(keywords, 'array'), mesh_terms = app_private.normalize_json(mesh_terms, 'array'),
  pub_types = app_private.normalize_json(pub_types, 'array'),
  structured_data = app_private.normalize_json(structured_data, 'object'), qa_data = app_private.normalize_json(qa_data, 'array');
UPDATE public.recommendations SET reasons = app_private.normalize_json(reasons, 'object');
DROP FUNCTION app_private.normalize_json(jsonb, text);

-- Payloads contain personal data. No browser role may read or write these tables.
CREATE TABLE public.email_deliveries (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delivery_date date NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
  provider_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY(user_id, delivery_date)
);
ALTER TABLE public.email_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.email_deliveries TO service_role;

CREATE TABLE public.paper_fulltexts (
  paper_id bigint PRIMARY KEY REFERENCES public.papers(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ready', 'failed')),
  source text NOT NULL,
  source_url text,
  license text,
  content_hash text,
  content_text text,
  sections jsonb NOT NULL DEFAULT '[]',
  error text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'ready' OR (content_text IS NOT NULL AND length(content_text) BETWEEN 500 AND 600000
    AND content_hash IS NOT NULL AND content_hash ~ '^[0-9a-f]{64}$'))
);
ALTER TABLE public.paper_fulltexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paper_fulltexts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.paper_fulltexts TO service_role;

COMMIT;
