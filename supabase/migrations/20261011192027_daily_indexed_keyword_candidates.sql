-- Resolve stored recommendations before evaluating summary readiness.
BEGIN;
SET LOCAL lock_timeout='5s';
-- Limit text-search postings to eligible full-text summaries.
CREATE INDEX IF NOT EXISTS papers_daily_ready_search ON public.papers USING gin(search_vector)
WHERE fulltext_available AND summary_basis='fulltext'
 AND summary_source_hash IS NOT NULL AND summarized_at IS NOT NULL
 AND coalesce(summary_model,'')<>''
 AND pg_catalog.array_length(pg_catalog.string_to_array(pg_catalog.btrim(summary_ko),pg_catalog.chr(10)),1)=3
 AND pub_date>='2000-01-01' AND integrity_status<>'retracted'
 AND NOT summary_review_required AND paper_type NOT IN ('letter','editorial','comment','erratum');

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
 SELECT doc.p,1000+greatest(0,least(100,r.score)) score,U&'\C120\D638\C5D0 \B9DE\CDB0 \C120\C815' reason
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
 ), keyword_queries AS MATERIALIZED (
 SELECT plainto_tsquery('english',k) query FROM unnest(kw) k
 ), matching AS MATERIALIZED (
 -- Each keyword lookup can use the partial full-text index. Keep duplicate
 -- keywords for the existing count-based score, but only one journal bonus.
 SELECT hit.id,3::bigint score FROM keyword_queries k
 CROSS JOIN LATERAL (
 SELECT p.id FROM public.papers p WHERE p.fulltext_available AND p.summary_basis='fulltext'
 AND p.summary_source_hash IS NOT NULL AND p.summarized_at IS NOT NULL
 AND coalesce(p.summary_model,'')<>''
 AND pg_catalog.array_length(pg_catalog.string_to_array(pg_catalog.btrim(p.summary_ko),pg_catalog.chr(10)),1)=3
 AND p.pub_date>='2000-01-01' AND p.integrity_status<>'retracted'
 AND NOT p.summary_review_required AND p.paper_type NOT IN ('letter','editorial','comment','erratum')
 AND p.search_vector@@k.query OFFSET 0
 ) hit WHERE p_day=today AND (SELECT count(*) FROM stored)<5
 UNION ALL
 SELECT hit.id,4::bigint FROM (SELECT DISTINCT j FROM unnest(journals) j) j
 CROSS JOIN LATERAL (
 SELECT p.id FROM public.papers p WHERE p.fulltext_available AND p.summary_basis='fulltext'
 AND p.summary_source_hash IS NOT NULL AND p.summarized_at IS NOT NULL
 AND coalesce(p.summary_model,'')<>''
 AND pg_catalog.array_length(pg_catalog.string_to_array(pg_catalog.btrim(p.summary_ko),pg_catalog.chr(10)),1)=3
 AND p.pub_date>='2000-01-01' AND p.integrity_status<>'retracted'
 AND NOT p.summary_review_required AND p.paper_type NOT IN ('letter','editorial','comment','erratum')
 AND p.journal=j.j OFFSET 0
 ) hit WHERE p_day=today AND (SELECT count(*) FROM stored)<5
 UNION ALL
 SELECT hit.id,0::bigint FROM (
 SELECT a.alert_type,a.value FROM public.alerts a
 WHERE a.user_id=uid AND a.is_active OFFSET 0
 ) a CROSS JOIN LATERAL (
 SELECT p.id FROM public.papers p WHERE p.fulltext_available AND p.summary_basis='fulltext'
 AND p.summary_source_hash IS NOT NULL AND p.summarized_at IS NOT NULL
 AND coalesce(p.summary_model,'')<>''
 AND pg_catalog.array_length(pg_catalog.string_to_array(pg_catalog.btrim(p.summary_ko),pg_catalog.chr(10)),1)=3
 AND p.pub_date>='2000-01-01' AND p.integrity_status<>'retracted'
 AND NOT p.summary_review_required AND p.paper_type NOT IN ('letter','editorial','comment','erratum')
 AND CASE a.alert_type
 WHEN 'journal' THEN position(lower(a.value) IN lower(p.journal))>0
 WHEN 'author' THEN to_tsvector('simple',p.authors::text)@@plainto_tsquery('simple',a.value)
 WHEN 'keyword' THEN p.search_vector@@plainto_tsquery('english',a.value)
 ELSE false END OFFSET 0
 ) hit WHERE p_day=today AND (SELECT count(*) FROM stored)<5
 ), scores AS MATERIALIZED (
 SELECT id,sum(score)::double precision score FROM matching GROUP BY id
 ), candidate_ids AS MATERIALIZED (
 SELECT p.id,s.score,
 CASE WHEN p.journal=ANY(journals) THEN U&'\C120\D638 \C800\B110'
 ELSE U&'\AD00\C2EC \C8FC\C81C \BC0F \CD5C\ADFC \C5F0\AD6C' END reason
 FROM scores s JOIN public.papers p ON p.id=s.id
 WHERE NOT EXISTS(SELECT 1 FROM public.recommendations h WHERE h.user_id=uid AND h.paper_id=p.id AND h.rec_date<p_day)
 AND NOT EXISTS(SELECT 1 FROM stored s WHERE (s.p).id=p.id)
 AND NOT EXISTS(SELECT 1 FROM public.feedbacks f WHERE f.user_id=uid AND f.paper_id=p.id AND f.action='dislike')
 AND NOT EXISTS(SELECT 1 FROM public.reader_states s WHERE s.user_id=uid AND s.paper_id=p.id AND s.reading_state='read')
 ORDER BY (p.pub_date>=current_date-interval '5 years') DESC,s.score DESC,p.pub_date DESC,p.id DESC LIMIT 20
 ), candidates AS (
 SELECT doc.p,c.score,c.reason FROM candidate_ids c CROSS JOIN LATERAL (
 SELECT p FROM public.papers p WHERE p.id=c.id OFFSET 0
 ) doc ), selected AS (SELECT * FROM stored UNION ALL SELECT * FROM candidates), bounded AS (
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
