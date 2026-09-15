BEGIN;
ALTER TABLE public.papers ADD COLUMN volume text NOT NULL DEFAULT '';
ALTER TABLE public.papers ADD COLUMN issue text NOT NULL DEFAULT '';
ALTER TABLE public.papers ADD COLUMN pages text NOT NULL DEFAULT '';
ALTER TABLE public.papers ADD COLUMN publication_types jsonb NOT NULL DEFAULT '[]';
ALTER TABLE public.papers ADD COLUMN integrity_status text NOT NULL DEFAULT 'current' CHECK(integrity_status IN ('current','corrected','retracted','concern'));
ALTER TABLE public.papers ADD COLUMN summary_review_required boolean NOT NULL DEFAULT false;
ALTER TABLE public.papers ADD COLUMN summary_review_note text NOT NULL DEFAULT '';
ALTER TABLE public.papers ADD COLUMN related_notices jsonb NOT NULL DEFAULT '[]';
ALTER TABLE public.papers ADD COLUMN integrity_checked_at timestamptz;
ALTER TABLE public.papers ADD COLUMN evidence jsonb NOT NULL DEFAULT '{}';
ALTER TABLE public.papers ADD COLUMN research_details jsonb NOT NULL DEFAULT '{}';
CREATE INDEX papers_doi_lookup ON public.papers(lower(doi));

CREATE TABLE public.reader_states (
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 paper_id bigint NOT NULL REFERENCES public.papers(id) ON DELETE CASCADE,
 saved boolean NOT NULL DEFAULT false,
 reading_state text NOT NULL DEFAULT 'unread' CHECK(reading_state IN ('unread','reading','read')),
 position real NOT NULL DEFAULT 0 CHECK(position BETWEEN 0 AND 1),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=6000),
 tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(tags)<=20),
 summary_hash text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,paper_id)
);
ALTER TABLE public.reader_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY reader_states_own ON public.reader_states FOR ALL TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
GRANT SELECT,INSERT,UPDATE,DELETE ON public.reader_states TO authenticated;
INSERT INTO public.reader_states(user_id,paper_id,saved)
 SELECT DISTINCT c.user_id,cp.paper_id,true FROM public.collections c JOIN public.collection_papers cp ON cp.collection_id=c.id
 ON CONFLICT DO NOTHING;

CREATE TABLE public.summary_issues (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 paper_id bigint NOT NULL REFERENCES public.papers(id) ON DELETE CASCADE,
 category text NOT NULL CHECK(category IN ('summary','classification','original','figure')),
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 2000),
 source_hash text,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved','dismissed')),
 resolution text NOT NULL DEFAULT '' CHECK(length(resolution)<=2000),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.summary_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY issues_own_select ON public.summary_issues FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY issues_own_insert ON public.summary_issues FOR INSERT TO authenticated WITH CHECK(user_id=auth.uid() AND status='open' AND resolution='');
GRANT SELECT,INSERT ON public.summary_issues TO authenticated;
GRANT USAGE ON SEQUENCE public.summary_issues_id_seq TO authenticated;
CREATE UNIQUE INDEX issues_one_open ON public.summary_issues(user_id,paper_id,category) WHERE status IN ('open','reviewing');

CREATE TABLE public.saved_searches (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),query text NOT NULL DEFAULT '' CHECK(length(query)<=200),
 filters jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(filters)='object' AND octet_length(filters::text)<3000),
 enabled boolean NOT NULL DEFAULT true,last_seen_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.saved_searches ENABLE ROW LEVEL SECURITY;
CREATE POLICY searches_own ON public.saved_searches FOR ALL TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
GRANT SELECT,INSERT,UPDATE,DELETE ON public.saved_searches TO authenticated;
GRANT USAGE ON SEQUENCE public.saved_searches_id_seq TO authenticated;

CREATE FUNCTION public.paper_ready(p public.papers) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT p.fulltext_available AND p.summary_basis='fulltext' AND p.summary_source_hash IS NOT NULL AND p.summarized_at IS NOT NULL
 AND coalesce(p.summary_model,'')<>'' AND array_length(string_to_array(trim(p.summary_ko),chr(10)),1)=3
