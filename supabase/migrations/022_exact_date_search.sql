BEGIN;

-- Keep search_papers for older deployed clients while new readers use exact dates.
-- Reuse existing publication-date, text-search and identifier indexes. Add no
-- catalog index without measured need: the production storage budget is bounded.

CREATE OR REPLACE FUNCTION public.search_papers_v2(
  p_query text DEFAULT '',p_from date DEFAULT '2000-01-01',p_to date DEFAULT '3000-12-31',
  p_journal text DEFAULT '',p_type text DEFAULT '',p_state text DEFAULT 'all',
  p_sort text DEFAULT 'recent',p_page integer DEFAULT 0,p_saved boolean DEFAULT false,
  p_integrity text DEFAULT 'current')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE result jsonb; q text=trim(coalesce(p_query,'')); tq tsquery; journal_names text[]='{}';
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
  IF length(q)>200 OR p_from IS NULL OR p_to IS NULL
    OR p_from<'2000-01-01' OR p_to>'3000-12-31' OR p_from>p_to
    OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 10000 OR p_saved IS NULL
    OR p_journal IS NULL OR length(p_journal)>300 OR p_type IS NULL OR length(p_type)>100
    OR p_state IS NULL OR p_state NOT IN ('all','ready','pending')
    OR p_sort IS NULL OR p_sort NOT IN ('recent','oldest','relevance')
    OR p_integrity IS NULL OR p_integrity NOT IN ('current','all','retracted') THEN
    RAISE EXCEPTION 'Invalid search' USING ERRCODE='22023';
  END IF;
  q=regexp_replace(q,'^https?://(dx\.)?doi\.org/','','i');
  tq=websearch_to_tsquery('english',q);
  IF p_journal<>'' THEN
    -- Seek each distinct name through the existing (journal,fetched_at) index.
    -- A plain DISTINCT still chose a full heap scan in production; strict >
    -- advances past duplicate names without reading every citation. Exact ANY
    -- then permits indexed journal lookup instead of lower() over the heap.
    -- Do not apply dates to this dictionary: the main query applies exact dates
    -- before counting/paging and therefore still excludes historical-only rows.
    WITH RECURSIVE names(journal) AS (
      (SELECT p.journal FROM public.papers p WHERE p.journal IS NOT NULL ORDER BY p.journal LIMIT 1)
      UNION ALL
      SELECT (SELECT p.journal FROM public.papers p WHERE p.journal>n.journal ORDER BY p.journal LIMIT 1)
      FROM names n WHERE n.journal IS NOT NULL
    )
    SELECT coalesce(array_agg(n.journal),'{}') INTO journal_names FROM names n
      WHERE lower(n.journal)=lower(p_journal);
  END IF;
  WITH matches AS MATERIALIZED (
    SELECT p.id,p.pub_date,CASE WHEN q='' THEN 0 ELSE ts_rank(p.search_vector,tq) END rank
    FROM public.papers p
    WHERE p.pub_date>=p_from AND p.pub_date<=p_to AND p.pub_date>='2000-01-01'
      AND (q='' OR p.pmid=q OR lower(p.doi)=lower(q) OR p.search_vector@@tq)
      AND (p_journal='' OR p.journal=ANY(journal_names))
      AND (p_type='' OR p.study_type=p_type)
      AND (p_state='all' OR (p_state='ready')=coalesce(public.paper_ready(p),false))
      AND (p_integrity='all' OR (p_integrity='current' AND p.integrity_status<>'retracted')
        OR (p_integrity='retracted' AND p.integrity_status='retracted'))
      AND (NOT p_saved OR EXISTS(SELECT 1 FROM public.reader_states s
        WHERE s.paper_id=p.id AND s.user_id=auth.uid() AND s.saved))
  ), page AS (
    SELECT id,row_number() OVER(ORDER BY CASE WHEN p_sort='relevance' THEN rank END DESC,
      CASE WHEN p_sort='oldest' THEN pub_date END ASC,
      CASE WHEN p_sort<>'oldest' THEN pub_date END DESC,id DESC) ordinal
    FROM matches ORDER BY ordinal LIMIT 20 OFFSET p_page*20
  )
  SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(public.reader_card(p) ORDER BY page.ordinal)
    FROM page JOIN public.papers p ON p.id=page.id),'[]'),'total',(SELECT count(*) FROM matches),'page',p_page)
  INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.search_papers_v2(text,date,date,text,text,text,text,integer,boolean,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_papers_v2(text,date,date,text,text,text,text,integer,boolean,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.search_journals(p_query text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE q text=trim(coalesce(p_query,'')); result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
  IF length(q)>200 THEN RAISE EXCEPTION 'Invalid journal query' USING ERRCODE='22023'; END IF;
  -- Autocomplete needs names, not a count of every citation. Reuse the same
  -- narrow index seeks and check that each returned name has an eligible paper.
  WITH RECURSIVE names(journal) AS (
    (SELECT p.journal FROM public.papers p WHERE p.journal IS NOT NULL ORDER BY p.journal LIMIT 1)
    UNION ALL
    SELECT (SELECT p.journal FROM public.papers p WHERE p.journal>n.journal ORDER BY p.journal LIMIT 1)
    FROM names n WHERE n.journal IS NOT NULL
  )
  SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.name),'[]') INTO result
  FROM (
    SELECT n.journal name FROM names n
    WHERE btrim(n.journal)<>'' AND (q='' OR position(lower(q) IN lower(n.journal))>0)
      AND EXISTS(SELECT 1 FROM public.papers p WHERE p.journal=n.journal AND p.pub_date>='2000-01-01')
    ORDER BY n.journal LIMIT 30
  ) j;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.search_journals(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_journals(text) TO authenticated;

-- A malformed saved search must not prevent other saved searches from loading.
-- Exact dates take precedence; older saved year/until filters remain supported.
CREATE OR REPLACE FUNCTION public.search_notifications() RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE s record; result jsonb='[]'; date_from date; date_to date;
  filter_journal text; filter_type text; filter_state text; filter_integrity text; q text; valid boolean; found_count bigint;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
  FOR s IN SELECT * FROM public.saved_searches WHERE user_id=auth.uid() ORDER BY created_at DESC,id DESC LIMIT 50 LOOP
    date_from='2000-01-01'; date_to='3000-12-31'; valid=true; found_count=0;
    BEGIN
      IF coalesce(s.filters->>'from','')<>'' THEN
        IF jsonb_typeof(s.filters->'from')<>'string' OR s.filters->>'from' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
          valid=false;
        ELSE date_from=(s.filters->>'from')::date; END IF;
      ELSIF coalesce(s.filters->>'year','')<>'' THEN
        IF s.filters->>'year' !~ '^[0-9]{4}$' THEN valid=false;
        ELSE date_from=make_date((s.filters->>'year')::integer,1,1); END IF;
      END IF;
      IF coalesce(s.filters->>'to','')<>'' THEN
        IF jsonb_typeof(s.filters->'to')<>'string' OR s.filters->>'to' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
          valid=false;
        ELSE date_to=(s.filters->>'to')::date; END IF;
      ELSIF coalesce(s.filters->>'until','')<>'' THEN
        IF s.filters->>'until' !~ '^[0-9]{4}$' THEN valid=false;
        ELSE date_to=make_date((s.filters->>'until')::integer,12,31); END IF;
      END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation OR numeric_value_out_of_range THEN
      valid=false;
    END;
    filter_journal=coalesce(s.filters->>'journal',''); filter_type=coalesce(s.filters->>'type','');
    filter_state=coalesce(s.filters->>'state','all'); filter_integrity=coalesce(s.filters->>'integrity','current');
    q=regexp_replace(trim(s.query),'^https?://(dx\.)?doi\.org/','','i');
    valid=valid AND date_from>='2000-01-01' AND date_to<='3000-12-31' AND date_from<=date_to
      AND filter_state IN ('all','ready','pending') AND filter_integrity IN ('current','all','retracted')
      AND length(filter_journal)<=300 AND length(filter_type)<=100;
    IF valid AND s.enabled THEN
      SELECT count(*) INTO found_count FROM public.papers p
      WHERE p.pub_date>=date_from AND p.pub_date<=date_to
        AND (CASE WHEN filter_state='ready' THEN greatest(p.fetched_at,p.summarized_at) ELSE p.fetched_at END)>s.last_seen_at
        AND (q='' OR p.search_vector@@websearch_to_tsquery('english',q) OR p.pmid=q OR lower(p.doi)=lower(q))
        AND (filter_journal='' OR lower(p.journal)=lower(filter_journal)) AND (filter_type='' OR p.study_type=filter_type)
        AND (filter_state='all' OR (filter_state='ready')=coalesce(public.paper_ready(p),false))
        AND (filter_integrity='all' OR (filter_integrity='retracted' AND p.integrity_status='retracted')
          OR (filter_integrity='current' AND p.integrity_status<>'retracted'));
    END IF;
    result=result||jsonb_build_array(jsonb_build_object('id',s.id,'name',s.name,'query',s.query,
      'filters',s.filters,'last_seen_at',s.last_seen_at,'enabled',s.enabled,'new_count',found_count));
  END LOOP;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.search_notifications() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_notifications() TO authenticated;
COMMIT;
