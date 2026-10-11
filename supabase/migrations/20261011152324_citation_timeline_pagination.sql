-- Citation timeline: connected selection and scoped bibliographic metrics.
BEGIN;
CREATE OR REPLACE FUNCTION public.knowledge_network(p_filters jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE f jsonb=coalesce(p_filters,'{}'); yr1 int=coalesce((f->>'from')::int,2000); yr2 int=coalesce((f->>'to')::int,2100);
 lim int=coalesce((f->>'limit')::int,60); pg int=coalesce((f->>'page')::int,0); upg int=coalesce((f->>'unlinked_page')::int,0); minimum int=coalesce((f->>'min_shared')::int,1);
 rel text=coalesce(f->>'relation','concepts'); focus text=f->>'focus'; peer text=f->>'peer'; answer jsonb;
BEGIN
 PERFORM app_private.knowledge_reader();
 IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR f-ARRAY['q','from','to','journal','design','focus','peer','relation','min_shared','limit','page','unlinked_page']<>'{}'
  OR yr1 NOT BETWEEN 2000 AND 2100 OR yr2 NOT BETWEEN yr1 AND 2100 OR lim NOT BETWEEN 10 AND 100 OR pg NOT BETWEEN 0 AND 10000 OR upg NOT BETWEEN 0 AND 10000
  OR minimum NOT BETWEEN 1 AND 1000 OR rel NOT IN ('concepts','citations') OR (peer IS NOT NULL AND focus IS NULL)
  OR length(coalesce(f->>'q',''))>200 OR length(coalesce(f->>'journal',''))>500 OR length(coalesce(f->>'design',''))>100
  OR (focus IS NOT NULL AND focus !~ '^([0-9a-f]{24}|[0-9]{1,12})$') OR (peer IS NOT NULL AND peer !~ '^([0-9a-f]{24}|[0-9]{1,12})$') THEN
  RAISE EXCEPTION 'Invalid network filters' USING ERRCODE='22023'; END IF;
 IF rel='concepts' THEN
  focus=coalesce((SELECT min(t.entity_id) FROM app_private.knowledge_entity_memberships t WHERE t.concept_id=focus OR t.entity_id=focus HAVING count(DISTINCT t.entity_id)=1),focus);
  peer=coalesce((SELECT min(t.entity_id) FROM app_private.knowledge_entity_memberships t WHERE t.concept_id=peer OR t.entity_id=peer HAVING count(DISTINCT t.entity_id)=1),peer);
 END IF;
 WITH all_docs AS MATERIALIZED (
  SELECT p.id,p.pmid,p.title,p.authors,p.doi,p.journal,p.pub_date,p.study_type,p.integrity_status,d.content_hash,d.updated_at,
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
    OR EXISTS(SELECT 1 FROM app_private.knowledge_entity_memberships t WHERE t.paper_id=p.id AND position(lower(f->>'q') in lower(t.label||' '||t.source_label||' '||t.aliases::text))>0))
 ), memberships AS MATERIALIZED (
  SELECT DISTINCT t.paper_id,t.entity_id FROM app_private.knowledge_entity_memberships t JOIN matched p ON p.id=t.paper_id
 ), entities AS MATERIALIZED (
  SELECT t.entity_id id,min(t.label) label,min(t.category) kind,min(t.resolution) resolution,
    min(t.concept_ui) concept_ui,min(t.vocabulary_year) vocabulary_year,
    count(DISTINCT t.paper_id) document_count,max(p.pub_date) latest_publication,
    jsonb_agg(DISTINCT t.source_label) source_labels,jsonb_agg(DISTINCT t.concept_id) concept_ids
  FROM app_private.knowledge_entity_memberships t JOIN matched p ON p.id=t.paper_id GROUP BY t.entity_id
 ), top_entities AS MATERIALIZED (
  SELECT e.* FROM entities e ORDER BY (id=focus OR id=peer) DESC NULLS LAST,
   CASE WHEN focus IS NOT NULL THEN (SELECT count(*) FROM memberships a JOIN memberships b ON b.paper_id=a.paper_id
     WHERE a.entity_id=focus AND b.entity_id=e.id) ELSE 0 END DESC,
   document_count DESC,label COLLATE "C",id LIMIT lim
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
 ), reference_rows AS MATERIALIZED (
  SELECT p.pmid source,r FROM matched p CROSS JOIN LATERAL jsonb_array_elements(p.refs) r
  WHERE rel='citations'
 ), reference_targets AS MATERIALIZED (
  SELECT a.source,coalesce(c.pmid,a.r->>'pmid',left(md5('DOI:'||lower(a.r->>'doi')),24)) target,
   a.r->>'source_id' reference_id,coalesce(c.pmid,a.r->>'pmid') pmid,coalesce(c.doi,a.r->>'doi') doi,
   coalesce(c.title,'PMID '||(a.r->>'pmid'),'DOI '||(a.r->>'doi')) title,c.pub_date,c.journal,c.authors,
   c.id IS NOT NULL in_catalog,d.paper_id IS NOT NULL indexed,c.integrity_status
  FROM reference_rows a LEFT JOIN LATERAL (
   SELECT p.id,p.pmid,p.doi,p.title,p.pub_date,p.journal,p.authors,p.integrity_status FROM public.papers p
   WHERE p.pmid=a.r->>'pmid' OR (a.r->>'pmid' IS NULL AND lower(p.doi)=lower(a.r->>'doi'))
   ORDER BY p.id LIMIT 1
  ) c ON true LEFT JOIN app_private.knowledge_documents d ON d.paper_id=c.id
 ), all_citation_edges AS MATERIALIZED (
  SELECT source,target,1 weight,jsonb_agg(DISTINCT reference_id) reference_ids FROM reference_targets
   WHERE source<>target GROUP BY source,target
 ), citation_pool AS MATERIALIZED (
  SELECT pmid id,title label,'paper'::text kind,1 document_count,extract(year FROM pub_date) AS year,
   metadata_available,pmid,doi,journal,true in_catalog,true indexed,true matching_source,integrity_status,authors
  FROM matched
  UNION ALL
  SELECT DISTINCT ON(target) target,title,'reference',1,extract(year FROM pub_date),false,pmid,doi,journal,
   in_catalog,indexed,false,integrity_status,authors FROM reference_targets r WHERE NOT EXISTS(SELECT 1 FROM matched m WHERE m.pmid=r.target)
  ORDER BY 1
 ), citation_degrees AS MATERIALIZED (
  SELECT id,count(*) degree,count(*) FILTER(WHERE incoming) incoming_citations,
   count(*) FILTER(WHERE NOT incoming) identified_references
  FROM (SELECT source id,false incoming FROM all_citation_edges UNION ALL SELECT target,true FROM all_citation_edges) e GROUP BY id
 ), citation_metrics AS MATERIALIZED (
  SELECT p.*,coalesce(d.incoming_citations,0) incoming_citations,coalesce(d.identified_references,0) identified_references
  FROM citation_pool p LEFT JOIN citation_degrees d ON d.id=p.id
 ), pinned AS MATERIALIZED (
  SELECT id FROM citation_pool WHERE id=focus OR id=peer
 ), ranked_edges AS MATERIALIZED (
  SELECT e.*,row_number() OVER(ORDER BY
   (e.source=focus OR e.target=focus OR e.source=peer OR e.target=peer) DESC NULLS LAST,
   d.incoming_citations DESC,p.year DESC NULLS LAST,e.source,e.target) rank
  FROM all_citation_edges e JOIN citation_pool p ON p.id=e.source JOIN citation_degrees d ON d.id=e.target
 ), endpoint_ranks AS MATERIALIZED (
  SELECT id,min(rank) first_rank FROM (
   SELECT source id,rank FROM ranked_edges UNION ALL SELECT target,rank FROM ranked_edges
  ) x WHERE NOT EXISTS(SELECT 1 FROM pinned p WHERE p.id=x.id) GROUP BY id
 ), endpoint_budget AS MATERIALIZED (
  SELECT first_rank,sum(count(*)) OVER(ORDER BY first_rank) used FROM endpoint_ranks GROUP BY first_rank
 ), citation_nodes AS MATERIALIZED (
  -- Admit both endpoints of each ranked edge together. Never fill the node
  -- budget with unrelated papers whose partners were not selected.
  SELECT p.* FROM citation_metrics p WHERE p.id IN (SELECT id FROM pinned) OR p.id IN (
   SELECT e.id FROM endpoint_ranks e JOIN endpoint_budget b USING(first_rank)
   WHERE b.used<=lim-(SELECT count(*) FROM pinned)
  )
 ), unlinked_papers AS MATERIALIZED (
  SELECT p.* FROM citation_metrics p WHERE NOT EXISTS(SELECT 1 FROM citation_degrees d WHERE d.id=p.id)
  ORDER BY year DESC NULLS LAST,id LIMIT 20 OFFSET upg*20
 ), citation_edges AS MATERIALIZED (
  SELECT e.source,e.target,e.weight,e.reference_ids FROM ranked_edges e JOIN citation_nodes a ON a.id=e.source JOIN citation_nodes b ON b.id=e.target
  ORDER BY EXISTS(SELECT 1 FROM endpoint_ranks r WHERE r.first_rank=e.rank) DESC,
   (e.source=focus OR e.target=focus) DESC NULLS LAST,e.rank LIMIT 500
 ), selected AS MATERIALIZED (
  SELECT p.* FROM matched p WHERE focus IS NULL OR
   (rel='concepts' AND EXISTS(SELECT 1 FROM memberships m WHERE m.paper_id=p.id AND m.entity_id=focus)
     AND (peer IS NULL OR EXISTS(SELECT 1 FROM memberships m WHERE m.paper_id=p.id AND m.entity_id=peer))) OR
   (rel='citations' AND (p.pmid=focus OR p.pmid=peer OR (peer IS NULL AND EXISTS(SELECT 1 FROM all_citation_edges e WHERE e.source=p.pmid AND e.target=focus))))
 ), shown_papers AS (
  SELECT * FROM selected ORDER BY pub_date DESC,id DESC LIMIT 21 OFFSET pg*20
 ), notes AS (
  SELECT t.concept_id,min(t.source_label) source_label FROM app_private.knowledge_entity_memberships t
  JOIN app_private.knowledge_pages p ON p.concept_id=t.concept_id WHERE NOT p.stale AND p.version='corpus-v1-en'
  GROUP BY t.concept_id HAVING min(t.entity_id)=focus AND count(DISTINCT t.entity_id)=1
  ORDER BY max(p.updated_at) DESC,t.concept_id LIMIT 3
 )
 SELECT jsonb_build_object(
  'relationship',rel,'filters',f,'focus',focus,'peer',peer,'updated_at',(SELECT max(updated_at) FROM all_docs),
  'indexed_documents',(SELECT count(*) FROM all_docs),'matched_documents',(SELECT count(*) FROM matched),
  'selected_documents',(SELECT count(*) FROM selected),'structured_documents',(SELECT count(*) FROM matched WHERE structured),
  'nodes',CASE WHEN rel='concepts' THEN coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY document_count DESC,label) FROM top_entities n),'[]')
   ELSE coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY matching_source DESC,year DESC NULLS LAST,id) FROM citation_nodes n),'[]') END,
  'edges',CASE WHEN rel='concepts' THEN coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY weight DESC,source,target) FROM concept_edges e),'[]')
   ELSE coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY source,target) FROM citation_edges e),'[]') END,
  'coverage',jsonb_build_object('concepts',(SELECT count(*) FROM entities),'resolved',(SELECT count(*) FROM entities WHERE concept_ui IS NOT NULL),
   'node_limit',lim,'edge_limit',500,'minimum_shared',minimum,'pairs_in_node_selection',(SELECT count(*) FROM pairs),
   'links_at_threshold',(SELECT count(*) FROM pairs WHERE weight>=minimum),'single_paper_pairs',(SELECT count(*) FROM pairs WHERE weight=1),
   'metadata_papers',(SELECT count(*) FROM matched WHERE metadata_available),'papers_with_reference_ids',(SELECT count(*) FROM matched WHERE jsonb_array_length(refs)>0),
   'reference_identifiers',(SELECT coalesce(sum(jsonb_array_length(refs)),0) FROM matched),
   'citation_nodes',(SELECT count(*) FROM citation_pool),'citation_links',(SELECT count(*) FROM all_citation_edges),
   'unlinked_papers',(SELECT count(*) FROM citation_metrics p WHERE NOT EXISTS(SELECT 1 FROM citation_degrees d WHERE d.id=p.id)),
   'displayed_sources',(SELECT count(*) FROM citation_nodes WHERE matching_source),
   'displayed_references',(SELECT count(*) FROM citation_nodes WHERE NOT matching_source)),
  'citation_selection',coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY (id=focus) DESC) FROM citation_metrics n WHERE id=focus OR id=peer),'[]'),
  'unlinked_papers',CASE WHEN rel='citations' THEN coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY year DESC NULLS LAST,id) FROM unlinked_papers n),'[]') ELSE '[]'::jsonb END,
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