$$;
CREATE FUNCTION public.reader_card(p public.papers) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',p.id,'pmid',p.pmid,'title',p.title,'journal',p.journal,'pub_date',p.pub_date,'doi',p.doi,
 'study_type',p.study_type,'paper_type',p.paper_type,'fulltext_available',p.fulltext_available,'summary_ready',public.paper_ready(p),
 'insight',CASE WHEN public.paper_ready(p) THEN split_part(p.summary_ko,chr(10),2) ELSE '' END,
 'summary_review_required',p.summary_review_required,'study_design',p.structured_data->>'study_design','population',p.structured_data->>'population','integrity_status',p.integrity_status)
$$;
REVOKE ALL ON FUNCTION public.reader_card(public.papers),public.paper_ready(public.papers) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reader_card(public.papers),public.paper_ready(public.papers) TO authenticated,service_role;

CREATE FUNCTION public.search_papers(p_query text DEFAULT '',p_year integer DEFAULT 2000,p_until integer DEFAULT 3000,
 p_journal text DEFAULT '',p_type text DEFAULT '',p_state text DEFAULT 'all',p_sort text DEFAULT 'recent',p_page integer DEFAULT 0,p_saved boolean DEFAULT false,p_integrity text DEFAULT 'current')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE result jsonb; q text=trim(coalesce(p_query,'')); tq tsquery;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 IF length(q)>200 OR p_page NOT BETWEEN 0 AND 10000 OR p_year<2000 OR p_until<p_year OR p_until>3000
 OR p_state NOT IN ('all','ready','pending') OR p_sort NOT IN ('recent','oldest','relevance') OR p_integrity NOT IN ('current','all','retracted') THEN
 RAISE EXCEPTION 'Invalid search' USING ERRCODE='22023'; END IF;
 q=regexp_replace(q,'^https?://(dx\.)?doi\.org/','','i');
 tq=websearch_to_tsquery('english',q);
 WITH matches AS MATERIALIZED (
 SELECT p.id,p.pub_date,CASE WHEN q='' THEN 0 ELSE ts_rank(p.search_vector,tq) END rank FROM public.papers p
 WHERE p.pub_date>=make_date(p_year,1,1) AND p.pub_date<=make_date(p_until,12,31)
 AND (q='' OR p.pmid=q OR lower(p.doi)=lower(q) OR p.search_vector@@tq)
 AND (p_journal='' OR p.journal=p_journal) AND (p_type='' OR p.study_type=p_type)
 AND (p_state='all' OR (p_state='ready')=coalesce(public.paper_ready(p),false))
 AND (p_integrity='all' OR (p_integrity='current' AND p.integrity_status<>'retracted') OR (p_integrity='retracted' AND p.integrity_status='retracted'))
 AND (NOT p_saved OR EXISTS(SELECT 1 FROM public.reader_states s WHERE s.paper_id=p.id AND s.user_id=auth.uid() AND s.saved))
 ), page AS (
 SELECT id, row_number() OVER(ORDER BY CASE WHEN p_sort='relevance' THEN rank END DESC,
 CASE WHEN p_sort='oldest' THEN pub_date END ASC,CASE WHEN p_sort<>'oldest' THEN pub_date END DESC,id DESC) ordinal
 FROM matches ORDER BY ordinal LIMIT 20 OFFSET p_page*20
 ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(public.reader_card(p) ORDER BY page.ordinal) FROM page JOIN public.papers p ON p.id=page.id),'[]'),'total',(SELECT count(*) FROM matches),'page',p_page) INTO result;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.search_papers(text,integer,integer,text,text,text,text,integer,boolean,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_papers(text,integer,integer,text,text,text,text,integer,boolean,text) TO authenticated;

CREATE FUNCTION public.reader_paper(p_pmid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.papers; s jsonb; access_allowed boolean;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM public.papers WHERE pmid=p_pmid AND pub_date>='2000-01-01';
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT to_jsonb(r) INTO s FROM public.reader_states r WHERE r.user_id=auth.uid() AND r.paper_id=p.id;
 SELECT lower(email)='crazyslime@gmail.com' AND email_confirmed_at IS NOT NULL INTO access_allowed FROM auth.users WHERE id=auth.uid();
 RETURN jsonb_build_object('paper',to_jsonb(p)-'search_vector','state',coalesce(s,'{}'),
 'opinion',(SELECT action FROM public.feedbacks WHERE user_id=auth.uid() AND paper_id=p.id),
 'access',jsonb_build_object('can_read',coalesce(access_allowed,false) AND p.fulltext_storage='z8' AND p.fulltext_available),
 'issues',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY created_at DESC),'[]') FROM public.summary_issues i WHERE user_id=auth.uid() AND paper_id=p.id));
