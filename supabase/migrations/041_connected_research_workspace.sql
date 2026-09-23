BEGIN;

-- A project has one set of documents. Personal saves remain private and separate
-- from research eligibility decisions. Historical additions are not a new search.
CREATE INDEX review_reports_catalog ON public.review_reports(project_id,paper_id) WHERE paper_id IS NOT NULL;
CREATE UNIQUE INDEX review_project_library_source ON public.review_searches(project_id)
 WHERE limits->>'kind'='project_library';
ALTER TABLE public.research_reference_entries ADD COLUMN review_report_id uuid REFERENCES public.review_reports(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX research_reference_review_report ON public.research_reference_entries(collection_id,review_report_id) WHERE review_report_id IS NOT NULL;

CREATE FUNCTION app_private.connect_project_paper(p_project bigint,p_paper bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.papers; r public.review_reports; actor uuid; sid uuid; rid uuid; identity text; bib jsonb; added timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('review:'||p_project::text,0));
 IF EXISTS(SELECT 1 FROM public.review_reports WHERE project_id=p_project AND paper_id=p_paper) THEN RETURN; END IF;
 SELECT * INTO p FROM public.papers WHERE id=p_paper;
 SELECT coalesce(auth.uid(),user_id) INTO actor FROM public.collections WHERE id=p_project;
 IF p.id IS NULL OR actor IS NULL THEN RETURN; END IF;
 identity=CASE WHEN coalesce(btrim(p.doi),'')<>'' THEN 'doi:'||lower(btrim(p.doi)) ELSE 'pmid:'||p.pmid END;
 SELECT * INTO r FROM public.review_reports WHERE project_id=p_project AND identity_key=identity;
 IF r.id IS NOT NULL AND coalesce(r.bibliography->>'pmid','')<>'' AND r.bibliography->>'pmid'<>p.pmid THEN
  identity=identity||':conflict:'||p.pmid;
  SELECT * INTO r FROM public.review_reports WHERE project_id=p_project AND identity_key=identity;
 END IF;
 IF r.id IS NOT NULL THEN
  -- Link only the catalog identity; never overwrite screening or source evidence.
  UPDATE public.review_reports SET paper_id=p_paper WHERE id=r.id AND paper_id IS NULL;
  RETURN;
 END IF;
 SELECT added_at INTO added FROM public.collection_papers WHERE collection_id=p_project AND paper_id=p_paper;
 SELECT id INTO sid FROM public.review_searches WHERE project_id=p_project AND limits->>'kind'='project_library';
 IF sid IS NULL THEN
  sid=gen_random_uuid();
  INSERT INTO public.review_searches(id,project_id,source,query,searched_at,limits,status,created_by)
   VALUES(sid,p_project,'Project library','',now(),jsonb_build_object('kind','project_library','coverage_note','Project additions; original search strategy and search date were not recorded.'),'partial',actor);
 END IF;
 bib=jsonb_build_object('title',p.title,'authors',coalesce(p.authors,'[]'),'journal',p.journal,
  'date',p.pub_date,'year',extract(year FROM p.pub_date)::text,'abstract',p.abstract,'doi',p.doi,'pmid',p.pmid);
 rid=gen_random_uuid();
 INSERT INTO public.review_reports(id,project_id,paper_id,bibliography,identity_key,updated_by)
  VALUES(rid,p_project,p.id,bib,identity,actor);
 INSERT INTO public.review_records(id,project_id,search_id,report_id,source_record_id,bibliography,imported_by,imported_at)
  VALUES(gen_random_uuid(),p_project,sid,rid,'PMID:'||p.pmid,bib,actor,coalesce(added,now()));
 PERFORM app_private.review_audit(p_project,'project_document_link',rid::text,NULL,jsonb_build_object('paper_id',p.id,'source','project_library'));
END $$;

CREATE FUNCTION app_private.connect_added_project_paper() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN PERFORM app_private.connect_project_paper(NEW.collection_id,NEW.paper_id); RETURN NEW; END $$;
CREATE TRIGGER connect_added_project_paper AFTER INSERT ON public.collection_papers
 FOR EACH ROW EXECUTE FUNCTION app_private.connect_added_project_paper();

CREATE FUNCTION app_private.connect_imported_review_paper() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE pid bigint;
BEGIN
 SELECT paper_id INTO pid FROM public.review_reports WHERE id=NEW.report_id AND project_id=NEW.project_id;
 IF pid IS NOT NULL THEN
  UPDATE public.research_reference_entries e SET paper_id=pid
   WHERE e.collection_id=NEW.project_id AND e.review_report_id=NEW.report_id AND e.paper_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.research_reference_entries c WHERE c.collection_id=NEW.project_id AND c.paper_id=pid);
  INSERT INTO public.collection_papers(collection_id,paper_id) VALUES(NEW.project_id,pid) ON CONFLICT DO NOTHING;
  UPDATE public.research_reference_entries SET review_report_id=NEW.report_id
   WHERE collection_id=NEW.project_id AND paper_id=pid AND review_report_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.research_reference_entries e WHERE e.collection_id=NEW.project_id AND e.review_report_id=NEW.report_id);
 ELSE
  INSERT INTO public.research_reference_entries(collection_id,review_report_id,bibliography,updated_by)
   SELECT NEW.project_id,r.id,r.bibliography||jsonb_build_object('pub_date',coalesce(r.bibliography->>'date',r.bibliography->>'year')),NEW.imported_by
   FROM public.review_reports r WHERE r.id=NEW.report_id
   ON CONFLICT(collection_id,review_report_id) WHERE review_report_id IS NOT NULL DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER connect_imported_review_paper AFTER INSERT ON public.review_records
 FOR EACH ROW EXECUTE FUNCTION app_private.connect_imported_review_paper();
