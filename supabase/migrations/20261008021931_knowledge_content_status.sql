-- Distinguish an indexed concept without narrative findings from ongoing generation.
BEGIN;
CREATE OR REPLACE FUNCTION public.knowledge_search(p_query text DEFAULT '',p_pmid text DEFAULT NULL,p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='5s' AS $$
DECLARE q text=lower(trim(coalesce(p_query,''))); result jsonb;
BEGIN
 PERFORM app_private.knowledge_reader();
 IF length(q)>200 OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 1000 THEN RAISE EXCEPTION 'Invalid search'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM (
   SELECT c.*,CASE WHEN w.stale=false AND jsonb_array_length(w.paragraphs)>0 THEN 'ready' WHEN w.stale=false AND jsonb_array_length(w.paragraphs)=0 THEN 'indexed' ELSE 'building' END AS status
   FROM app_private.knowledge_concepts c LEFT JOIN app_private.knowledge_pages w ON w.concept_id=c.id
   WHERE c.document_count>0 AND (q='' OR position(q in lower(c.label||' '||c.label_ko||' '||c.aliases::text))>0)
     AND (p_pmid IS NULL OR EXISTS(SELECT 1 FROM app_private.knowledge_memberships m JOIN public.papers p ON p.id=m.paper_id WHERE m.concept_id=c.id AND p.pmid=p_pmid))
   ORDER BY c.document_count DESC,c.id LIMIT 21 OFFSET p_page*20) x;
 RETURN jsonb_build_object('items',result,'indexed_documents',(SELECT count(*) FROM app_private.knowledge_documents),
   'updated_at',(SELECT max(updated_at) FROM app_private.knowledge_documents));
END; $$;

CREATE OR REPLACE FUNCTION public.knowledge_page(p_id text,p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='5s' AS $$
DECLARE concept jsonb; wiki jsonb; papers jsonb; neighbors jsonb;
BEGIN
 PERFORM app_private.knowledge_reader();
 IF p_page IS NULL OR p_page NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'Invalid page'; END IF;
 SELECT to_jsonb(c) INTO concept FROM app_private.knowledge_concepts c WHERE c.id=p_id AND document_count>0;
 IF concept IS NULL THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('revision',revision,'updated_at',updated_at,'status',CASE WHEN stale THEN 'updating' WHEN jsonb_array_length(paragraphs)=0 THEN 'indexed' ELSE 'ready' END,
   'paragraphs',CASE WHEN stale THEN '[]'::jsonb ELSE paragraphs END) INTO wiki FROM app_private.knowledge_pages WHERE concept_id=p_id;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO papers FROM (
   SELECT p.pmid,p.title,p.journal,p.pub_date,d.content_hash FROM app_private.knowledge_memberships m
   JOIN public.papers p ON p.id=m.paper_id JOIN app_private.knowledge_documents d ON d.paper_id=p.id
   WHERE m.concept_id=p_id ORDER BY p.pub_date DESC,p.id DESC LIMIT 21 OFFSET p_page*20) x;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO neighbors FROM (
   SELECT c.id,c.label,c.label_ko,c.kind,count(*) AS shared_papers FROM app_private.knowledge_memberships a
   JOIN app_private.knowledge_memberships b ON b.paper_id=a.paper_id AND b.concept_id<>a.concept_id
   JOIN app_private.knowledge_concepts c ON c.id=b.concept_id WHERE a.concept_id=p_id
   GROUP BY c.id ORDER BY count(*) DESC,c.id LIMIT 12) x;
 RETURN jsonb_build_object('concept',concept,'wiki',wiki,'papers',papers,'neighbors',neighbors);
END; $$;
COMMIT;
