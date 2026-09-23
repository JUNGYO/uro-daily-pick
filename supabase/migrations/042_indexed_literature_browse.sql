-- Default browse previously read the wide catalog heap and ranked every match
-- before returning 20 cards. Keep exact totals, filters, ordering and RLS.
BEGIN;
SET LOCAL lock_timeout='3s';
-- Production may prebuild this exact index CONCURRENTLY to keep ingestion live.
CREATE INDEX IF NOT EXISTS papers_search_browse ON public.papers(pub_date DESC,id DESC) INCLUDE(integrity_status);
-- Custom planning removes inactive full-text/summary predicates, making the
-- narrow index eligible for default/date-only browsing even on pooled sessions.
CREATE OR REPLACE FUNCTION public.search_papers_v2(
  p_query text DEFAULT '',p_from date DEFAULT '2000-01-01',p_to date DEFAULT '3000-12-31',
  p_journal text DEFAULT '',p_type text DEFAULT '',p_state text DEFAULT 'all',
  p_sort text DEFAULT 'recent',p_page integer DEFAULT 0,p_saved boolean DEFAULT false,
  p_integrity text DEFAULT 'current')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' SET plan_cache_mode='force_custom_plan' AS $$
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
  ), page AS MATERIALIZED (
    SELECT id,pub_date,rank FROM matches ORDER BY CASE WHEN p_sort='relevance' THEN rank END DESC,
      CASE WHEN p_sort='oldest' THEN pub_date END ASC,
      CASE WHEN p_sort<>'oldest' THEN pub_date END DESC,id DESC LIMIT 20 OFFSET p_page*20
  ), ordered_page AS (
    SELECT id,row_number() OVER(ORDER BY CASE WHEN p_sort='relevance' THEN rank END DESC,
      CASE WHEN p_sort='oldest' THEN pub_date END ASC,
      CASE WHEN p_sort<>'oldest' THEN pub_date END DESC,id DESC) ordinal FROM page
  )
  SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(public.reader_card(p) ORDER BY page.ordinal)
    FROM ordered_page page JOIN public.papers p ON p.id=page.id),'[]'),'total',(SELECT count(*) FROM matches),'page',p_page)
  INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.search_papers_v2(text,date,date,text,text,text,text,integer,boolean,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_papers_v2(text,date,date,text,text,text,text,integer,boolean,text) TO authenticated;


COMMIT;
