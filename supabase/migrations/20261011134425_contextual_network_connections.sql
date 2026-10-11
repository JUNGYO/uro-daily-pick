BEGIN;
-- Identity is attached to a source document, never propagated from one paper's
-- abbreviation to every occurrence of that spelling in the corpus.
CREATE TABLE app_private.knowledge_document_terms (
 paper_id bigint NOT NULL REFERENCES app_private.knowledge_documents(paper_id) ON DELETE CASCADE,
 concept_id text NOT NULL REFERENCES app_private.knowledge_concepts(id) ON DELETE CASCADE,
 content_hash text NOT NULL, entity_id text NOT NULL, label text NOT NULL,
 category text NOT NULL, resolution text NOT NULL, concept_ui text,
 descriptor_ids jsonb NOT NULL, vocabulary_year text NOT NULL, checksum text NOT NULL,
 definition jsonb, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(paper_id,concept_id)
);
CREATE INDEX knowledge_document_entity ON app_private.knowledge_document_terms(entity_id,paper_id);
ALTER TABLE app_private.knowledge_document_terms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.knowledge_document_terms FROM PUBLIC,anon,authenticated;

ALTER FUNCTION public.publish_knowledge(uuid,text,text,text,jsonb) RENAME TO publish_knowledge_network_metadata;
ALTER FUNCTION public.publish_knowledge_network_metadata(uuid,text,text,text,jsonb) SET SCHEMA app_private;
REVOKE ALL ON FUNCTION app_private.publish_knowledge_network_metadata(uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.publish_knowledge(p_worker_id uuid,p_token text,p_kind text,p_revision text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE pid bigint; x jsonb; proof jsonb; expected text;
BEGIN
 IF p_kind IS DISTINCT FROM 'document_terms' THEN
  RETURN app_private.publish_knowledge_network_metadata(p_worker_id,p_token,p_kind,p_revision,p_payload);
 END IF;
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 PERFORM app_private.knowledge_shape(p_payload,ARRAY['version','recipe','pmid','title','content_hash','items']);
 IF coalesce(p_revision,'') !~ '^[0-9a-f]{64}$' OR octet_length(p_payload::text)>300000
   OR p_payload->>'version' IS DISTINCT FROM 'corpus-v1' OR p_payload->>'recipe' IS DISTINCT FROM 'document-terms-v1'
   OR coalesce(p_payload->>'pmid','') !~ '^[0-9]{1,12}$'
   OR jsonb_typeof(p_payload->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'items')>256 THEN
  RAISE EXCEPTION 'Invalid document terminology'; END IF;
 SELECT p.id INTO STRICT pid FROM public.papers p JOIN app_private.knowledge_documents d ON d.paper_id=p.id
  JOIN app_private.local_fulltext_sources s ON s.paper_id=p.id AND s.content_hash=d.content_hash
  WHERE p.pmid=p_payload->>'pmid' AND p.title=p_payload->>'title' AND p.integrity_status='current'
   AND s.worker_id=p_worker_id AND d.content_hash=p_payload->>'content_hash';
 DELETE FROM app_private.knowledge_document_terms WHERE paper_id=pid;
 FOR x IN SELECT value FROM jsonb_array_elements(p_payload->'items') LOOP
  PERFORM app_private.knowledge_shape(x,ARRAY['concept_id','matched_label','entity_id','label','category','resolution','concept_ui','descriptor_ids','year','checksum','definition']);
  IF coalesce(x->>'entity_id','') !~ '^[0-9a-f]{24}$' OR coalesce(length(x->>'label'),0) NOT BETWEEN 1 AND 500
   OR coalesce(x->>'checksum','') !~ '^[0-9a-f]{64}$' OR coalesce(x->>'year','') !~ '^20[0-9]{2}$'
   OR coalesce(x->>'resolution','') NOT IN ('exact','definition','lexical','unresolved','ambiguous')
   OR coalesce(x->>'category','') NOT IN ('anatomy','organism','condition','substance','technique','psychology','biological_process','discipline','social','technology','humanities','information','population','healthcare','publication','geography','multiple','unclassified')
   OR jsonb_typeof(x->'descriptor_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(x->'descriptor_ids')>30
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(x->'descriptor_ids') d(v) WHERE v !~ '^D[0-9]{6,9}$')
   OR NOT EXISTS(SELECT 1 FROM app_private.knowledge_memberships m JOIN app_private.knowledge_concepts c ON c.id=m.concept_id
      WHERE m.paper_id=pid AND c.id=x->>'concept_id' AND c.label=x->>'matched_label') THEN
    RAISE EXCEPTION 'Invalid source term'; END IF;
  proof=x->'definition';
  IF x->>'resolution'='definition' THEN
   PERFORM app_private.knowledge_shape(proof,ARRAY['label','start','end','hash']);
   IF coalesce(length(proof->>'label'),0) NOT BETWEEN 2 AND 160 OR coalesce(proof->>'hash','') !~ '^[0-9a-f]{64}$'
     OR coalesce(proof->>'start','') !~ '^[0-9]{1,6}$' OR coalesce(proof->>'end','') !~ '^[0-9]{1,6}$'
     OR (proof->>'end')::int NOT BETWEEN (proof->>'start')::int+1 AND 600000 THEN RAISE EXCEPTION 'Invalid definition provenance'; END IF;
  ELSIF proof IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Unexpected definition'; END IF;
  IF x->>'concept_ui' IS NOT NULL THEN
   IF x->>'concept_ui' !~ '^M[0-9]{6,9}$' OR x->>'resolution' NOT IN ('exact','definition') OR jsonb_array_length(x->'descriptor_ids')=0 THEN
    RAISE EXCEPTION 'Invalid resolved concept'; END IF;
   expected=left(md5('MeSH:'||(x->>'concept_ui')),24);
  ELSE
   IF x->>'resolution'='exact' OR x->>'category'<>'unclassified' OR jsonb_array_length(x->'descriptor_ids')<>0 THEN RAISE EXCEPTION 'Unclassified term required'; END IF;
   expected=left(md5(CASE WHEN x->>'resolution' IN ('unresolved','ambiguous') THEN 'Unresolved:'||(p_payload->>'pmid')||':' ELSE 'Text:' END || lower(x->>'label')),24);
  END IF;
  IF x->>'entity_id' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Invalid contextual identity'; END IF;
  INSERT INTO app_private.knowledge_document_terms VALUES(pid,x->>'concept_id',p_payload->>'content_hash',expected,x->>'label',x->>'category',x->>'resolution',x->>'concept_ui',x->'descriptor_ids',x->>'year',x->>'checksum',proof,now());
 END LOOP;
 RETURN jsonb_build_object('id',p_payload->>'pmid','revision',p_revision);
END; $$;
REVOKE ALL ON FUNCTION public.publish_knowledge(uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_knowledge(uuid,text,text,text,jsonb) TO anon,authenticated;

-- Reject old unsafe abbreviation expansions even before the local backfill.
CREATE OR REPLACE VIEW app_private.knowledge_entity_terms WITH (security_invoker=true) AS
 SELECT c.id concept_id,coalesce(r.entity_id,CASE WHEN c.label ~ '^[a-z][a-z0-9-]{1,7}$' THEN c.id ELSE left(md5('Text:'||lower(c.label)),24) END) entity_id,
  CASE WHEN r.status='exact' THEN r.label ELSE c.label END label,
  CASE WHEN r.status='exact' THEN r.category ELSE 'unclassified' END category,
  coalesce(r.status,'pending') resolution,r.concept_ui,r.descriptor_ids,r.vocabulary_year,c.label source_label,c.aliases
 FROM app_private.knowledge_concepts c LEFT JOIN app_private.knowledge_term_resolutions r ON r.concept_id=c.id AND r.matched_label=c.label
  AND NOT(c.label ~ '^[a-z][a-z0-9-]{1,7}$' AND lower(r.label)<>lower(c.label));

CREATE VIEW app_private.knowledge_entity_memberships WITH (security_invoker=true) AS
 SELECT m.paper_id,t.concept_id,coalesce(r.entity_id,CASE WHEN t.concept_ui IS NULL AND t.source_label ~ '^[a-z][a-z0-9-]{1,7}$'
  THEN left(md5('Unresolved:'||p.pmid||':'||t.source_label),24) ELSE t.entity_id END) entity_id,coalesce(r.label,t.label) label,
 coalesce(r.category,t.category) category,coalesce(r.resolution,CASE WHEN t.concept_ui IS NULL AND t.source_label ~ '^[a-z][a-z0-9-]{1,7}$' THEN 'unresolved' ELSE t.resolution END) resolution,
 CASE WHEN r.paper_id IS NOT NULL THEN r.concept_ui ELSE t.concept_ui END concept_ui,coalesce(r.vocabulary_year,t.vocabulary_year) vocabulary_year,
 t.source_label,t.aliases
 FROM app_private.knowledge_memberships m JOIN app_private.knowledge_documents d ON d.paper_id=m.paper_id JOIN public.papers p ON p.id=m.paper_id
 JOIN app_private.knowledge_entity_terms t ON t.concept_id=m.concept_id
 LEFT JOIN app_private.knowledge_document_terms r ON r.paper_id=m.paper_id AND r.concept_id=m.concept_id AND r.content_hash=d.content_hash;
REVOKE ALL ON app_private.knowledge_entity_memberships FROM PUBLIC,anon,authenticated;

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
   coalesce(c.title,'PMID '||(a.r->>'pmid'),'DOI '||(a.r->>'doi')) title,c.pub_date,c.journal,
   c.id IS NOT NULL in_catalog,d.paper_id IS NOT NULL indexed,c.integrity_status
  FROM reference_rows a LEFT JOIN LATERAL (
   SELECT p.id,p.pmid,p.doi,p.title,p.pub_date,p.journal,p.integrity_status FROM public.papers p
   WHERE p.pmid=a.r->>'pmid' OR (a.r->>'pmid' IS NULL AND lower(p.doi)=lower(a.r->>'doi'))
   ORDER BY p.id LIMIT 1
  ) c ON true LEFT JOIN app_private.knowledge_documents d ON d.paper_id=c.id
 ), all_citation_edges AS MATERIALIZED (
  SELECT source,target,1 weight,jsonb_agg(DISTINCT reference_id) reference_ids FROM reference_targets
   WHERE source<>target GROUP BY source,target
 ), citation_pool AS MATERIALIZED (
  SELECT pmid id,title label,'paper'::text kind,1 document_count,extract(year FROM pub_date) AS year,
   metadata_available,pmid,doi,journal,true in_catalog,true indexed,true matching_source,integrity_status
  FROM matched
  UNION ALL
  SELECT DISTINCT ON(target) target,title,'reference',1,extract(year FROM pub_date),false,pmid,doi,journal,
   in_catalog,indexed,false,integrity_status FROM reference_targets r WHERE NOT EXISTS(SELECT 1 FROM matched m WHERE m.pmid=r.target)
  ORDER BY 1
 ), citation_degrees AS MATERIALIZED (
  SELECT id,count(*) degree FROM (SELECT source id FROM all_citation_edges UNION ALL SELECT target FROM all_citation_edges) e GROUP BY id
 ), seed_edges AS MATERIALIZED (
  SELECT e.* FROM all_citation_edges e JOIN citation_pool p ON p.id=e.source JOIN citation_degrees d ON d.id=e.target
  ORDER BY (e.source=focus OR e.target=focus OR e.source=peer OR e.target=peer) DESC NULLS LAST,d.degree DESC,p.year DESC NULLS LAST,e.source,e.target
  LIMIT greatest(1,(lim-2)/2)
 ), citation_nodes AS MATERIALIZED (
  SELECT p.* FROM citation_pool p LEFT JOIN citation_degrees d ON d.id=p.id
  ORDER BY (p.id=focus OR p.id=peer) DESC NULLS LAST,
   EXISTS(SELECT 1 FROM seed_edges e WHERE e.source=p.id OR e.target=p.id) DESC,coalesce(d.degree,0) DESC,
   p.matching_source DESC,p.year DESC NULLS LAST,p.id LIMIT lim
 ), citation_edges AS MATERIALIZED (
  SELECT e.* FROM all_citation_edges e JOIN citation_nodes a ON a.id=e.source JOIN citation_nodes b ON b.id=e.target
  ORDER BY (e.source=focus OR e.target=focus) DESC NULLS LAST,e.source,e.target LIMIT 500
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
   'displayed_sources',(SELECT count(*) FROM citation_nodes WHERE matching_source),
   'displayed_references',(SELECT count(*) FROM citation_nodes WHERE NOT matching_source)),
  'citation_selection',coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY (id=focus) DESC) FROM citation_pool n WHERE id=focus OR id=peer),'[]'),
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

