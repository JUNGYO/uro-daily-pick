BEGIN;

-- Search personal state before selecting the page. A note does not require Save.
CREATE FUNCTION public.search_library(p_query text DEFAULT '',p_tab text DEFAULT 'all',p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE q text=lower(btrim(coalesce(p_query,''))); result jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 IF length(q)>200 OR p_tab IS NULL OR p_tab NOT IN ('all','saved','read','reading','liked','notes') OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 10000 THEN
  RAISE EXCEPTION 'Invalid library search' USING ERRCODE='22023'; END IF;
 WITH matches AS MATERIALIZED (
  SELECT p.id,coalesce(s.updated_at,f.created_at,p.fetched_at) updated_at FROM public.papers p
  LEFT JOIN public.reader_states s ON s.paper_id=p.id AND s.user_id=auth.uid()
  LEFT JOIN public.feedbacks f ON f.paper_id=p.id AND f.user_id=auth.uid()
  WHERE p.pub_date>='2000-01-01' AND (s.paper_id IS NOT NULL OR f.action='like')
   AND (p_tab='all' OR (p_tab='saved' AND s.saved) OR (p_tab='read' AND s.reading_state='read')
    OR (p_tab='reading' AND s.reading_state='reading') OR (p_tab='liked' AND f.action='like')
    OR (p_tab='notes' AND (btrim(s.note)<>'' OR cardinality(s.tags)>0)))
   AND (q='' OR position(q IN lower(p.title||' '||p.pmid||' '||coalesce(p.doi,'')||' '||coalesce(s.note,'')||' '||coalesce(array_to_string(s.tags,' '),'')))>0)
 ), page AS (SELECT * FROM matches ORDER BY updated_at DESC,id DESC LIMIT 20 OFFSET p_page*20)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(public.reader_card(p)||jsonb_build_object(
  'note',coalesce(s.note,''),'tags',coalesce(s.tags,'{}'),'saved',coalesce(s.saved,false),'reading_state',coalesce(s.reading_state,'unread')) ORDER BY page.updated_at DESC,page.id DESC)
  FROM page JOIN public.papers p ON p.id=page.id LEFT JOIN public.reader_states s ON s.paper_id=p.id AND s.user_id=auth.uid()),'[]'),
  'total',(SELECT count(*) FROM matches),'page',p_page) INTO result;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.search_library(text,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_library(text,text,integer) TO authenticated;

CREATE FUNCTION public.project_papers_v2(p_id bigint,p_query text DEFAULT '',p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE q text=lower(btrim(coalesce(p_query,''))); result jsonb;
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 IF length(q)>200 OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'Invalid project search' USING ERRCODE='22023'; END IF;
 WITH matches AS MATERIALIZED (
  SELECT p.id,cp.added_at FROM public.collection_papers cp JOIN public.papers p ON p.id=cp.paper_id
  LEFT JOIN public.project_notes n ON n.collection_id=p_id AND n.paper_id=p.id
  WHERE cp.collection_id=p_id AND (q='' OR position(q IN lower(p.title||' '||p.pmid||' '||coalesce(p.doi,'')||' '||coalesce(n.note,'')||' '||coalesce(array_to_string(n.tags,' '),'')))>0)
 ), page AS (SELECT * FROM matches ORDER BY added_at DESC,id DESC LIMIT 20 OFFSET p_page*20)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(public.reader_card(p)||jsonb_build_object('note',coalesce(n.note,''),'tags',coalesce(n.tags,'{}')) ORDER BY page.added_at DESC,page.id DESC)
  FROM page JOIN public.papers p ON p.id=page.id LEFT JOIN public.project_notes n ON n.collection_id=p_id AND n.paper_id=p.id),'[]'),
  'total',(SELECT count(*) FROM matches),'page',p_page,'can_edit',public.collection_access(p_id,true)) INTO result;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.project_papers_v2(bigint,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.project_papers_v2(bigint,text,integer) TO authenticated;

CREATE FUNCTION app_private.research_default_columns() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT '[{"id":"study_design","label":"Study design","instruction":"Identify the study design"},{"id":"population","label":"Population","instruction":"Describe eligibility and sample size"},{"id":"intervention","label":"Intervention","instruction":"Describe the intervention or exposure"},{"id":"comparator","label":"Comparator","instruction":"Identify the comparator"},{"id":"outcome","label":"Outcome","instruction":"Summarize the principal outcome"},{"id":"limitations","label":"Limitations","instruction":"Summarize the reported limitations"}]'::jsonb
$$;
CREATE FUNCTION app_private.research_columns_valid(p_columns jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE c jsonb; seen text[]='{}';
BEGIN
 IF jsonb_typeof(p_columns) IS DISTINCT FROM 'array' OR jsonb_array_length(p_columns) NOT BETWEEN 1 AND 30 THEN RETURN false; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p_columns) LOOP
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c-ARRAY['id','label','instruction']<>'{}'
   OR jsonb_typeof(c->'id') IS DISTINCT FROM 'string' OR c->>'id' !~ '^[a-z][a-z0-9_]{0,39}$'
   OR c->>'id'=ANY(seen) OR jsonb_typeof(c->'label') IS DISTINCT FROM 'string' OR length(btrim(c->>'label')) NOT BETWEEN 1 AND 100
   OR jsonb_typeof(c->'instruction') IS DISTINCT FROM 'string' OR length(c->>'instruction')>300 THEN RETURN false; END IF;
  seen=array_append(seen,c->>'id');
 END LOOP;
 RETURN true;
END;
$$;
CREATE TABLE public.research_workspaces (
 collection_id bigint PRIMARY KEY REFERENCES public.collections(id) ON DELETE CASCADE,
 question text NOT NULL DEFAULT '' CHECK(length(question)<=4000),template text NOT NULL DEFAULT 'general' CHECK(length(template) BETWEEN 1 AND 80),
 columns jsonb NOT NULL DEFAULT app_private.research_default_columns() CHECK(app_private.research_columns_valid(columns)),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.research_reference_entries (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,collection_id bigint NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
 paper_id bigint REFERENCES public.papers(id) ON DELETE SET NULL,
 bibliography jsonb NOT NULL CHECK(jsonb_typeof(bibliography)='object'),
 auto_values jsonb NOT NULL DEFAULT '{}',user_values jsonb NOT NULL DEFAULT '{}',evidence jsonb NOT NULL DEFAULT '{}',
 note text NOT NULL DEFAULT '' CHECK(length(note)<=6000),tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(tags)<=20),
 revision integer NOT NULL DEFAULT 0,extraction_status text NOT NULL DEFAULT 'not_requested'
  CHECK(extraction_status IN ('not_requested','queued','waiting_source','running','retry','complete','stale','failed')),
 source_content_hash text,extracted_at timestamptz,extraction_model text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 UNIQUE(collection_id,paper_id),UNIQUE(collection_id,id)
);
CREATE INDEX research_references_page ON public.research_reference_entries(collection_id,created_at DESC,id DESC);
CREATE TABLE public.research_topic_entries (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,collection_id bigint NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
 section text NOT NULL CHECK(section IN ('introduction','discussion')),title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
 body text NOT NULL DEFAULT '' CHECK(length(body)<=12000),reference_ids bigint[] NOT NULL DEFAULT '{}' CHECK(cardinality(reference_ids)<=100),
 cell_links jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(cell_links)='array' AND jsonb_array_length(cell_links)<=100),
 revision integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX research_topics_page ON public.research_topic_entries(collection_id,section,id);
CREATE TABLE public.research_document_exports (
 export_id uuid PRIMARY KEY,collection_id bigint NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
 created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 format text NOT NULL CHECK(format IN ('docx','csv','ris','google_docs')),
 workspace_revision integer NOT NULL CHECK(workspace_revision>=0),fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=1000000),
 reference_count integer NOT NULL CHECK(reference_count BETWEEN 0 AND 10000),topic_count integer NOT NULL CHECK(topic_count BETWEEN 0 AND 1000),
 url text,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((format='google_docs' AND url IS NOT NULL AND url ~ '^https://docs[.]google[.]com/document/d/[A-Za-z0-9_-]{10,200}/edit$') OR (format<>'google_docs' AND url IS NULL))
);
CREATE INDEX research_exports_page ON public.research_document_exports(collection_id,created_by,created_at DESC,export_id);
ALTER TABLE public.research_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_reference_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_topic_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_document_exports ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_workspaces_read ON public.research_workspaces FOR SELECT TO authenticated USING(public.collection_access(collection_id));
CREATE POLICY research_references_read ON public.research_reference_entries FOR SELECT TO authenticated USING(public.collection_access(collection_id));
CREATE POLICY research_topics_read ON public.research_topic_entries FOR SELECT TO authenticated USING(public.collection_access(collection_id));
CREATE POLICY research_exports_own_read ON public.research_document_exports FOR SELECT TO authenticated USING(created_by=auth.uid() AND public.collection_access(collection_id));
REVOKE ALL ON public.research_workspaces,public.research_reference_entries,public.research_topic_entries FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.research_workspaces,public.research_reference_entries,public.research_topic_entries TO authenticated;
REVOKE ALL ON public.research_document_exports FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.research_document_exports TO authenticated;

