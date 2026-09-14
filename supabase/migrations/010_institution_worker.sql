BEGIN;
CREATE TABLE app_private.institution_workers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  enabled boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  state text NOT NULL DEFAULT 'registered' CHECK (state IN ('registered','running','idle','error'))
);
CREATE TABLE app_private.institution_attempts (
  worker_id uuid REFERENCES app_private.institution_workers(id) ON DELETE CASCADE,
  paper_id bigint REFERENCES public.papers(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ready','access_required','challenge','unsupported','parse_failed','retryable_error')),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(worker_id,paper_id)
);
ALTER TABLE app_private.institution_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.institution_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.institution_workers, app_private.institution_attempts FROM PUBLIC, anon, authenticated;

CREATE FUNCTION app_private.require_institution_worker(p_id uuid, p_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_token IS NULL OR length(p_token) NOT BETWEEN 40 AND 100 OR NOT EXISTS (
    SELECT 1 FROM app_private.institution_workers w WHERE w.id=p_id AND w.enabled
      AND w.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')
  ) THEN RAISE EXCEPTION 'Worker authentication required' USING ERRCODE='42501'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION app_private.require_institution_worker(uuid,text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.institution_worker_status(p_worker_id uuid, p_token text, p_state text,
  p_pmid text DEFAULT NULL, p_status text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE paper_key bigint;
BEGIN
  PERFORM app_private.require_institution_worker(p_worker_id,p_token);
  IF p_state NOT IN ('running','idle','error') OR p_state IS NULL THEN
    RAISE EXCEPTION 'Invalid state' USING ERRCODE='22023'; END IF;
  UPDATE app_private.institution_workers SET last_seen_at=now(),state=p_state WHERE id=p_worker_id;
  IF p_pmid IS NOT NULL THEN
    IF p_status IS NULL OR p_status NOT IN ('access_required','challenge','unsupported','parse_failed','retryable_error') THEN
      RAISE EXCEPTION 'Invalid attempt status' USING ERRCODE='22023'; END IF;
    SELECT id INTO STRICT paper_key FROM public.papers WHERE pmid=p_pmid;
    INSERT INTO app_private.institution_attempts(worker_id,paper_id,status)
      VALUES(p_worker_id,paper_key,p_status) ON CONFLICT(worker_id,paper_id)
      DO UPDATE SET status=excluded.status,attempted_at=now();
  END IF;
END;
$$;

CREATE FUNCTION public.publish_institution_fulltext(p_worker_id uuid,p_token text,p_pmid text,p_doi text,p_document jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE paper_key bigint; stored integer;
BEGIN
  PERFORM app_private.require_institution_worker(p_worker_id,p_token);
  SELECT id INTO STRICT paper_key FROM public.papers WHERE pmid=p_pmid AND lower(doi)=lower(p_doi);
  IF p_document->>'content_text' IS NULL OR length(p_document->>'content_text') NOT BETWEEN 2000 AND 600000
    OR p_document->>'content_hash' IS DISTINCT FROM encode(sha256(convert_to(p_document->>'content_text','UTF8')),'hex')
    OR coalesce(p_document->>'source_url','') !~ '^https://(www\.sciencedirect\.com|sciencedirect\.com|link\.springer\.com|www\.nature\.com|nature\.com|([a-z0-9-]+\.)?onlinelibrary\.wiley\.com|jamanetwork\.com|www\.bmj\.com)/'
    OR jsonb_typeof(p_document->'sections') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid institution document' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.paper_fulltexts(paper_id,status,source,source_url,license,content_hash,content_text,sections)
    VALUES(paper_key,'ready','institution_browser',p_document->>'source_url',p_document->>'license',
      p_document->>'content_hash',p_document->>'content_text',p_document->'sections')
    ON CONFLICT(paper_id) DO UPDATE SET status='ready',source=excluded.source,source_url=excluded.source_url,
      license=excluded.license,content_hash=excluded.content_hash,content_text=excluded.content_text,
      sections=excluded.sections,error=NULL,fetched_at=now()
    WHERE public.paper_fulltexts.status<>'ready';
  GET DIAGNOSTICS stored=ROW_COUNT;
  INSERT INTO app_private.institution_attempts(worker_id,paper_id,status) VALUES(p_worker_id,paper_key,'ready')
    ON CONFLICT(worker_id,paper_id) DO UPDATE SET status='ready',attempted_at=now();
  UPDATE app_private.institution_workers SET last_seen_at=now(),state='running' WHERE id=p_worker_id;
  RETURN stored=1;
END;
$$;
REVOKE ALL ON FUNCTION public.institution_worker_status(uuid,text,text,text,text),
  public.publish_institution_fulltext(uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.institution_worker_status(uuid,text,text,text,text),
  public.publish_institution_fulltext(uuid,text,text,text,jsonb) TO anon,authenticated;

-- Every import route invalidates a summary when its underlying body changes.
CREATE FUNCTION app_private.invalidate_body_summary()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE public.papers SET fulltext_available=false,summary_source_hash=NULL,summarized_at=NULL WHERE id=OLD.paper_id;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.papers SET fulltext_available=(NEW.status='ready'),summary_source_hash=NULL,summarized_at=NULL WHERE id=NEW.paper_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fulltext_summary_invalidation AFTER INSERT OR UPDATE OR DELETE ON public.paper_fulltexts
  FOR EACH ROW EXECUTE FUNCTION app_private.invalidate_body_summary();
REVOKE ALL ON FUNCTION app_private.invalidate_body_summary() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.check_summary_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE expected_hash text;
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title THEN NEW.summary_source_hash=NULL; NEW.summarized_at=NULL; END IF;
  IF NEW.summary_basis='fulltext' AND NEW.summary_source_hash IS NOT NULL THEN
    SELECT encode(sha256(convert_to('fulltext'||chr(10)||NEW.title||chr(10)||f.content_text,'UTF8')),'hex')
      INTO expected_hash FROM public.paper_fulltexts f WHERE f.paper_id=NEW.id AND f.status='ready';
    IF NEW.summary_source_hash IS DISTINCT FROM expected_hash THEN
      RAISE EXCEPTION 'Summary source changed; retry with current body' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_summary_source BEFORE UPDATE ON public.papers FOR EACH ROW EXECUTE FUNCTION app_private.check_summary_source();
REVOKE ALL ON FUNCTION app_private.check_summary_source() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.admin_fulltext_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app_private.require_admin();
  RETURN jsonb_build_object(
    'ready_bodies',(SELECT count(*) FROM public.paper_fulltexts WHERE status='ready'),
    'ready_summaries',(SELECT count(*) FROM public.papers WHERE summary_basis='fulltext' AND summary_source_hash IS NOT NULL AND summarized_at IS NOT NULL),
    'workers',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',name,'state',state,'last_seen_at',last_seen_at)),'[]') FROM app_private.institution_workers WHERE enabled),
    'attempts',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM (SELECT status,count(*) n FROM app_private.institution_attempts GROUP BY status) a));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_fulltext_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_fulltext_status() TO authenticated;
COMMIT;
