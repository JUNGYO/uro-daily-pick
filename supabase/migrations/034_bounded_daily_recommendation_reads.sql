-- Resolve stored recommendations before evaluating summary readiness.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.reader_daily(p_day date DEFAULT CURRENT_DATE) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE result jsonb; uid uuid=auth.uid(); today date=(now() AT TIME ZONE 'Asia/Seoul')::date; kw text[]; journals text[]; personalized boolean;
BEGIN
 IF uid IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 IF p_day IS NULL OR p_day>today THEN RAISE EXCEPTION 'Invalid recommendation day' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('daily-picks:'||uid::text,0));
 SELECT keywords,preferred_journals,personalization_enabled INTO kw,journals,personalized FROM public.profiles WHERE id=uid FOR SHARE;
 WITH cached AS MATERIALIZED (
 SELECT r.paper_id,r.score,r.reasons FROM public.recommendations r
 WHERE r.user_id=uid AND r.rec_date=p_day
 ), stored AS MATERIALIZED (
 SELECT doc.p,1000+greatest(0,least(100,r.score)) score,'선호에 맞춰 선정' reason
 FROM cached r CROSS JOIN LATERAL (
  -- Keep the primary-key lookup inside the recommendation loop. OFFSET 0 is
  -- an optimization fence: readiness cannot reorder this into a catalog scan.
  SELECT p FROM public.papers p WHERE p.id=r.paper_id OFFSET 0
 ) doc
 WHERE (doc.p).pub_date>='2000-01-01' AND (doc.p).integrity_status<>'retracted'
 AND NOT (doc.p).summary_review_required AND public.paper_ready(doc.p)
 AND (p_day<today OR NOT EXISTS(SELECT 1 FROM public.recommendations h WHERE h.user_id=uid AND h.paper_id=(doc.p).id AND h.rec_date<p_day))
 AND (p_day<today OR personalized OR r.reasons->'personalization_enabled'='false'::jsonb)
 AND NOT EXISTS(SELECT 1 FROM public.feedbacks f WHERE f.user_id=uid AND f.paper_id=(doc.p).id AND f.action='dislike')
 ), candidates AS (
 SELECT p,(CASE WHEN p.journal=ANY(journals) THEN 4 ELSE 0 END +
 (SELECT count(*)*3 FROM unnest(kw) k WHERE p.search_vector@@plainto_tsquery('english',k)))::double precision score,
 CASE WHEN p.journal=ANY(journals) THEN '선호 저널' ELSE '관심 주제 및 최근 연구' END reason
 FROM public.papers p WHERE p_day=(now() AT TIME ZONE 'Asia/Seoul')::date AND p.pub_date>='2000-01-01'
 AND (SELECT count(*) FROM stored)<5
 AND p.fulltext_available AND p.summary_basis='fulltext' AND p.summary_ko IS NOT NULL
 AND p.summary_source_hash IS NOT NULL AND p.summary_model IS NOT NULL AND p.summarized_at IS NOT NULL
 AND public.paper_ready(p) AND NOT p.summary_review_required AND p.integrity_status<>'retracted'
 AND NOT EXISTS(SELECT 1 FROM public.recommendations h WHERE h.user_id=uid AND h.paper_id=p.id AND h.rec_date<p_day)
 AND p.paper_type NOT IN ('letter','editorial','comment','erratum')
 AND NOT EXISTS(SELECT 1 FROM stored s WHERE (s.p).id=p.id)
 AND NOT EXISTS(SELECT 1 FROM public.feedbacks f WHERE f.user_id=uid AND f.paper_id=p.id AND f.action='dislike')
 AND NOT EXISTS(SELECT 1 FROM public.reader_states s WHERE s.user_id=uid AND s.paper_id=p.id AND s.reading_state='read')
 AND (p.journal=ANY(journals) OR EXISTS(SELECT 1 FROM unnest(kw) k WHERE p.search_vector@@plainto_tsquery('english',k))
 OR EXISTS(SELECT 1 FROM public.alerts a WHERE a.user_id=uid AND a.is_active AND app_private.reader_alert_match(p,a.alert_type,a.value)))
 ORDER BY (p.pub_date>=current_date-interval '5 years') DESC,score DESC,p.pub_date DESC,p.id DESC LIMIT 20
 ), selected AS (SELECT * FROM stored UNION ALL SELECT * FROM candidates), bounded AS (
 SELECT * FROM selected ORDER BY score DESC,(p).pub_date DESC LIMIT 5)
 SELECT coalesce(jsonb_agg(public.reader_card(p)||jsonb_build_object('reason',reason,'read',EXISTS(
 SELECT 1 FROM public.reader_states s WHERE s.user_id=uid AND s.paper_id=(p).id AND s.reading_state='read'))),'[]') INTO result FROM bounded;
 -- Persist fallback cards before returning them, including unopened cards.
 -- Past-date browsing never creates or rewrites recommendation history.
 IF p_day=today THEN
  INSERT INTO public.recommendations(user_id,paper_id,score,reasons,rec_date)
  SELECT uid,(card->>'id')::bigint,0,'{"personalization_enabled":false,"reasons":[]}'::jsonb,p_day
  FROM jsonb_array_elements(result) card
  ON CONFLICT(user_id,rec_date,paper_id) DO NOTHING;
 END IF;
 RETURN result;
END;
$$;

NOTIFY pgrst,'reload schema';
COMMIT;
