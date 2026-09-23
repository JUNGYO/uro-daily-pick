BEGIN;
CREATE OR REPLACE FUNCTION public.project_recommendations(p_id bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE kw text[];
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 SELECT keywords INTO kw FROM public.collections WHERE id=p_id;
 -- A new project has no recommendation query. Do not scan the full catalog.
 IF NOT EXISTS(SELECT 1 FROM unnest(kw) k WHERE length(btrim(k))>0) THEN RETURN '[]'::jsonb; END IF;
 RETURN (SELECT coalesce(jsonb_agg(public.reader_card(p)),'[]') FROM (SELECT p.* FROM public.papers p WHERE p.pub_date>='2000-01-01'
 AND p.integrity_status<>'retracted' AND EXISTS(SELECT 1 FROM unnest(kw) k WHERE p.search_vector@@plainto_tsquery('english',k))
 AND NOT EXISTS(SELECT 1 FROM public.collection_papers cp WHERE cp.collection_id=p_id AND cp.paper_id=p.id)
 ORDER BY p.pub_date DESC,p.id DESC LIMIT 10) p);
END;
$$;
COMMIT;