REVOKE ALL ON FUNCTION app_private.connect_project_paper(bigint,bigint),app_private.connect_added_project_paper(),app_private.connect_imported_review_paper() FROM PUBLIC,anon,authenticated;

-- Reconcile existing project contents once, without touching personal saves,
-- prior searches, eligibility decisions, extracted values or analysis snapshots.
DO $$DECLARE p record; BEGIN
 FOR p IN SELECT collection_id,paper_id FROM public.collection_papers ORDER BY collection_id,paper_id LOOP
  PERFORM app_private.connect_project_paper(p.collection_id,p.paper_id);
 END LOOP;
 INSERT INTO public.collection_papers(collection_id,paper_id)
 SELECT DISTINCT project_id,paper_id FROM public.review_reports WHERE paper_id IS NOT NULL ON CONFLICT DO NOTHING;
 UPDATE public.research_reference_entries e SET review_report_id=r.id FROM public.review_reports r
  WHERE e.collection_id=r.project_id AND e.paper_id=r.paper_id AND e.review_report_id IS NULL;
 INSERT INTO public.research_reference_entries(collection_id,review_report_id,bibliography,updated_by)
  SELECT r.project_id,r.id,r.bibliography||jsonb_build_object('pub_date',coalesce(r.bibliography->>'date',r.bibliography->>'year')),r.updated_by
  FROM public.review_reports r WHERE r.paper_id IS NULL
  ON CONFLICT(collection_id,review_report_id) WHERE review_report_id IS NOT NULL DO NOTHING;
END $$;

CREATE FUNCTION public.workspace_paper_context(p_papers bigint[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 IF p_papers IS NULL OR cardinality(p_papers)>100 THEN RAISE EXCEPTION 'At most 100 papers' USING ERRCODE='22023'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('paper_id',p.id,
  'saved',coalesce((SELECT saved FROM public.reader_states WHERE user_id=auth.uid() AND paper_id=p.id),false),
  'projects',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'report_id',r.id,
   'ta_decision',r.ta_decision,'ft_decision',r.ft_decision,'duplicate',r.duplicate_of IS NOT NULL) ORDER BY c.name,c.id)
   FROM public.review_reports r JOIN public.collections c ON c.id=r.project_id WHERE r.paper_id=p.id),'[]')))
  FROM public.papers p WHERE p.id=ANY(p_papers)),'[]');
END $$;