-- Never show a pooled narrative for a raw acronym with conflicting senses.
CREATE OR REPLACE FUNCTION public.knowledge_page(p_id text,p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='5s' AS $$
DECLARE result jsonb; mixed boolean; senses jsonb;
BEGIN
 PERFORM app_private.knowledge_reader();
 result=app_private.knowledge_page_original(p_id,p_page);
 IF result IS NULL THEN RETURN NULL; END IF;
 result=jsonb_set(result,'{concept}',app_private.knowledge_display_term(result->'concept'));
 result=jsonb_set(result,'{neighbors}',coalesce((SELECT jsonb_agg(app_private.knowledge_display_term(value) ORDER BY ord)
  FROM jsonb_array_elements(result->'neighbors') WITH ORDINALITY a(value,ord)),'[]'));
 SELECT count(DISTINCT entity_id)>1 OR coalesce(bool_or(resolution IN ('ambiguous','unresolved')),false) INTO mixed
  FROM app_private.knowledge_entity_memberships WHERE concept_id=p_id;
 IF mixed THEN
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY document_count DESC,label),'[]') INTO senses FROM (
   SELECT entity_id,min(label) label,count(DISTINCT paper_id) document_count FROM app_private.knowledge_entity_memberships
   WHERE concept_id=p_id AND resolution NOT IN ('ambiguous','unresolved','pending','unmapped') GROUP BY entity_id LIMIT 100
  ) t;
  result=jsonb_set(result,'{wiki}',coalesce(nullif(result->'wiki','null'),'{}')||jsonb_build_object('status','disambiguation','paragraphs','[]'::jsonb));
  result=result||jsonb_build_object('meanings',senses);
 END IF;
 RETURN result;
END; $$;
COMMIT;
