BEGIN;

-- Transition times describe explicit reader actions. Historical timestamps are
-- unknown; an unrelated note edit must never become a reading completion date.
ALTER TABLE public.reader_states ADD COLUMN read_at timestamptz;
ALTER TABLE public.reader_states ADD COLUMN saved_at timestamptz;
CREATE FUNCTION app_private.stamp_reader_transitions() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.read_at=CASE WHEN NEW.reading_state='read' THEN clock_timestamp() END;
  NEW.saved_at=CASE WHEN NEW.saved THEN clock_timestamp() END;
 ELSE
  NEW.read_at=CASE WHEN NEW.reading_state<>'read' THEN NULL
   WHEN OLD.reading_state<>'read' THEN clock_timestamp() ELSE OLD.read_at END;
  NEW.saved_at=CASE WHEN NOT NEW.saved THEN NULL
   WHEN NOT OLD.saved THEN clock_timestamp() ELSE OLD.saved_at END;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.stamp_reader_transitions() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER stamp_reader_transitions BEFORE INSERT OR UPDATE ON public.reader_states
 FOR EACH ROW EXECUTE FUNCTION app_private.stamp_reader_transitions();

ALTER TABLE public.profiles ADD COLUMN personalization_enabled boolean NOT NULL DEFAULT true;
-- Cached rankings must stop influencing the reader immediately after a preference
-- change, including before the next daily recommendation refresh.
CREATE FUNCTION app_private.clear_personalized_cache() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.personalization_enabled IS DISTINCT FROM OLD.personalization_enabled THEN
  DELETE FROM public.recommendations WHERE user_id=NEW.id
   AND rec_date >= (now() AT TIME ZONE 'Asia/Seoul')::date;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.clear_personalized_cache() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER clear_personalized_cache AFTER UPDATE OF personalization_enabled ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION app_private.clear_personalized_cache();

-- Serialize publication with profile updates so a run computed before opt-out
-- cannot republish behavioral recommendations to any consumer, including email.
CREATE OR REPLACE FUNCTION public.replace_daily_recommendations(p_user_id uuid,p_date date,p_recs jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE personalized boolean;
BEGIN
 IF jsonb_typeof(p_recs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_recs)>5 THEN
  RAISE EXCEPTION 'Expected up to five recommendations' USING ERRCODE='22023';
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||p_date::text,0));
 SELECT personalization_enabled INTO personalized FROM public.profiles WHERE id=p_user_id FOR SHARE;
 IF personalized IS NOT TRUE AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_recs) r
  WHERE r->'reasons'->'personalization_enabled' IS DISTINCT FROM 'false'::jsonb) THEN RETURN; END IF;
 DELETE FROM public.recommendations WHERE user_id=p_user_id AND rec_date=p_date;
 INSERT INTO public.recommendations(user_id,paper_id,score,reasons,rec_date)
 SELECT p_user_id,r.paper_id,r.score,r.reasons,p_date
 FROM jsonb_to_recordset(p_recs) AS r(paper_id bigint,score real,reasons jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.reader_daily(p_day date DEFAULT CURRENT_DATE) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE result jsonb; uid uuid=auth.uid(); kw text[]; journals text[]; personalized boolean;
BEGIN
 IF uid IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 SELECT keywords,preferred_journals,personalization_enabled INTO kw,journals,personalized FROM public.profiles WHERE id=uid;
 WITH stored AS (
 SELECT p,1000+greatest(0,least(100,r.score)) score,'선호에 맞춰 선정' reason
 FROM public.recommendations r JOIN public.papers p ON p.id=r.paper_id
 WHERE r.user_id=uid AND r.rec_date=p_day AND p.pub_date>='2000-01-01' AND p.integrity_status<>'retracted'
 AND NOT p.summary_review_required AND public.paper_ready(p)
 AND (p_day < (now() AT TIME ZONE 'Asia/Seoul')::date OR personalized OR r.reasons->'personalization_enabled'='false'::jsonb)
 AND NOT EXISTS(SELECT 1 FROM public.feedbacks f WHERE f.user_id=uid AND f.paper_id=p.id AND f.action='dislike')
 ), candidates AS (
 SELECT p,(CASE WHEN p.journal=ANY(journals) THEN 4 ELSE 0 END +
 (SELECT count(*)*3 FROM unnest(kw) k WHERE p.search_vector@@plainto_tsquery('english',k)))::double precision score,
 CASE WHEN p.journal=ANY(journals) THEN '선호 저널' ELSE '관심 주제 및 최근 연구' END reason
 FROM public.papers p WHERE p_day=(now() AT TIME ZONE 'Asia/Seoul')::date AND p.pub_date>='2000-01-01'
 AND public.paper_ready(p) AND NOT p.summary_review_required AND p.integrity_status<>'retracted'
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
 RETURN result;
END;
$$;

-- Add live, bounded classification/acquisition metadata without rewriting stored
-- bibliography or suggesting that extraction completion is acquisition status.
CREATE OR REPLACE FUNCTION public.research_references(p_id bigint,p_query text DEFAULT '',p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE q text=lower(btrim(coalesce(p_query,''))); result jsonb;
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 IF length(q)>200 OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'Invalid research search' USING ERRCODE='22023'; END IF;
 WITH matches AS MATERIALIZED (SELECT r.id,r.created_at FROM public.research_reference_entries r WHERE collection_id=p_id
  AND (q='' OR position(q IN lower(r.bibliography::text||' '||r.note||' '||array_to_string(r.tags,' ')))>0)),
 page AS (SELECT * FROM matches ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET p_page*20)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('paper',CASE WHEN p.id IS NULL THEN NULL ELSE
 jsonb_build_object('id',p.id,'pmid',p.pmid,'title',p.title,'keywords',p.keywords,'mesh_terms',p.mesh_terms,
 'publication_types',p.publication_types,'study_type',p.study_type,'study_design',p.structured_data->>'study_design',
 'fulltext_available',p.fulltext_available,'summary_ready',public.paper_ready(p),'integrity_status',p.integrity_status) END)
 ORDER BY page.created_at DESC,page.id DESC) FROM page JOIN public.research_reference_entries r ON r.id=page.id
 LEFT JOIN public.papers p ON p.id=r.paper_id),'[]'),
 'total',(SELECT count(*) FROM matches),'page',p_page,'can_edit',public.collection_access(p_id,true)) INTO result;
 RETURN result;