-- Bibliography is copied by the database; client metadata can never establish
-- original acquisition or summary completion. References survive catalog removal.
CREATE FUNCTION app_private.research_bibliography(p public.papers) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_build_object('pmid',p.pmid,'title',p.title,'authors',p.authors,'journal',p.journal,'pub_date',p.pub_date,'doi',p.doi,'volume',p.volume,'issue',p.issue,'pages',p.pages)
$$;
-- Keep membership/note writes from slipping between the snapshot backfill and
-- capture-trigger installation. Ordinary project reads remain available.
LOCK TABLE public.collection_papers,public.project_notes IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO public.research_reference_entries(collection_id,paper_id,bibliography,note,tags,created_at,updated_by)
 SELECT cp.collection_id,p.id,app_private.research_bibliography(p),coalesce(n.note,''),coalesce(n.tags,'{}'),cp.added_at,n.updated_by
 FROM public.collection_papers cp JOIN public.papers p ON p.id=cp.paper_id LEFT JOIN public.project_notes n ON n.collection_id=cp.collection_id AND n.paper_id=p.id;
CREATE FUNCTION app_private.capture_research_reference() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO public.research_reference_entries(collection_id,paper_id,bibliography)
  SELECT NEW.collection_id,p.id,app_private.research_bibliography(p) FROM public.papers p WHERE p.id=NEW.paper_id ON CONFLICT(collection_id,paper_id) DO NOTHING;
 RETURN NEW;
END;
$$;
CREATE TRIGGER capture_research_reference AFTER INSERT ON public.collection_papers FOR EACH ROW EXECUTE FUNCTION app_private.capture_research_reference();
CREATE FUNCTION app_private.preserve_project_note() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.research_reference_entries SET note=NEW.note,tags=NEW.tags,revision=revision+1,updated_at=now(),updated_by=NEW.updated_by
  WHERE collection_id=NEW.collection_id AND paper_id=NEW.paper_id AND (note,tags) IS DISTINCT FROM (NEW.note,NEW.tags);
 RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_project_note AFTER INSERT OR UPDATE ON public.project_notes FOR EACH ROW EXECUTE FUNCTION app_private.preserve_project_note();