CREATE FUNCTION public.project_documents(p_id bigint,p_query text DEFAULT '',p_page integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE q text=lower(btrim(coalesce(p_query,''))); result jsonb;
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 IF length(q)>200 OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 WITH matches AS MATERIALIZED (
  SELECT r.* FROM public.review_reports r LEFT JOIN public.project_notes n ON n.collection_id=p_id AND n.paper_id=r.paper_id
  WHERE r.project_id=p_id AND (q='' OR position(q IN lower(coalesce(r.bibliography::text,'')||' '||coalesce(n.note,'')||' '||coalesce(array_to_string(n.tags,' '),'')))>0)
 ), page AS (SELECT * FROM matches ORDER BY updated_at DESC,id DESC LIMIT 20 OFFSET p_page*20)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(
   (CASE WHEN p.id IS NULL THEN jsonb_build_object('title',r.bibliography->>'title','journal',r.bibliography->>'journal',
     'pub_date',coalesce(r.bibliography->>'date',r.bibliography->>'year'),'pmid',r.bibliography->>'pmid','doi',r.bibliography->>'doi','external',true)
    ELSE public.reader_card(p) END)||jsonb_build_object('report_id',r.id,'ta_decision',r.ta_decision,'ft_decision',r.ft_decision,
     'duplicate',r.duplicate_of IS NOT NULL,'note',coalesce(n.note,''),'tags',coalesce(n.tags,'{}')) ORDER BY r.updated_at DESC,r.id DESC)
   FROM page r LEFT JOIN public.papers p ON p.id=r.paper_id LEFT JOIN public.project_notes n ON n.collection_id=p_id AND n.paper_id=p.id),'[]'),
  'total',(SELECT count(*) FROM matches),'page',p_page,'can_edit',public.collection_access(p_id,true)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.workspace_paper_context(bigint[]),public.project_documents(bigint,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.workspace_paper_context(bigint[]),public.project_documents(bigint,text,integer) TO authenticated;
CREATE OR REPLACE FUNCTION public.review_import_records(p_project bigint,p_search uuid,p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE item jsonb; bib jsonb; report_bib jsonb; catalog public.papers; identity text; rid uuid; existing uuid; pid bigint; n integer=0; matches integer=0; v_doi text; v_pmid text; seen public.review_reports;
BEGIN
 IF NOT public.collection_access(p_project,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Import batches contain 1 to 100 records' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('review:'||p_project::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.review_searches WHERE project_id=p_project AND id=p_search) THEN RAISE EXCEPTION 'Search not found' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  IF NOT app_private.review_object(item,ARRAY['source_record_id','bibliography','paper_id']) OR coalesce(length(item->>'source_record_id'),0) NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid source record' USING ERRCODE='22023'; END IF;
  bib=item->'bibliography'; pid=(item->>'paper_id')::bigint;
  IF NOT app_private.review_object(bib,ARRAY['title','authors','journal','year','date','doi','pmid','volume','issue','pages','abstract','url','zotero_key','report_type'],24000)
   OR coalesce(length(btrim(bib->>'title')),0) NOT BETWEEN 1 AND 2000 OR jsonb_typeof(coalesce(bib->'authors','[]'))<>'array'
   OR jsonb_array_length(coalesce(bib->'authors','[]'))>300 THEN RAISE EXCEPTION 'Invalid bibliography' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(bib->'authors','[]')) a WHERE jsonb_typeof(a)<>'string' OR length(a#>>'{}')>400) THEN RAISE EXCEPTION 'Invalid authors' USING ERRCODE='22023'; END IF;
  v_doi=lower(btrim(coalesce(bib->>'doi',''))); v_pmid=btrim(coalesce(bib->>'pmid',''));
  IF v_doi<>'' AND v_doi !~ '^10\.[0-9]{4,9}/[^[:space:]]+$' OR v_pmid<>'' AND v_pmid !~ '^[0-9]{1,10}$' THEN RAISE EXCEPTION 'Invalid identifier' USING ERRCODE='22023'; END IF;
  IF pid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.papers paper WHERE paper.id=pid AND paper.pmid=v_pmid AND paper.title=bib->>'title') THEN RAISE EXCEPTION 'Catalog identity changed' USING ERRCODE='22023'; END IF;
  report_bib=bib;
  IF pid IS NOT NULL THEN
   SELECT * INTO catalog FROM public.papers WHERE id=pid;
   report_bib=bib||jsonb_build_object('title',catalog.title,'authors',coalesce(catalog.authors,'[]'),'journal',catalog.journal,
    'date',catalog.pub_date,'year',extract(year FROM catalog.pub_date)::text,'abstract',catalog.abstract,'doi',catalog.doi,'pmid',catalog.pmid);
   v_doi=lower(btrim(coalesce(catalog.doi,'')));
  END IF;
  SELECT report_id INTO existing FROM public.review_records WHERE search_id=p_search AND source_record_id=item->>'source_record_id';
  IF existing IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.review_records WHERE search_id=p_search AND source_record_id=item->>'source_record_id' AND bibliography=bib) THEN RAISE EXCEPTION 'Source record was already imported with different content' USING ERRCODE='40001'; END IF;
   CONTINUE;
  END IF;
  identity=CASE WHEN v_doi<>'' THEN 'doi:'||v_doi WHEN v_pmid<>'' THEN 'pmid:'||v_pmid ELSE 'source:'||p_search||':'||(item->>'source_record_id') END;
  SELECT * INTO seen FROM public.review_reports WHERE project_id=p_project AND identity_key=identity;
  IF seen.id IS NOT NULL AND v_pmid<>'' AND coalesce(seen.bibliography->>'pmid','')<>'' AND seen.bibliography->>'pmid'<>v_pmid THEN
   identity=identity||':conflict:'||v_pmid; seen=NULL;
   SELECT * INTO seen FROM public.review_reports WHERE project_id=p_project AND identity_key=identity;
  END IF;
  IF seen.id IS NULL THEN
   rid=gen_random_uuid();
   INSERT INTO public.review_reports(id,project_id,paper_id,bibliography,identity_key,updated_by) VALUES(rid,p_project,pid,report_bib,identity,auth.uid());
  ELSE rid=seen.id; matches=matches+1;
   IF pid IS NOT NULL AND seen.paper_id IS NULL THEN UPDATE public.review_reports SET paper_id=pid WHERE id=rid; END IF;
  END IF;
  INSERT INTO public.review_records(id,project_id,search_id,report_id,source_record_id,bibliography,imported_by)
   VALUES(gen_random_uuid(),p_project,p_search,rid,item->>'source_record_id',bib,auth.uid()); n=n+1;
 END LOOP;
 PERFORM app_private.review_audit(p_project,'import',p_search::text,NULL,jsonb_build_object('records',n,'existing_reports',matches));
 RETURN jsonb_build_object('imported',n,'existing_reports',matches);
END $$;


COMMIT;
