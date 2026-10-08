-- Preserve explicit original-reference identifiers when PubMed metadata is partial.
BEGIN;
CREATE OR REPLACE FUNCTION public.knowledge_network(p_filters jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE f jsonb=coalesce(p_filters,'{}'); yr1 int=coalesce((f->>'from')::int,2000); yr2 int=coalesce((f->>'to')::int,2100);
 lim int=coalesce((f->>'limit')::int,60); pg int=coalesce((f->>'page')::int,0); minimum int=coalesce((f->>'min_shared')::int,1);
 rel text=coalesce(f->>'relation','concepts'); focus text=f->>'focus'; peer text=f->>'peer'; answer jsonb;
BEGIN
 PERFORM app_private.knowledge_reader();
 IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR f-ARRAY['q','from','to','journal','design','focus','peer','relation','min_shared','limit','page']<>'{}'
  OR yr1 NOT BETWEEN 2000 AND 2100 OR yr2 NOT BETWEEN yr1 AND 2100 OR lim NOT BETWEEN 10 AND 100 OR pg NOT BETWEEN 0 AND 10000
  OR minimum NOT BETWEEN 1 AND 1000 OR rel NOT IN ('concepts','citations') OR (peer IS NOT NULL AND focus IS NULL)
  OR length(coalesce(f->>'q',''))>200 OR length(coalesce(f->>'journal',''))>500 OR length(coalesce(f->>'design',''))>100
  OR (focus IS NOT NULL AND focus !~ '^([0-9a-f]{24}|[0-9]{1,12})$') OR (peer IS NOT NULL AND peer !~ '^([0-9a-f]{24}|[0-9]{1,12})$') THEN
  RAISE EXCEPTION 'Invalid network filters' USING ERRCODE='22023'; END IF;
 IF rel='concepts' THEN
  focus=coalesce((SELECT t.entity_id FROM app_private.knowledge_entity_terms t WHERE t.concept_id=focus OR t.entity_id=focus LIMIT 1),focus);
  peer=coalesce((SELECT t.entity_id FROM app_private.knowledge_entity_terms t WHERE t.concept_id=peer OR t.entity_id=peer LIMIT 1),peer);
 END IF;
 WITH all_docs AS MATERIALIZED (
  SELECT p.id,p.pmid,p.title,p.authors,p.doi,p.journal,p.pub_date,p.study_type,d.content_hash,d.updated_at,
   s.paper_id IS NOT NULL structured,
   coalesce((SELECT jsonb_agg(ref) FROM (
    SELECT DISTINCT ON (coalesce(ref->>'pmid',lower(ref->>'doi'))) ref
    FROM jsonb_array_elements(coalesce(b.references_data,'[]'::jsonb)||coalesce(s.payload->'bibliography'->'references','[]'::jsonb)) ref
    WHERE ref->>'pmid' IS NOT NULL OR ref->>'doi' IS NOT NULL
    ORDER BY coalesce(ref->>'pmid',lower(ref->>'doi')),(ref->>'doi' IS NOT NULL) DESC,ref->>'source_id'
   ) identified),'[]'::jsonb) refs,
   (b.paper_id IS NOT NULL OR coalesce(s.payload->'bibliography'->>'source'='PubMed',false)) metadata_available
  FROM app_private.knowledge_documents d JOIN public.papers p ON p.id=d.paper_id
  LEFT JOIN app_private.knowledge_science s ON s.paper_id=p.id AND s.content_hash=d.content_hash
  LEFT JOIN app_private.knowledge_bibliographies b ON b.paper_id=p.id AND b.content_hash=d.content_hash
  WHERE p.integrity_status='current' AND p.pub_date>='2000-01-01'
 ), matched AS MATERIALIZED (
  SELECT * FROM all_docs p WHERE pub_date>=make_date(yr1,1,1) AND pub_date<make_date(yr2+1,1,1)
   AND (coalesce(f->>'journal','')='' OR journal=f->>'journal') AND (coalesce(f->>'design','')='' OR study_type=f->>'design')
   AND (coalesce(f->>'q','')='' OR pmid=f->>'q' OR lower(doi)=lower(f->>'q') OR position(lower(f->>'q') in lower(title))>0
    OR EXISTS(SELECT 1 FROM app_private.knowledge_memberships m JOIN app_private.knowledge_entity_terms t ON t.concept_id=m.concept_id
      WHERE m.paper_id=p.id AND position(lower(f->>'q') in lower(t.label||' '||t.source_label||' '||t.aliases::text))>0))
 ), memberships AS MATERIALIZED (
  SELECT DISTINCT m.paper_id,t.entity_id FROM app_private.knowledge_memberships m JOIN matched p ON p.id=m.paper_id
    JOIN app_private.knowledge_entity_terms t ON t.concept_id=m.concept_id
 ), entities AS MATERIALIZED (
  SELECT t.entity_id id,min(t.label) label,min(t.category) kind,min(t.resolution) resolution,
    min(t.concept_ui) concept_ui,min(t.vocabulary_year) vocabulary_year,
    count(DISTINCT m.paper_id) document_count,max(p.pub_date) latest_publication,
    jsonb_agg(DISTINCT t.source_label) source_labels,jsonb_agg(DISTINCT t.concept_id) concept_ids
  FROM app_private.knowledge_entity_terms t JOIN app_private.knowledge_memberships m ON m.concept_id=t.concept_id
   JOIN matched p ON p.id=m.paper_id GROUP BY t.entity_id
 ), top_entities AS MATERIALIZED (
  SELECT * FROM entities ORDER BY (id=focus OR id=peer) DESC NULLS LAST,document_count DESC,label COLLATE "C",id LIMIT lim
 ), limited_members AS MATERIALIZED (
  SELECT m.* FROM memberships m JOIN top_entities n ON n.id=m.entity_id
 ), pairs AS MATERIALIZED (
  SELECT a.entity_id source,b.entity_id target,count(*)::int weight FROM limited_members a JOIN limited_members b
   ON a.paper_id=b.paper_id AND a.entity_id<b.entity_id GROUP BY a.entity_id,b.entity_id
 ), concept_edges AS MATERIALIZED (
  SELECT p.*,p.weight::numeric/(a.document_count+b.document_count-p.weight) jaccard,
   a.document_count source_papers,b.document_count target_papers FROM pairs p
   JOIN top_entities a ON a.id=p.source JOIN top_entities b ON b.id=p.target WHERE p.weight>=minimum
  ORDER BY p.weight DESC,a.label COLLATE "C",b.label COLLATE "C" LIMIT 500
 ), citation_nodes AS MATERIALIZED (
  SELECT p.* FROM matched p ORDER BY (p.pmid=focus OR p.pmid=peer) DESC NULLS LAST,p.pub_date DESC,p.id DESC LIMIT lim
 ), citation_edges AS MATERIALIZED (
  SELECT DISTINCT a.pmid source,b.pmid target,1 weight FROM citation_nodes a
    CROSS JOIN LATERAL jsonb_array_elements(a.refs) r JOIN citation_nodes b ON b.pmid=r->>'pmid'
     OR (r->>'doi' IS NOT NULL AND lower(b.doi)=lower(r->>'doi')) WHERE a.id<>b.id
 ), selected AS MATERIALIZED (
  SELECT p.* FROM matched p WHERE focus IS NULL OR
   (rel='concepts' AND EXISTS(SELECT 1 FROM memberships m WHERE m.paper_id=p.id AND m.entity_id=focus)
     AND (peer IS NULL OR EXISTS(SELECT 1 FROM memberships m WHERE m.paper_id=p.id AND m.entity_id=peer))) OR
   (rel='citations' AND (p.pmid=focus OR p.pmid=peer))
 ), shown_papers AS (
  SELECT * FROM selected ORDER BY pub_date DESC,id DESC LIMIT 21 OFFSET pg*20
 ), notes AS (
  SELECT t.concept_id,t.source_label FROM app_private.knowledge_entity_terms t JOIN app_private.knowledge_pages p ON p.concept_id=t.concept_id
  WHERE t.entity_id=focus AND NOT p.stale AND p.version='corpus-v1-en' ORDER BY p.updated_at DESC,t.concept_id LIMIT 3
 )
 SELECT jsonb_build_object(
  'relationship',rel,'filters',f,'focus',focus,'peer',peer,'updated_at',(SELECT max(updated_at) FROM all_docs),
  'indexed_documents',(SELECT count(*) FROM all_docs),'matched_documents',(SELECT count(*) FROM matched),
  'selected_documents',(SELECT count(*) FROM selected),'structured_documents',(SELECT count(*) FROM matched WHERE structured),
  'nodes',CASE WHEN rel='concepts' THEN coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY document_count DESC,label) FROM top_entities n),'[]')
   ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('id',pmid,'label',title,'kind','paper','document_count',1,'year',extract(year FROM pub_date),'metadata_available',metadata_available) ORDER BY pub_date DESC,id DESC) FROM citation_nodes),'[]') END,
  'edges',CASE WHEN rel='concepts' THEN coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY weight DESC,source,target) FROM concept_edges e),'[]')
   ELSE coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY source,target) FROM citation_edges e),'[]') END,
  'coverage',jsonb_build_object('concepts',(SELECT count(*) FROM entities),'resolved',(SELECT count(*) FROM entities WHERE resolution='exact'),
   'node_limit',lim,'edge_limit',500,'minimum_shared',minimum,'pairs_in_node_selection',(SELECT count(*) FROM pairs),
   'links_at_threshold',(SELECT count(*) FROM pairs WHERE weight>=minimum),'single_paper_pairs',(SELECT count(*) FROM pairs WHERE weight=1),
   'metadata_papers',(SELECT count(*) FROM matched WHERE metadata_available),'papers_with_reference_ids',(SELECT count(*) FROM matched WHERE jsonb_array_length(refs)>0),
   'reference_identifiers',(SELECT coalesce(sum(jsonb_array_length(refs)),0) FROM matched)),
  'selection',CASE WHEN rel='concepts' THEN (SELECT to_jsonb(n) FROM entities n WHERE n.id=focus) ELSE NULL END,
  'selection_peer',CASE WHEN rel='concepts' THEN (SELECT to_jsonb(n) FROM entities n WHERE n.id=peer) ELSE NULL END,
  'notes',CASE WHEN rel='concepts' AND peer IS NULL THEN coalesce((SELECT jsonb_agg(jsonb_build_object('concept_id',concept_id,'label',source_label,'wiki',public.knowledge_page(concept_id)->'wiki')) FROM notes),'[]') ELSE '[]'::jsonb END,
  'papers',coalesce((SELECT jsonb_agg(to_jsonb(p)-ARRAY['id','refs','metadata_available'] ORDER BY pub_date DESC,id DESC) FROM shown_papers p),'[]'),
  'years',coalesce((SELECT jsonb_agg(to_jsonb(y) ORDER BY year) FROM (SELECT extract(year FROM pub_date)::int AS year,count(*) papers,count(*) FILTER(WHERE structured) structured FROM matched GROUP BY 1) y),'[]'),
  'journals',coalesce((SELECT jsonb_agg(to_jsonb(j) ORDER BY papers DESC,label) FROM (SELECT journal label,count(*) papers FROM all_docs WHERE coalesce(journal,'')<>'' GROUP BY journal) j),'[]'),
  'designs',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY papers DESC,label) FROM (SELECT study_type label,count(*) papers FROM all_docs WHERE coalesce(study_type,'')<>'' GROUP BY study_type) s),'[]')
 ) INTO answer;
 RETURN answer;
END; $$;
COMMIT;