END;
$$;
REVOKE ALL ON FUNCTION public.reader_paper(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reader_paper(text) TO authenticated;

CREATE FUNCTION app_private.reader_alert_match(p public.papers,kind text,value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE kind WHEN 'journal' THEN position(lower(value) IN lower(p.journal))>0
 WHEN 'author' THEN to_tsvector('simple',p.authors::text)@@plainto_tsquery('simple',value)
 WHEN 'keyword' THEN p.search_vector@@plainto_tsquery('english',value) ELSE false END
$$;
REVOKE ALL ON FUNCTION app_private.reader_alert_match(public.papers,text,text) FROM PUBLIC;
CREATE FUNCTION public.reader_daily(p_day date DEFAULT CURRENT_DATE) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE result jsonb; uid uuid=auth.uid(); kw text[]; journals text[];
BEGIN
 IF uid IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 SELECT keywords,preferred_journals INTO kw,journals FROM public.profiles WHERE id=uid;
 WITH stored AS (
 SELECT p,1000+greatest(0,least(100,r.score)) score,'선정된 오늘의 문헌' reason FROM public.recommendations r JOIN public.papers p ON p.id=r.paper_id
 WHERE r.user_id=uid AND r.rec_date=p_day AND p.pub_date>='2000-01-01' AND p.integrity_status<>'retracted' AND NOT p.summary_review_required AND public.paper_ready(p)
 AND NOT EXISTS(SELECT 1 FROM public.feedbacks f WHERE f.user_id=uid AND f.paper_id=p.id AND f.action='dislike')
 ), candidates AS (
 SELECT p,(CASE WHEN p.journal=ANY(journals) THEN 4 ELSE 0 END +
 (SELECT count(*)*3 FROM unnest(kw) k WHERE p.search_vector@@plainto_tsquery('english',k)))::double precision score,
 CASE WHEN p.journal=ANY(journals) THEN '관심 저널' ELSE '관심 주제 · 최근 문헌' END reason
 FROM public.papers p WHERE p_day=(now() AT TIME ZONE 'Asia/Seoul')::date AND p.pub_date>='2000-01-01'
 AND public.paper_ready(p) AND NOT p.summary_review_required AND p.integrity_status<>'retracted' AND p.paper_type NOT IN ('letter','editorial','comment','erratum')
 AND NOT EXISTS(SELECT 1 FROM stored s WHERE (s.p).id=p.id)
 AND NOT EXISTS(SELECT 1 FROM public.feedbacks f WHERE f.user_id=uid AND f.paper_id=p.id AND f.action='dislike')
 AND NOT EXISTS(SELECT 1 FROM public.reader_states s WHERE s.user_id=uid AND s.paper_id=p.id AND s.reading_state='read')
 AND (p.journal=ANY(journals) OR EXISTS(SELECT 1 FROM unnest(kw) k WHERE p.search_vector@@plainto_tsquery('english',k)) OR EXISTS(SELECT 1 FROM public.alerts a WHERE a.user_id=uid AND a.is_active AND app_private.reader_alert_match(p,a.alert_type,a.value)))
 ORDER BY (p.pub_date>=current_date-interval '5 years') DESC,score DESC,p.pub_date DESC,p.id DESC LIMIT 20
 ), selected AS (SELECT * FROM stored UNION ALL SELECT * FROM candidates), bounded AS (
 SELECT * FROM selected ORDER BY score DESC,(p).pub_date DESC LIMIT 5)
 SELECT coalesce(jsonb_agg(public.reader_card(p)||jsonb_build_object('reason',reason,'read',EXISTS(SELECT 1 FROM public.reader_states s WHERE s.user_id=uid AND s.paper_id=(p).id AND s.reading_state='read'))),'[]') INTO result FROM bounded;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.reader_daily(date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reader_daily(date) TO authenticated;

CREATE FUNCTION public.reader_opinion(p_paper_id bigint,p_action text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF p_action NOT IN ('none','like','dislike') THEN RAISE EXCEPTION 'Invalid opinion'; END IF;
 PERFORM public.upsert_feedback(auth.uid(),p_paper_id,p_action);
END;
$$;
REVOKE ALL ON FUNCTION public.reader_opinion(bigint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reader_opinion(bigint,text) TO authenticated;

CREATE FUNCTION public.admin_summary_issues(p_id bigint DEFAULT NULL,p_status text DEFAULT NULL,p_resolution text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM app_private.require_admin();
 IF p_id IS NOT NULL THEN
 IF p_status NOT IN ('open','reviewing','resolved','dismissed') OR length(p_resolution)>2000 THEN RAISE EXCEPTION 'Invalid resolution'; END IF;
 UPDATE public.summary_issues SET status=p_status,resolution=p_resolution,updated_at=now() WHERE id=p_id;
 END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (SELECT i.*,p.pmid,p.title FROM public.summary_issues i JOIN public.papers p ON p.id=i.paper_id ORDER BY (i.status IN ('open','reviewing')) DESC,i.updated_at DESC LIMIT 100) x);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_summary_issues(bigint,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_summary_issues(bigint,text,text) TO authenticated;

CREATE FUNCTION public.search_notifications() RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM (
 SELECT s.id,s.name,s.query,s.filters,s.last_seen_at,s.enabled,
 (SELECT count(*) FROM public.papers p WHERE s.enabled AND (CASE WHEN s.filters->>'state'='ready' THEN greatest(p.fetched_at,p.summarized_at) ELSE p.fetched_at END)>s.last_seen_at AND p.pub_date>=make_date(greatest(2000,coalesce(CASE WHEN s.filters->>'year' ~ '^[0-9]{4}$' THEN least(3000,(s.filters->>'year')::integer) END,2000)),1,1)
 AND p.pub_date<=make_date(least(3000,coalesce(CASE WHEN s.filters->>'until' ~ '^[0-9]{4}$' THEN greatest(2000,(s.filters->>'until')::integer) END,3000)),12,31)
 AND (s.query='' OR p.search_vector@@websearch_to_tsquery('english',s.query) OR p.pmid=s.query OR lower(p.doi)=lower(regexp_replace(s.query,'^https?://(dx\.)?doi\.org/','','i')))
 AND (coalesce(s.filters->>'journal','')='' OR p.journal=s.filters->>'journal')
 AND (coalesce(s.filters->>'type','')='' OR p.study_type=s.filters->>'type')
 AND (coalesce(s.filters->>'state','all')='all' OR (s.filters->>'state'='ready')=coalesce(public.paper_ready(p),false))
 AND (coalesce(s.filters->>'integrity','current')='all' OR (s.filters->>'integrity'='retracted' AND p.integrity_status='retracted') OR (coalesce(s.filters->>'integrity','current')='current' AND p.integrity_status<>'retracted'))
 ) new_count FROM public.saved_searches s WHERE s.user_id=auth.uid() ORDER BY s.created_at DESC LIMIT 50
 ) x;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.search_notifications() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_notifications() TO authenticated;
CREATE FUNCTION public.update_reader_state(p_paper_id bigint,p_patch jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_patch)<>'object' OR (p_patch-ARRAY['saved','reading_state','position','note','tags','summary_hash'])<>'{}' THEN RAISE EXCEPTION 'Invalid state'; END IF;
 INSERT INTO public.reader_states(user_id,paper_id) VALUES(auth.uid(),p_paper_id) ON CONFLICT DO NOTHING;
 UPDATE public.reader_states SET
 saved=CASE WHEN p_patch?'saved' THEN (p_patch->>'saved')::boolean ELSE saved END,
 reading_state=CASE WHEN p_patch?'reading_state' THEN p_patch->>'reading_state' ELSE reading_state END,
 position=CASE WHEN p_patch?'position' THEN (p_patch->>'position')::real ELSE position END,
 note=CASE WHEN p_patch?'note' THEN p_patch->>'note' ELSE note END,
 tags=CASE WHEN p_patch?'tags' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'tags')) ELSE tags END,
 summary_hash=CASE WHEN p_patch?'summary_hash' THEN p_patch->>'summary_hash' ELSE summary_hash END,updated_at=now()
 WHERE user_id=auth.uid() AND paper_id=p_paper_id RETURNING to_jsonb(reader_states) INTO result;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.update_reader_state(bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_reader_state(bigint,jsonb) TO authenticated;
CREATE FUNCTION public.preview_papers() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('pmid',p.pmid,'title',p.title,'journal',p.journal,'pub_date',p.pub_date,'summary_ko',p.summary_ko)),'[]')
 FROM (SELECT p.* FROM public.papers p WHERE p.pub_date>='2000-01-01' AND p.integrity_status='current' AND NOT p.summary_review_required AND public.paper_ready(p) ORDER BY pub_date DESC,id DESC LIMIT 3) p
$$;
REVOKE ALL ON FUNCTION public.preview_papers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_papers() TO anon,authenticated;
COMMIT;
