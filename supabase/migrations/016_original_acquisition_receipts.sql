-- Record a verified acquisition before inference; no original body is accepted.
BEGIN;
CREATE FUNCTION public.register_institution_original(
  p_worker_id uuid,p_token text,p_pmid text,p_doi text,p_title text,p_source jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE paper_key bigint;
BEGIN
  PERFORM app_private.require_institution_worker(p_worker_id,p_token);
  SELECT id INTO STRICT paper_key FROM public.papers
    WHERE pmid=p_pmid AND nullif(lower(doi),'') IS NOT DISTINCT FROM nullif(lower(p_doi),'') AND title=p_title FOR UPDATE;
  IF jsonb_typeof(p_source) IS DISTINCT FROM 'object'
    OR (p_source-ARRAY['content_hash','summary_source_hash','characters','section_count','source_url']) <> '{}'
    OR coalesce(p_source->>'content_hash','') !~ '^[0-9a-f]{64}$'
    OR coalesce(p_source->>'summary_source_hash','') !~ '^[0-9a-f]{64}$'
    OR coalesce((p_source->>'characters')::integer,0) NOT BETWEEN 2000 AND 600000
    OR coalesce((p_source->>'section_count')::integer,0) NOT BETWEEN 2 AND 1000
    OR coalesce(p_source->>'source_url','') !~ '^https://'
    OR length(p_source->>'source_url') > 1000 THEN
    RAISE EXCEPTION 'Invalid acquisition receipt' USING ERRCODE='22023';
  END IF;
  INSERT INTO app_private.local_fulltext_sources
    (paper_id,worker_id,title,content_hash,summary_source_hash,characters,section_count,source_url)
  VALUES(paper_key,p_worker_id,p_title,p_source->>'content_hash',p_source->>'summary_source_hash',
    (p_source->>'characters')::integer,(p_source->>'section_count')::integer,p_source->>'source_url')
  ON CONFLICT(paper_id) DO UPDATE SET worker_id=excluded.worker_id,title=excluded.title,
    content_hash=excluded.content_hash,summary_source_hash=excluded.summary_source_hash,
    characters=excluded.characters,section_count=excluded.section_count,source_url=excluded.source_url,
    verified_at=now()
  WHERE (local_fulltext_sources.worker_id,local_fulltext_sources.title,local_fulltext_sources.content_hash)
    IS DISTINCT FROM (excluded.worker_id,excluded.title,excluded.content_hash);
  UPDATE public.papers SET fulltext_available=true,fulltext_storage='z8',
    summary_source_hash=CASE WHEN summary_basis='fulltext' AND summary_source_hash IS DISTINCT FROM p_source->>'summary_source_hash'
      THEN NULL ELSE summary_source_hash END,
    summarized_at=CASE WHEN summary_basis='fulltext' AND summary_source_hash IS DISTINCT FROM p_source->>'summary_source_hash'
      THEN NULL ELSE summarized_at END
  WHERE id=paper_key AND (NOT fulltext_available OR fulltext_storage IS DISTINCT FROM 'z8'
    OR (summary_basis='fulltext' AND summary_source_hash IS NOT NULL
      AND summary_source_hash IS DISTINCT FROM p_source->>'summary_source_hash'));
  UPDATE app_private.institution_workers SET last_seen_at=now() WHERE id=p_worker_id;
END;
$$;
REVOKE ALL ON FUNCTION public.register_institution_original(uuid,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_institution_original(uuid,text,text,text,text,jsonb) TO anon,authenticated;
COMMIT;