CREATE FUNCTION public.research_workspace(p_id bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w jsonb;
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 SELECT to_jsonb(r) INTO w FROM public.research_workspaces r WHERE collection_id=p_id;
 RETURN jsonb_build_object('workspace',coalesce(w,jsonb_build_object('collection_id',p_id,'question','','template','general','columns',app_private.research_default_columns(),'revision',0)),
  'can_edit',public.collection_access(p_id,true));
END;
$$;
CREATE FUNCTION public.save_research_workspace(p_id bigint,p_expected_revision integer,p_question text,p_template text,p_columns jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF NOT public.collection_access(p_id,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF p_expected_revision IS NULL OR p_expected_revision<0 OR p_question IS NULL OR length(p_question)>4000 OR p_template IS NULL
  OR length(btrim(p_template)) NOT BETWEEN 1 AND 80 OR NOT app_private.research_columns_valid(p_columns) THEN RAISE EXCEPTION 'Invalid workspace' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('research:'||p_id::text,0));
 INSERT INTO public.research_workspaces(collection_id) VALUES(p_id) ON CONFLICT DO NOTHING;
 UPDATE public.research_workspaces SET question=p_question,template=p_template,columns=p_columns,revision=revision+1,updated_by=auth.uid(),updated_at=now()
  WHERE collection_id=p_id AND revision=p_expected_revision RETURNING to_jsonb(research_workspaces) INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Workspace changed; reload before saving' USING ERRCODE='40001'; END IF;
 UPDATE app_private.research_extraction_jobs j SET status='stale',lease_token=NULL,lease_until=NULL,updated_at=now()
  FROM public.research_reference_entries r WHERE r.id=j.reference_id AND r.collection_id=p_id AND j.status<>'stale';
 UPDATE public.research_reference_entries SET extraction_status='stale' WHERE collection_id=p_id AND extraction_status<>'not_requested';
 RETURN result;
END;
$$;
CREATE FUNCTION public.research_references(p_id bigint,p_query text DEFAULT '',p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE q text=lower(btrim(coalesce(p_query,''))); result jsonb;
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 IF length(q)>200 OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'Invalid research search' USING ERRCODE='22023'; END IF;
 WITH matches AS MATERIALIZED (SELECT r.id,r.created_at FROM public.research_reference_entries r WHERE collection_id=p_id
  AND (q='' OR position(q IN lower(r.bibliography::text||' '||r.note||' '||array_to_string(r.tags,' ')))>0)),
 page AS (SELECT * FROM matches ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET p_page*20)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY page.created_at DESC,page.id DESC) FROM page JOIN public.research_reference_entries r ON r.id=page.id),'[]'),
  'total',(SELECT count(*) FROM matches),'page',p_page,'can_edit',public.collection_access(p_id,true)) INTO result;
 RETURN result;
END;
$$;
CREATE FUNCTION public.add_research_reference(p_id bigint,p_paper_id bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF NOT public.collection_access(p_id,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 INSERT INTO public.research_reference_entries(collection_id,paper_id,bibliography,updated_by)
  SELECT p_id,p.id,app_private.research_bibliography(p),auth.uid() FROM public.papers p WHERE p.id=p_paper_id AND p.pub_date>='2000-01-01'
  ON CONFLICT(collection_id,paper_id) DO NOTHING;
 SELECT to_jsonb(r) INTO result FROM public.research_reference_entries r WHERE collection_id=p_id AND paper_id=p_paper_id;
 IF result IS NULL THEN RAISE EXCEPTION 'Citation unavailable' USING ERRCODE='22023'; END IF;
 RETURN result;
END;
$$;
CREATE FUNCTION public.save_research_reference(p_id bigint,p_expected_revision integer,p_user_values jsonb,p_note text,p_tags text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.research_reference_entries; result jsonb; kv record;
BEGIN
 SELECT * INTO r FROM public.research_reference_entries WHERE id=p_id;
 IF NOT FOUND OR NOT public.collection_access(r.collection_id,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF p_expected_revision IS NULL OR p_expected_revision<0 OR jsonb_typeof(p_user_values) IS DISTINCT FROM 'object' OR octet_length(p_user_values::text)>120000
  OR p_note IS NULL OR length(p_note)>6000 OR p_tags IS NULL OR cardinality(p_tags)>20
  OR EXISTS(SELECT 1 FROM unnest(p_tags) t WHERE t IS NULL OR length(t)>100) THEN RAISE EXCEPTION 'Invalid reference edit' USING ERRCODE='22023'; END IF;
 FOR kv IN SELECT * FROM jsonb_each(p_user_values) LOOP
  IF kv.key !~ '^[a-z][a-z0-9_]{0,39}$' OR jsonb_typeof(kv.value)<>'string' OR length(kv.value#>>'{}')>1500 THEN RAISE EXCEPTION 'Invalid extraction edit' USING ERRCODE='22023'; END IF;
 END LOOP;
 -- Existing note writers lock project_notes first. Match that order before
 -- touching the durable reference, so the compatibility trigger cannot deadlock.
 PERFORM 1 FROM public.project_notes WHERE collection_id=r.collection_id AND paper_id=r.paper_id FOR UPDATE;
 UPDATE public.research_reference_entries SET user_values=p_user_values,note=p_note,tags=p_tags,revision=revision+1,updated_at=now(),updated_by=auth.uid()
  WHERE id=p_id AND revision=p_expected_revision RETURNING to_jsonb(research_reference_entries) INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Reference changed; reload before saving' USING ERRCODE='40001'; END IF;
 -- Keep the existing project note surface and its search in sync. The trigger
 -- only increments a revision when its content actually differs from this row.
 INSERT INTO public.project_notes(collection_id,paper_id,note,tags,updated_by)
  SELECT r.collection_id,r.paper_id,p_note,p_tags,auth.uid() WHERE EXISTS(
   SELECT 1 FROM public.collection_papers cp WHERE cp.collection_id=r.collection_id AND cp.paper_id=r.paper_id)
  ON CONFLICT(collection_id,paper_id) DO UPDATE SET note=excluded.note,tags=excluded.tags,updated_by=excluded.updated_by,updated_at=now();
 RETURN result;
END;
$$;
CREATE FUNCTION public.research_topics(p_id bigint,p_section text DEFAULT 'all',p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 IF p_section IS NULL OR p_section NOT IN ('all','introduction','discussion') OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'Invalid topic search' USING ERRCODE='22023'; END IF;
 WITH matches AS MATERIALIZED (SELECT * FROM public.research_topic_entries WHERE collection_id=p_id AND (p_section='all' OR section=p_section)),
 page AS (SELECT * FROM matches ORDER BY id LIMIT 20 OFFSET p_page*20)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(page)||jsonb_build_object('references',
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'bibliography',r.bibliography) ORDER BY r.id),'[]') FROM public.research_reference_entries r WHERE r.id=ANY(page.reference_ids) AND r.collection_id=p_id)) ORDER BY id) FROM page),'[]'),'total',(SELECT count(*) FROM matches),'page',p_page) INTO result;
 RETURN result;
