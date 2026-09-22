-- Bounded, source-validated metadata publication. Original bytes are never accepted.
BEGIN;
CREATE FUNCTION public.sync_institution_events(p_worker_id uuid,p_token text,p_events jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE event jsonb; payload jsonb; receipt jsonb; receipts jsonb='[]'; source_doi text;
BEGIN
  PERFORM app_private.require_institution_worker(p_worker_id,p_token);
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 25
    OR octet_length(p_events::text)>1000000 THEN
    RAISE EXCEPTION 'Invalid publication batch' USING ERRCODE='22023';
  END IF;
  FOR event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    IF jsonb_typeof(event) IS DISTINCT FROM 'object' OR event-ARRAY['pmid','kind','version','payload']<>'{}'
      OR coalesce(event->>'pmid','') !~ '^[0-9]{1,12}$'
      OR coalesce(event->>'kind','') NOT IN ('original','summary')
      OR jsonb_typeof(event->'version') IS DISTINCT FROM 'number'
      OR coalesce(event->>'version','') !~ '^[1-9][0-9]{0,14}$' THEN
      RAISE EXCEPTION 'Invalid publication identity' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_events) e GROUP BY e->>'pmid',e->>'kind' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Duplicate publication identity' USING ERRCODE='22023';
  END IF;
  FOR event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    receipt=jsonb_build_object('pmid',event->>'pmid','kind',event->>'kind','version',event->'version');
    payload=event->'payload';
    BEGIN
      IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload->>'p_pmid' IS DISTINCT FROM event->>'pmid'
        OR NOT payload ?& ARRAY['p_pmid','p_doi','p_title','p_source']
        OR (event->>'kind'='original' AND payload-ARRAY['p_pmid','p_doi','p_title','p_source']<>'{}')
        OR (event->>'kind'='summary' AND (NOT payload?'p_summary'
          OR payload-ARRAY['p_pmid','p_doi','p_title','p_source','p_summary']<>'{}')) THEN
        RAISE EXCEPTION 'Invalid publication fields' USING ERRCODE='22023';
      END IF;
      IF event->>'kind'='original' THEN
        PERFORM public.register_institution_original(p_worker_id,p_token,payload->>'p_pmid',payload->>'p_doi',payload->>'p_title',payload->'p_source');
      ELSE
        -- Legacy citations store missing DOI as either NULL or an empty string.
        SELECT doi INTO STRICT source_doi FROM public.papers WHERE pmid=payload->>'p_pmid'
          AND title=payload->>'p_title'
          AND nullif(lower(doi),'') IS NOT DISTINCT FROM nullif(lower(payload->>'p_doi'),'') FOR UPDATE;
        PERFORM public.publish_institution_summary(p_worker_id,p_token,payload->>'p_pmid',source_doi,payload->>'p_title',payload->'p_source',payload->'p_summary');
      END IF;
      receipts=receipts||jsonb_build_array(receipt||jsonb_build_object('status','accepted'));
    EXCEPTION WHEN data_exception OR no_data_found OR raise_exception OR check_violation THEN
      -- Only known validation errors are isolated. Timeouts, authorization and
      -- database failures abort the transaction and remain safely replayable.
      receipts=receipts||jsonb_build_array(receipt||jsonb_build_object('status','rejected'));
    END;
  END LOOP;
  RETURN receipts;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_institution_events(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_institution_events(uuid,text,jsonb) TO anon,authenticated;
COMMIT;
