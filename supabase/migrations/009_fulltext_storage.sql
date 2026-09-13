BEGIN;
CREATE FUNCTION public.store_paper_fulltext(p_paper_id bigint, p_document jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF (p_document->>'content_text') IS NULL OR length(p_document->>'content_text') NOT BETWEEN 500 AND 600000
     OR (p_document->>'content_hash') IS NULL OR (p_document->>'content_hash') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid full text' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.paper_fulltexts(paper_id, status, source, source_url, license, content_hash, content_text, sections)
    VALUES (p_paper_id, 'ready', p_document->>'source', p_document->>'source_url', p_document->>'license',
      p_document->>'content_hash', p_document->>'content_text', p_document->'sections')
    ON CONFLICT (paper_id) DO UPDATE SET status = 'ready', source = EXCLUDED.source,
      source_url = EXCLUDED.source_url, license = EXCLUDED.license, content_hash = EXCLUDED.content_hash,
      content_text = EXCLUDED.content_text, sections = EXCLUDED.sections, error = NULL, fetched_at = now();
  UPDATE public.papers SET fulltext_available = true WHERE id = p_paper_id;
END;
$$;
REVOKE ALL ON FUNCTION public.store_paper_fulltext(bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_paper_fulltext(bigint, jsonb) TO service_role;
COMMIT;