END;
$$;

CREATE FUNCTION public.research_graph(p_id bigint,p_query text DEFAULT '',p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE q text=lower(btrim(coalesce(p_query,''))); result jsonb;
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 IF length(q)>200 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid graph scope' USING ERRCODE='22023'; END IF;
 WITH topics AS MATERIALIZED (
  SELECT * FROM public.research_topic_entries WHERE collection_id=p_id ORDER BY id LIMIT 20
 ), matches AS MATERIALIZED (
  SELECT r.id,r.created_at,EXISTS(SELECT 1 FROM topics t WHERE r.id=ANY(t.reference_ids)) linked
  FROM public.research_reference_entries r WHERE r.collection_id=p_id
  AND (q='' OR position(q IN lower(r.bibliography::text||' '||r.note||' '||array_to_string(r.tags,' ')))>0)
 ), visible AS (
  SELECT * FROM matches ORDER BY linked DESC,created_at DESC,id DESC LIMIT p_limit
 ) SELECT jsonb_build_object(
 'references',coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('paper',CASE WHEN p.id IS NULL THEN NULL ELSE
 jsonb_build_object('id',p.id,'pmid',p.pmid,'title',p.title,'keywords',p.keywords,'mesh_terms',p.mesh_terms,
 'publication_types',p.publication_types,'study_type',p.study_type,'study_design',p.structured_data->>'study_design',
 'fulltext_available',p.fulltext_available,'summary_ready',public.paper_ready(p),'integrity_status',p.integrity_status) END)
 ORDER BY v.linked DESC,v.created_at DESC,v.id DESC) FROM visible v JOIN public.research_reference_entries r ON r.id=v.id
 LEFT JOIN public.papers p ON p.id=r.paper_id),'[]'),
 'topics',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM topics t),'[]'),
 'total',(SELECT count(*) FROM matches),'topic_total',(SELECT count(*) FROM public.research_topic_entries WHERE collection_id=p_id),
 'limit',p_limit,'truncated',(SELECT count(*) FROM matches)>p_limit OR (SELECT count(*) FROM public.research_topic_entries WHERE collection_id=p_id)>20)
 INTO result;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.research_graph(bigint,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.research_graph(bigint,text,integer) TO authenticated;
COMMENT ON FUNCTION public.research_graph(bigint,text,integer) IS 'Bounded project-owned references and explicit writing links; no inferred citation or clinical support relationships.';
NOTIFY pgrst,'reload schema';
COMMIT;
