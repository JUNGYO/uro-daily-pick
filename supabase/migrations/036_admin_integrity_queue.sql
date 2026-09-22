BEGIN;
-- Only the small pending-notice set is read by the administrative queue.
CREATE INDEX IF NOT EXISTS papers_pending_integrity_idx ON public.papers(integrity_status,id DESC)
 WHERE summary_review_required AND integrity_status IN ('corrected','concern','retracted');
CREATE OR REPLACE FUNCTION public.admin_integrity_queue(p_status text DEFAULT 'all',p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE counts jsonb; items jsonb; total bigint; page integer;
BEGIN
 PERFORM app_private.require_admin();
 IF p_status IS NULL OR p_status NOT IN ('all','corrected','concern','retracted') THEN
  RAISE EXCEPTION 'Invalid notice filter' USING ERRCODE='22023';
 END IF;
 SELECT jsonb_build_object('total',count(*),
  'corrected',count(*) FILTER(WHERE integrity_status='corrected'),
  'concern',count(*) FILTER(WHERE integrity_status='concern'),
  'retracted',count(*) FILTER(WHERE integrity_status='retracted')) INTO counts
 FROM public.papers WHERE summary_review_required AND integrity_status IN ('corrected','concern','retracted');
 total=(counts->>CASE WHEN p_status='all' THEN 'total' ELSE p_status END)::bigint;
 page=least(greatest(coalesce(p_page,0),0),greatest((total-1)/10,0)::integer);
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.priority,t.id DESC),'[]'::jsonb) INTO items FROM (
  SELECT id,pmid,title,integrity_status,related_notices,summary_source_hash,
   CASE integrity_status WHEN 'retracted' THEN 0 WHEN 'concern' THEN 1 ELSE 2 END AS priority
  FROM public.papers WHERE summary_review_required AND integrity_status IN ('corrected','concern','retracted')
   AND (p_status='all' OR integrity_status=p_status)
  ORDER BY priority,id DESC LIMIT 10 OFFSET page*10
 ) t;
 RETURN jsonb_build_object('counts',counts,'total',total,'page',page,'page_size',10,'items',items);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_integrity_queue(text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_integrity_queue(text,integer) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
