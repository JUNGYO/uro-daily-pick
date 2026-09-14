BEGIN;
-- The institution worker sends derived summaries and provenance only.
DROP FUNCTION public.publish_institution_fulltext(uuid,text,text,text,jsonb);
ALTER TABLE public.papers ADD COLUMN fulltext_storage text CHECK(fulltext_storage IN ('cloud','z8'));
UPDATE public.papers SET fulltext_storage='cloud' WHERE fulltext_available;
CREATE TABLE app_private.local_fulltext_sources (
  paper_id bigint PRIMARY KEY REFERENCES public.papers(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES app_private.institution_workers(id),
  title text NOT NULL,
  content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  summary_source_hash text NOT NULL CHECK(summary_source_hash ~ '^[0-9a-f]{64}$'),
  characters integer NOT NULL CHECK(characters BETWEEN 500 AND 600000),
  section_count integer NOT NULL CHECK(section_count > 0),
  source_url text,
  verified_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_private.local_fulltext_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.local_fulltext_sources FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION app_private.check_summary_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE expected_hash text;
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title THEN NEW.summary_source_hash=NULL; NEW.summarized_at=NULL; END IF;
  IF NEW.summary_basis='fulltext' AND NEW.summary_source_hash IS NOT NULL THEN
    IF NEW.fulltext_storage='z8' THEN
      SELECT summary_source_hash INTO expected_hash FROM app_private.local_fulltext_sources WHERE paper_id=NEW.id AND title=NEW.title;
    ELSE
      SELECT encode(sha256(convert_to('fulltext'||chr(10)||NEW.title||chr(10)||content_text,'UTF8')),'hex')
        INTO expected_hash FROM public.paper_fulltexts WHERE paper_id=NEW.id AND status='ready';
    END IF;
    IF NEW.summary_source_hash IS DISTINCT FROM expected_hash THEN
      RAISE EXCEPTION 'Summary source changed' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.invalidate_body_summary()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE paper_key bigint;
BEGIN
  paper_key=CASE WHEN TG_OP='DELETE' THEN OLD.paper_id ELSE NEW.paper_id END;
  IF EXISTS(SELECT 1 FROM app_private.local_fulltext_sources WHERE paper_id=paper_key) THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP='DELETE' THEN
    UPDATE public.papers SET fulltext_available=false,fulltext_storage=NULL,summary_source_hash=NULL,summarized_at=NULL WHERE id=paper_key;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.papers SET fulltext_available=(NEW.status='ready'),fulltext_storage=CASE WHEN NEW.status='ready' THEN 'cloud' ELSE NULL END,
      summary_source_hash=NULL,summarized_at=NULL WHERE id=paper_key;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.publish_institution_summary(p_worker_id uuid,p_token text,p_pmid text,p_doi text,p_title text,p_source jsonb,p_summary jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE paper_key bigint; item jsonb; field text;
BEGIN
  PERFORM app_private.require_institution_worker(p_worker_id,p_token);
  SELECT id INTO STRICT paper_key FROM public.papers WHERE pmid=p_pmid AND lower(doi) IS NOT DISTINCT FROM lower(p_doi) AND title=p_title FOR UPDATE;
  IF jsonb_typeof(p_source) IS DISTINCT FROM 'object' OR jsonb_typeof(p_summary) IS DISTINCT FROM 'object'
    OR (p_source - ARRAY['content_hash','characters','section_count','source_url']) <> '{}'
    OR (p_summary - ARRAY['summary_ko','structured_data','clinical_relevance','qa_data','summary_model','summary_source_hash']) <> '{}'
    OR coalesce(p_source->>'content_hash','') !~ '^[0-9a-f]{64}$'
    OR coalesce(p_summary->>'summary_source_hash','') !~ '^[0-9a-f]{64}$'
    OR coalesce(p_summary->>'summary_model','') !~ '^spark/[a-zA-Z0-9:._/-]{1,80}$'
    OR length(coalesce(p_summary->>'summary_ko','')) NOT BETWEEN 10 AND 2000
    OR array_length(string_to_array(p_summary->>'summary_ko',chr(10)),1) IS DISTINCT FROM 3
    OR jsonb_typeof(p_summary->'structured_data') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_summary->'qa_data') IS DISTINCT FROM 'array'
    OR coalesce((p_source->>'characters')::integer,0) NOT BETWEEN 2000 AND 600000
    OR coalesce((p_source->>'section_count')::integer,0) NOT BETWEEN 2 AND 1000
    OR coalesce((p_summary->>'clinical_relevance')::integer,0) NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'Invalid summary metadata' USING ERRCODE='22023'; END IF;
  FOREACH field IN ARRAY ARRAY['study_design','sample_size','key_finding','population'] LOOP
    IF jsonb_typeof(p_summary->'structured_data'->field) IS DISTINCT FROM 'string'
      OR length(p_summary->'structured_data'->>field) NOT BETWEEN 1 AND 1500 THEN
      RAISE EXCEPTION 'Invalid structured field' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF ((p_summary->'structured_data') - ARRAY['study_design','sample_size','key_finding','population']) <> '{}'
    OR jsonb_array_length(p_summary->'qa_data') NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Invalid derived fields' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_summary->'qa_data') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (item - ARRAY['q','a']) <> '{}'
      OR jsonb_typeof(item->'q') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'a') IS DISTINCT FROM 'string'
      OR length(item->>'q') NOT BETWEEN 1 AND 2000 OR length(item->>'a') NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION 'Invalid question answer' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF coalesce(p_source->>'source_url','') !~ '^https://' OR length(p_source->>'source_url') > 1000 THEN
    RAISE EXCEPTION 'Invalid source URL' USING ERRCODE='22023'; END IF;
  INSERT INTO app_private.local_fulltext_sources(paper_id,worker_id,title,content_hash,summary_source_hash,characters,section_count,source_url)
    VALUES(paper_key,p_worker_id,p_title,p_source->>'content_hash',p_summary->>'summary_source_hash',
      (p_source->>'characters')::integer,(p_source->>'section_count')::integer,p_source->>'source_url')
    ON CONFLICT(paper_id) DO UPDATE SET worker_id=excluded.worker_id,title=excluded.title,content_hash=excluded.content_hash,
      summary_source_hash=excluded.summary_source_hash,characters=excluded.characters,section_count=excluded.section_count,source_url=excluded.source_url,verified_at=now();
  UPDATE public.papers SET fulltext_available=true,fulltext_storage='z8',summary_basis='fulltext',summary_ko=p_summary->>'summary_ko',
    structured_data=p_summary->'structured_data',qa_data=p_summary->'qa_data',clinical_relevance=(p_summary->>'clinical_relevance')::integer,
    summary_model=p_summary->>'summary_model',summary_source_hash=p_summary->>'summary_source_hash',summarized_at=now() WHERE id=paper_key;
  INSERT INTO app_private.institution_attempts(worker_id,paper_id,status) VALUES(p_worker_id,paper_key,'ready')
    ON CONFLICT(worker_id,paper_id) DO UPDATE SET status='ready',attempted_at=now();
  UPDATE app_private.institution_workers SET last_seen_at=now(),state='running' WHERE id=p_worker_id;
END;
$$;
REVOKE ALL ON FUNCTION public.publish_institution_summary(uuid,text,text,text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_institution_summary(uuid,text,text,text,text,jsonb,jsonb) TO anon,authenticated;

CREATE OR REPLACE FUNCTION public.admin_fulltext_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM app_private.require_admin();
  RETURN jsonb_build_object(
    'ready_bodies',(SELECT count(*) FROM public.papers WHERE fulltext_available),
    'local_bodies',(SELECT count(*) FROM app_private.local_fulltext_sources),
    'cloud_bodies',(SELECT count(*) FROM public.paper_fulltexts WHERE status='ready'),
    'ready_summaries',(SELECT count(*) FROM public.papers WHERE summary_basis='fulltext' AND summary_source_hash IS NOT NULL AND summarized_at IS NOT NULL),
    'workers',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',name,'state',state,'last_seen_at',last_seen_at)),'[]') FROM app_private.institution_workers WHERE enabled),
    'attempts',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM (SELECT status,count(*) n FROM app_private.institution_attempts GROUP BY status) a));
END;
$$;

-- Move legacy cloud bodies only after the worker verifies its durable local copy.
CREATE FUNCTION public.institution_cloud_archive(p_worker_id uuid,p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM app_private.require_institution_worker(p_worker_id,p_token);
  RETURN (SELECT jsonb_build_object('paper',jsonb_build_object('id',p.id,'pmid',p.pmid,'doi',p.doi,'title',p.title),
      'document',jsonb_build_object('content_text',f.content_text,'content_hash',f.content_hash,'sections',f.sections,
        'source_url',f.source_url,'license',f.license,'source',f.source))
    FROM public.paper_fulltexts f JOIN public.papers p ON p.id=f.paper_id WHERE f.status='ready' ORDER BY p.id LIMIT 1);
END;
$$;
CREATE FUNCTION public.confirm_local_fulltext_archive(p_worker_id uuid,p_token text,p_pmid text,p_content_hash text,p_source_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item record; expected_hash text;
BEGIN
  PERFORM app_private.require_institution_worker(p_worker_id,p_token);
  SELECT p.id,p.title,f.content_text,f.content_hash,f.sections,f.source_url INTO item
    FROM public.papers p JOIN public.paper_fulltexts f ON f.paper_id=p.id WHERE p.pmid=p_pmid AND f.status='ready' FOR UPDATE OF p,f;
  IF NOT FOUND THEN RETURN; END IF;
  expected_hash=encode(sha256(convert_to('fulltext'||chr(10)||item.title||chr(10)||item.content_text,'UTF8')),'hex');
  IF p_content_hash IS DISTINCT FROM encode(sha256(convert_to(item.content_text,'UTF8')),'hex') OR p_source_hash IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION 'Archive copy does not match current body' USING ERRCODE='23514'; END IF;
  INSERT INTO app_private.local_fulltext_sources(paper_id,worker_id,title,content_hash,summary_source_hash,characters,section_count,source_url)
    VALUES(item.id,p_worker_id,item.title,p_content_hash,expected_hash,length(item.content_text),greatest(jsonb_array_length(item.sections),1),item.source_url)
    ON CONFLICT(paper_id) DO UPDATE SET worker_id=excluded.worker_id,title=excluded.title,content_hash=excluded.content_hash,
      summary_source_hash=excluded.summary_source_hash,characters=excluded.characters,section_count=excluded.section_count,source_url=excluded.source_url,verified_at=now();
  UPDATE public.papers SET fulltext_storage='z8' WHERE id=item.id;
  DELETE FROM public.paper_fulltexts WHERE paper_id=item.id;
END;
$$;
REVOKE ALL ON FUNCTION public.institution_cloud_archive(uuid,text),public.confirm_local_fulltext_archive(uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.institution_cloud_archive(uuid,text),public.confirm_local_fulltext_archive(uuid,text,text,text,text) TO anon,authenticated;

CREATE FUNCTION app_private.reject_cloud_fulltext_write()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.status='ready' OR NEW.content_text IS NOT NULL THEN
    RAISE EXCEPTION 'Original bodies are stored on Z8; publish summary metadata instead' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_cloud_fulltext_write BEFORE INSERT OR UPDATE ON public.paper_fulltexts
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_cloud_fulltext_write();
REVOKE ALL ON FUNCTION app_private.reject_cloud_fulltext_write() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.fulltext_queue_status()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'ready_summaries',(SELECT count(*) FROM public.papers WHERE summary_basis='fulltext' AND summary_source_hash IS NOT NULL AND summarized_at IS NOT NULL),
    'local_bodies',(SELECT count(*) FROM app_private.local_fulltext_sources),
    'cloud_bodies',(SELECT count(*) FROM public.paper_fulltexts WHERE status='ready'),
    'workers',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',name,'state',state,'last_seen_at',last_seen_at)),'[]') FROM app_private.institution_workers WHERE enabled),
    'attempts',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM (SELECT status,count(*) n FROM app_private.institution_attempts GROUP BY status) a));
$$;
REVOKE ALL ON FUNCTION public.fulltext_queue_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fulltext_queue_status() TO service_role;
COMMIT;