END;
$$;
CREATE FUNCTION public.save_research_topic(p_collection_id bigint,p_id bigint,p_expected_revision integer,p_section text,p_title text,p_body text,p_reference_ids bigint[],p_cell_links jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; link jsonb;
BEGIN
 IF NOT public.collection_access(p_collection_id,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF p_expected_revision IS NULL OR p_expected_revision<0 OR p_section IS NULL OR p_section NOT IN ('introduction','discussion')
  OR p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 200 OR p_body IS NULL OR length(p_body)>12000
  OR p_reference_ids IS NULL OR cardinality(p_reference_ids)>100 OR EXISTS(SELECT 1 FROM unnest(p_reference_ids) i WHERE i IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.research_reference_entries WHERE id=i AND collection_id=p_collection_id))
  OR jsonb_typeof(p_cell_links) IS DISTINCT FROM 'array' OR jsonb_array_length(p_cell_links)>100 THEN RAISE EXCEPTION 'Invalid research topic' USING ERRCODE='22023'; END IF;
 FOR link IN SELECT value FROM jsonb_array_elements(p_cell_links) LOOP
  IF jsonb_typeof(link) IS DISTINCT FROM 'object' OR link-ARRAY['reference_id','column_id']<>'{}'
   OR jsonb_typeof(link->'reference_id') IS DISTINCT FROM 'number' OR link->>'reference_id' !~ '^[0-9]{1,18}$'
   OR NOT ((link->>'reference_id')::bigint=ANY(p_reference_ids)) OR jsonb_typeof(link->'column_id') IS DISTINCT FROM 'string'
   OR link->>'column_id' !~ '^[a-z][a-z0-9_]{0,39}$' THEN RAISE EXCEPTION 'Invalid topic cell link' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF p_id IS NULL THEN
  IF p_expected_revision<>0 THEN RAISE EXCEPTION 'Invalid new topic revision' USING ERRCODE='40001'; END IF;
  INSERT INTO public.research_topic_entries(collection_id,section,title,body,reference_ids,cell_links,revision,updated_by)
   VALUES(p_collection_id,p_section,p_title,p_body,p_reference_ids,p_cell_links,1,auth.uid()) RETURNING to_jsonb(research_topic_entries) INTO result;
 ELSE
  UPDATE public.research_topic_entries SET section=p_section,title=p_title,body=p_body,reference_ids=p_reference_ids,cell_links=p_cell_links,revision=revision+1,updated_at=now(),updated_by=auth.uid()
   WHERE id=p_id AND collection_id=p_collection_id AND revision=p_expected_revision RETURNING to_jsonb(research_topic_entries) INTO result;
  IF result IS NULL THEN RAISE EXCEPTION 'Topic changed; reload before saving' USING ERRCODE='40001'; END IF;
 END IF;
 RETURN result;
END;
$$;

-- STABLE keeps the project, extraction rows and prose on the caller's single
-- statement snapshot, even when collaborators save during an export.
CREATE FUNCTION public.research_export_snapshot(p_id bigint) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE result jsonb;
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('project',jsonb_build_object('id',c.id,'name',c.name),'workspace',
  coalesce((SELECT to_jsonb(w) FROM public.research_workspaces w WHERE w.collection_id=p_id),jsonb_build_object('collection_id',p_id,'question','','template','general','columns',app_private.research_default_columns(),'revision',0)),
  'references',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM public.research_reference_entries r WHERE r.collection_id=p_id),
  'topics',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM public.research_topic_entries t WHERE t.collection_id=p_id),
  'generated_at',statement_timestamp()) INTO result FROM public.collections c WHERE c.id=p_id;
 RETURN result||jsonb_build_object('export_fingerprint',encode(sha256(convert_to((result-'generated_at')::text,'UTF8')),'hex'),
  'revision_manifest',jsonb_build_object(
   'references',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',r->'id','revision',r->'revision') ORDER BY (r->>'id')::bigint),'[]') FROM jsonb_array_elements(result->'references') r),
   'topics',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',t->'id','revision',t->'revision') ORDER BY (t->>'id')::bigint),'[]') FROM jsonb_array_elements(result->'topics') t)));
END;
$$;

CREATE FUNCTION public.record_research_export(p_id bigint,p_export_id uuid,p_format text,p_workspace_revision integer,p_fingerprint text,p_manifest jsonb,p_url text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; kind text; seen bigint[]; result public.research_document_exports;
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 IF p_export_id IS NULL OR p_format IS NULL OR p_format NOT IN ('docx','csv','ris','google_docs') OR p_workspace_revision IS NULL OR p_workspace_revision<0
  OR p_workspace_revision>coalesce((SELECT revision FROM public.research_workspaces WHERE collection_id=p_id),0)
  OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
  OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR p_manifest-ARRAY['references','topics']<>'{}'
  OR jsonb_typeof(p_manifest->'references') IS DISTINCT FROM 'array' OR jsonb_typeof(p_manifest->'topics') IS DISTINCT FROM 'array'
  OR octet_length(p_manifest::text)>1000000 OR jsonb_array_length(p_manifest->'references')>10000 OR jsonb_array_length(p_manifest->'topics')>1000
  OR (p_format='google_docs' AND (p_url IS NULL OR p_url !~ '^https://docs[.]google[.]com/document/d/[A-Za-z0-9_-]{10,200}/edit$'))
  OR (p_format<>'google_docs' AND p_url IS NOT NULL) THEN RAISE EXCEPTION 'Invalid export record' USING ERRCODE='22023'; END IF;
 FOREACH kind IN ARRAY ARRAY['references','topics'] LOOP
  seen='{}';
  FOR item IN SELECT value FROM jsonb_array_elements(p_manifest->kind) LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['id','revision']<>'{}'
    OR jsonb_typeof(item->'id') IS DISTINCT FROM 'number' OR item->>'id' !~ '^[1-9][0-9]{0,17}$'
    OR jsonb_typeof(item->'revision') IS DISTINCT FROM 'number' OR item->>'revision' !~ '^[0-9]{1,9}$'
    OR (item->>'id')::bigint=ANY(seen) THEN RAISE EXCEPTION 'Invalid export revision manifest' USING ERRCODE='22023'; END IF;
   seen=array_append(seen,(item->>'id')::bigint);
   IF kind='references' AND NOT EXISTS(SELECT 1 FROM public.research_reference_entries r WHERE r.id=(item->>'id')::bigint
    AND r.collection_id=p_id AND r.revision>=(item->>'revision')::integer) THEN RAISE EXCEPTION 'Invalid export reference revision' USING ERRCODE='22023'; END IF;
   -- A topic may have been deleted while the document was being generated.
   -- Existing topics must belong to this project and cannot claim a future edit.
   IF kind='topics' AND EXISTS(SELECT 1 FROM public.research_topic_entries t WHERE t.id=(item->>'id')::bigint
    AND (t.collection_id<>p_id OR t.revision<(item->>'revision')::integer)) THEN RAISE EXCEPTION 'Invalid export topic revision' USING ERRCODE='22023'; END IF;
  END LOOP;
 END LOOP;
 INSERT INTO public.research_document_exports(export_id,collection_id,created_by,format,workspace_revision,fingerprint,manifest,reference_count,topic_count,url)
  VALUES(p_export_id,p_id,auth.uid(),p_format,p_workspace_revision,p_fingerprint,p_manifest,jsonb_array_length(p_manifest->'references'),jsonb_array_length(p_manifest->'topics'),p_url)
  ON CONFLICT(export_id) DO NOTHING;
 SELECT * INTO result FROM public.research_document_exports e WHERE e.export_id=p_export_id AND e.created_by=auth.uid() AND e.collection_id=p_id;
 IF NOT FOUND OR (result.format,result.workspace_revision,result.fingerprint,result.manifest,result.url)
  IS DISTINCT FROM (p_format,p_workspace_revision,p_fingerprint,p_manifest,p_url) THEN RAISE EXCEPTION 'Export identifier already used' USING ERRCODE='23505'; END IF;
 RETURN to_jsonb(result);
END;
$$;
CREATE FUNCTION public.research_document_exports(p_id bigint,p_page integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 IF p_page IS NULL OR p_page NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'Invalid export page' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('items',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC,e.export_id),'[]') FROM
  (SELECT * FROM public.research_document_exports WHERE collection_id=p_id AND created_by=auth.uid() ORDER BY created_at DESC,export_id LIMIT 20 OFFSET p_page*20) e),
  'total',(SELECT count(*) FROM public.research_document_exports WHERE collection_id=p_id AND created_by=auth.uid()),'page',p_page);
END;
$$;
CREATE FUNCTION public.delete_research_topic(p_id bigint,p_expected_revision integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cid bigint;
BEGIN
 SELECT collection_id INTO cid FROM public.research_topic_entries WHERE id=p_id;
 IF cid IS NULL OR NOT public.collection_access(cid,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 DELETE FROM public.research_topic_entries WHERE id=p_id AND revision=p_expected_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'Topic changed; reload before deleting' USING ERRCODE='40001'; END IF;
END;
$$;

CREATE TABLE app_private.research_extraction_jobs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,reference_id bigint NOT NULL UNIQUE REFERENCES public.research_reference_entries(id) ON DELETE CASCADE,
 request jsonb NOT NULL,status text NOT NULL CHECK(status IN ('queued','waiting_source','running','retry','complete','stale','failed')),
 worker_id uuid REFERENCES app_private.institution_workers(id),lease_token uuid,lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),retry_at timestamptz NOT NULL DEFAULT now(),
 error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_jobs_ready ON app_private.research_extraction_jobs(status,retry_at,id);
ALTER TABLE app_private.research_extraction_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.research_extraction_jobs FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.request_research_extraction(p_id bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.research_reference_entries; w public.research_workspaces; p public.papers; source jsonb; req jsonb; result jsonb;
BEGIN
 SELECT * INTO r FROM public.research_reference_entries WHERE id=p_id;
 IF NOT FOUND OR NOT public.collection_access(r.collection_id,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('research:'||r.collection_id::text,0));
 SELECT * INTO p FROM public.papers WHERE id=r.paper_id FOR SHARE;
 INSERT INTO public.research_workspaces(collection_id) VALUES(r.collection_id) ON CONFLICT DO NOTHING;
 SELECT * INTO w FROM public.research_workspaces WHERE collection_id=r.collection_id;
 SELECT jsonb_build_object('content_hash',s.content_hash,'summary_source_hash',s.summary_source_hash) INTO source
  FROM app_private.local_fulltext_sources s WHERE s.paper_id=p.id AND s.title=p.title FOR SHARE;
 PERFORM 1 FROM public.research_reference_entries WHERE id=p_id FOR UPDATE;
 req=jsonb_build_object('version',1,'workspace_revision',w.revision,'collection_id',w.collection_id,'reference_id',r.id,
  'question',w.question,'template',w.template,'columns',w.columns,'paper',jsonb_build_object('id',r.paper_id,'pmid',coalesce(p.pmid,r.bibliography->>'pmid'),
    'doi',coalesce(p.doi,r.bibliography->>'doi'),'title',coalesce(p.title,r.bibliography->>'title')),'source',source);
 INSERT INTO app_private.research_extraction_jobs(reference_id,request,status)
  VALUES(p_id,req,CASE WHEN source IS NULL THEN 'waiting_source' ELSE 'queued' END)
  ON CONFLICT(reference_id) DO UPDATE SET request=excluded.request,status=excluded.status,worker_id=NULL,lease_token=NULL,lease_until=NULL,
   attempts=0,retry_at=now(),error_code=NULL,updated_at=now()
  WHERE research_extraction_jobs.request IS DISTINCT FROM excluded.request OR research_extraction_jobs.status IN ('failed','stale','complete');
 UPDATE public.research_reference_entries SET extraction_status=j.status FROM app_private.research_extraction_jobs j WHERE j.reference_id=p_id AND research_reference_entries.id=p_id;
 SELECT jsonb_build_object('status',j.status) INTO result FROM app_private.research_extraction_jobs j WHERE j.reference_id=p_id;
 RETURN result;
END;
$$;

CREATE FUNCTION public.claim_research_extractions(p_worker_id uuid,p_token text,p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j record; result jsonb='[]'; token uuid; req jsonb;
BEGIN
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Invalid claim limit' USING ERRCODE='22023'; END IF;
 FOR j IN SELECT jobs.id,jobs.request,jobs.attempts,r.paper_id,s.content_hash,s.summary_source_hash,p.pmid,p.doi,p.title
  FROM app_private.research_extraction_jobs jobs JOIN public.research_reference_entries r ON r.id=jobs.reference_id
  JOIN public.research_workspaces w ON w.collection_id=r.collection_id JOIN public.papers p ON p.id=r.paper_id
  JOIN app_private.local_fulltext_sources s ON s.paper_id=p.id AND s.title=p.title AND s.worker_id=p_worker_id
  WHERE ((jobs.status IN ('queued','waiting_source','retry') AND jobs.retry_at<=now()) OR (jobs.status='running' AND jobs.lease_until<now()))
   AND (jobs.attempts<3 OR jobs.status='running') AND (jobs.request->>'workspace_revision')::integer=w.revision
   AND pg_try_advisory_xact_lock(hashtextextended('research:'||r.collection_id::text,0))
  ORDER BY jobs.retry_at,jobs.id LIMIT p_limit FOR UPDATE OF jobs SKIP LOCKED LOOP
  IF j.attempts>=3 THEN
   UPDATE app_private.research_extraction_jobs SET status='failed',error_code='lease_expired',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=j.id;
   UPDATE public.research_reference_entries SET extraction_status='failed' WHERE id=(j.request->>'reference_id')::bigint;
   CONTINUE;
  END IF;
  token=gen_random_uuid();
  req=jsonb_set(jsonb_set(j.request,'{source}',jsonb_build_object('content_hash',j.content_hash,'summary_source_hash',j.summary_source_hash)),
   '{paper}',jsonb_build_object('id',j.paper_id,'pmid',j.pmid,'doi',j.doi,'title',j.title));
  UPDATE app_private.research_extraction_jobs SET status='running',request=req,worker_id=p_worker_id,lease_token=token,lease_until=now()+interval '10 minutes',attempts=attempts+1,updated_at=now() WHERE id=j.id;
  UPDATE public.research_reference_entries SET extraction_status='running' WHERE id=(req->>'reference_id')::bigint;
  result=result||jsonb_build_array(jsonb_build_object('id',j.id,'lease_token',token,'request',req));
 END LOOP;
 UPDATE app_private.institution_workers SET last_seen_at=now() WHERE id=p_worker_id;
 RETURN result;
END;
$$;

CREATE FUNCTION public.finish_research_extraction(p_worker_id uuid,p_token text,p_job_id bigint,p_lease_token uuid,p_request jsonb,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j app_private.research_extraction_jobs; r public.research_reference_entries; w public.research_workspaces; s app_private.local_fulltext_sources;
 col jsonb; loc jsonb; expected_keys text[]; actual_keys text[];
BEGIN
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 SELECT entry.* INTO r FROM public.research_reference_entries entry JOIN app_private.research_extraction_jobs job ON job.reference_id=entry.id WHERE job.id=p_job_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Current extraction lease required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('research:'||r.collection_id::text,0));
 -- Acquisition updates lock the paper and receipt before invalidating jobs.
 -- Read-lock those same records first to validate one unchanged original.
 PERFORM 1 FROM public.papers WHERE id=r.paper_id FOR SHARE;
 SELECT * INTO s FROM app_private.local_fulltext_sources WHERE paper_id=r.paper_id FOR SHARE;
 SELECT * INTO j FROM app_private.research_extraction_jobs WHERE id=p_job_id FOR UPDATE;
 IF NOT FOUND OR j.status<>'running' OR j.worker_id IS DISTINCT FROM p_worker_id OR j.lease_token IS DISTINCT FROM p_lease_token OR j.lease_until<=now()
  THEN RAISE EXCEPTION 'Current extraction lease required' USING ERRCODE='42501'; END IF;
 IF p_request IS DISTINCT FROM j.request OR p_request->'version' IS DISTINCT FROM '1'::jsonb THEN RAISE EXCEPTION 'Extraction request changed' USING ERRCODE='40001'; END IF;
 SELECT * INTO r FROM public.research_reference_entries WHERE id=j.reference_id FOR UPDATE;
 SELECT * INTO w FROM public.research_workspaces WHERE collection_id=r.collection_id FOR SHARE;
 IF w.revision IS DISTINCT FROM (j.request->>'workspace_revision')::integer OR s.worker_id IS DISTINCT FROM p_worker_id
  OR s.content_hash IS DISTINCT FROM j.request#>>'{source,content_hash}' OR s.summary_source_hash IS DISTINCT FROM j.request#>>'{source,summary_source_hash}'
  OR s.title IS DISTINCT FROM j.request#>>'{paper,title}' OR NOT EXISTS(SELECT 1 FROM public.papers p WHERE p.id=r.paper_id AND p.title=s.title)
  THEN RAISE EXCEPTION 'Original or workspace changed; request extraction again' USING ERRCODE='40001'; END IF;
 IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR p_result-ARRAY['version','values','evidence','model']<>'{}'
  OR p_result->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p_result->'values') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_result->'evidence') IS DISTINCT FROM 'object' OR jsonb_typeof(p_result->'model') IS DISTINCT FROM 'string'
  OR length(btrim(p_result->>'model')) NOT BETWEEN 1 AND 120 OR octet_length(p_result::text)>160000 THEN RAISE EXCEPTION 'Invalid extraction result' USING ERRCODE='22023'; END IF;
 SELECT array_agg(value->>'id' ORDER BY value->>'id') INTO expected_keys FROM jsonb_array_elements(j.request->'columns');
 SELECT array_agg(key ORDER BY key) INTO actual_keys FROM jsonb_object_keys(p_result->'values') key;
 IF actual_keys IS DISTINCT FROM expected_keys THEN RAISE EXCEPTION 'Extraction columns differ from request' USING ERRCODE='22023'; END IF;
 SELECT array_agg(key ORDER BY key) INTO actual_keys FROM jsonb_object_keys(p_result->'evidence') key;
 IF actual_keys IS DISTINCT FROM expected_keys THEN RAISE EXCEPTION 'Evidence columns differ from request' USING ERRCODE='22023'; END IF;
 FOR col IN SELECT value FROM jsonb_array_elements(j.request->'columns') LOOP
  IF jsonb_typeof(p_result->'values'->(col->>'id')) IS DISTINCT FROM 'string' OR length(p_result->'values'->>(col->>'id'))>1500
   OR jsonb_typeof(p_result->'evidence'->(col->>'id')) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid derived value' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_result->'evidence'->(col->>'id'))>12 THEN RAISE EXCEPTION 'Too many evidence locations' USING ERRCODE='22023'; END IF;
  FOR loc IN SELECT value FROM jsonb_array_elements(p_result->'evidence'->(col->>'id')) LOOP
   IF jsonb_typeof(loc) IS DISTINCT FROM 'string' OR loc#>>'{}' !~ '^(p|figure|table)-[0-9]{7}$' THEN RAISE EXCEPTION 'Invalid evidence location' USING ERRCODE='22023'; END IF;
  END LOOP;
 END LOOP;
 UPDATE public.research_reference_entries SET auto_values=p_result->'values',evidence=p_result->'evidence',source_content_hash=s.content_hash,
  extraction_model=p_result->>'model',extracted_at=now(),extraction_status='complete' WHERE id=r.id;
 UPDATE app_private.research_extraction_jobs SET status='complete',lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=now() WHERE id=j.id;
 RETURN true;
END;
$$;
CREATE FUNCTION public.fail_research_extraction(p_worker_id uuid,p_token text,p_job_id bigint,p_lease_token uuid,p_error_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j app_private.research_extraction_jobs; next_status text; cid bigint;
BEGIN
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 IF p_error_code IS NULL OR p_error_code NOT IN ('source_unavailable','budget_yield','invalid_output','inference_error','retryable_error') THEN RAISE EXCEPTION 'Invalid failure code' USING ERRCODE='22023'; END IF;
 SELECT r.collection_id INTO cid FROM public.research_reference_entries r JOIN app_private.research_extraction_jobs job ON job.reference_id=r.id WHERE job.id=p_job_id;
 IF cid IS NULL THEN RAISE EXCEPTION 'Current extraction lease required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('research:'||cid::text,0));
 SELECT * INTO j FROM app_private.research_extraction_jobs WHERE id=p_job_id FOR UPDATE;
 IF NOT FOUND OR j.status<>'running' OR j.worker_id IS DISTINCT FROM p_worker_id OR j.lease_token IS DISTINCT FROM p_lease_token OR j.lease_until<=now()
  THEN RAISE EXCEPTION 'Current extraction lease required' USING ERRCODE='42501'; END IF;
 next_status=CASE WHEN p_error_code='source_unavailable' THEN 'waiting_source' WHEN p_error_code='budget_yield' THEN 'retry' WHEN j.attempts>=3 THEN 'failed' ELSE 'retry' END;
 UPDATE app_private.research_extraction_jobs SET status=next_status,error_code=p_error_code,lease_token=NULL,lease_until=NULL,
  -- Only the authenticated worker can report budget_yield; it retains verified
  -- chunk progress locally and does not spend an inference-failure attempt.
  attempts=CASE WHEN p_error_code IN ('source_unavailable','budget_yield') THEN greatest(0,attempts-1) ELSE attempts END,
  retry_at=now()+CASE WHEN p_error_code='source_unavailable' THEN interval '15 minutes' ELSE interval '1 minute' END,updated_at=now() WHERE id=j.id;
 UPDATE public.research_reference_entries SET extraction_status=next_status WHERE id=j.reference_id;
END;
$$;

-- Previously extracted cells remain available, but their source is never
-- silently described as current after a new acquisition or title correction.
CREATE FUNCTION app_private.invalidate_research_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE pid bigint; next_status text;
BEGIN
 IF TG_TABLE_NAME='papers' THEN
  IF NEW.title IS NOT DISTINCT FROM OLD.title THEN RETURN NEW; END IF;
  pid=NEW.id;next_status='waiting_source';
 ELSE
  IF TG_OP='UPDATE' AND (NEW.content_hash,NEW.summary_source_hash,NEW.title) IS NOT DISTINCT FROM (OLD.content_hash,OLD.summary_source_hash,OLD.title) THEN RETURN NEW; END IF;
  pid=OLD.paper_id;next_status=CASE WHEN TG_OP='DELETE' THEN 'waiting_source' ELSE 'queued' END;
 END IF;
 UPDATE app_private.research_extraction_jobs job SET status=next_status,lease_token=NULL,lease_until=NULL,attempts=0,retry_at=now(),updated_at=now()
  FROM public.research_reference_entries r WHERE r.id=job.reference_id AND r.paper_id=pid AND job.status<>'stale';
 UPDATE public.research_reference_entries r SET extraction_status=job.status FROM app_private.research_extraction_jobs job
  WHERE job.reference_id=r.id AND r.paper_id=pid;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_research_acquisition AFTER UPDATE OR DELETE ON app_private.local_fulltext_sources FOR EACH ROW EXECUTE FUNCTION app_private.invalidate_research_source();
CREATE TRIGGER invalidate_research_title AFTER UPDATE OF title ON public.papers FOR EACH ROW EXECUTE FUNCTION app_private.invalidate_research_source();

REVOKE ALL ON FUNCTION app_private.research_default_columns(),app_private.research_columns_valid(jsonb),app_private.research_bibliography(public.papers),app_private.capture_research_reference(),app_private.preserve_project_note(),app_private.invalidate_research_source() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.research_workspace(bigint),public.save_research_workspace(bigint,integer,text,text,jsonb),public.research_references(bigint,text,integer),public.add_research_reference(bigint,bigint),
 public.save_research_reference(bigint,integer,jsonb,text,text[]),public.research_topics(bigint,text,integer),public.save_research_topic(bigint,bigint,integer,text,text,text,bigint[],jsonb),public.delete_research_topic(bigint,integer),public.research_export_snapshot(bigint),public.request_research_extraction(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_workspace(bigint),public.save_research_workspace(bigint,integer,text,text,jsonb),public.research_references(bigint,text,integer),public.add_research_reference(bigint,bigint),
 public.save_research_reference(bigint,integer,jsonb,text,text[]),public.research_topics(bigint,text,integer),public.save_research_topic(bigint,bigint,integer,text,text,text,bigint[],jsonb),public.delete_research_topic(bigint,integer),public.research_export_snapshot(bigint),public.request_research_extraction(bigint) TO authenticated;
REVOKE ALL ON FUNCTION public.claim_research_extractions(uuid,text,integer),public.finish_research_extraction(uuid,text,bigint,uuid,jsonb,jsonb),public.fail_research_extraction(uuid,text,bigint,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_research_extractions(uuid,text,integer),public.finish_research_extraction(uuid,text,bigint,uuid,jsonb,jsonb),public.fail_research_extraction(uuid,text,bigint,uuid,text) TO anon,authenticated;
REVOKE ALL ON FUNCTION public.record_research_export(bigint,uuid,text,integer,text,jsonb,text),public.research_document_exports(bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_research_export(bigint,uuid,text,integer,text,jsonb,text),public.research_document_exports(bigint,integer) TO authenticated;
COMMIT;
