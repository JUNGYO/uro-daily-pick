BEGIN;
-- Preserve raw annotations; authoritative identities are an independently
-- versioned overlay. Unresolved annotations never inherit an LLM's category.
CREATE TABLE app_private.knowledge_term_resolutions (
 concept_id text PRIMARY KEY REFERENCES app_private.knowledge_concepts(id) ON DELETE CASCADE,
 entity_id text, label text NOT NULL, category text NOT NULL, status text NOT NULL,
 concept_ui text, descriptor_ids jsonb NOT NULL, vocabulary_year text NOT NULL,
 checksum text NOT NULL, matched_label text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_entity_resolution ON app_private.knowledge_term_resolutions(entity_id) WHERE entity_id IS NOT NULL;
CREATE TABLE app_private.knowledge_bibliographies (
 paper_id bigint PRIMARY KEY REFERENCES app_private.knowledge_documents(paper_id) ON DELETE CASCADE,
 content_hash text NOT NULL, fetched_at timestamptz NOT NULL, references_data jsonb NOT NULL
);
ALTER TABLE app_private.knowledge_term_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.knowledge_bibliographies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.knowledge_term_resolutions,app_private.knowledge_bibliographies FROM PUBLIC,anon,authenticated;

-- The existing publication implementation and source checks remain intact.
ALTER FUNCTION public.publish_knowledge(uuid,text,text,text,jsonb) RENAME TO publish_knowledge_original;
ALTER FUNCTION public.publish_knowledge_original(uuid,text,text,text,jsonb) SET SCHEMA app_private;
REVOKE ALL ON FUNCTION app_private.publish_knowledge_original(uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.publish_knowledge(p_worker_id uuid,p_token text,p_kind text,p_revision text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE x jsonb; r jsonb; pid bigint; identity text;
BEGIN
 IF p_kind NOT IN ('terms','bibliography') OR p_kind IS NULL THEN
  RETURN app_private.publish_knowledge_original(p_worker_id,p_token,p_kind,p_revision,p_payload);
 END IF;
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 IF p_revision IS NULL OR p_revision !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
   OR octet_length(p_payload::text)>180000 OR p_payload->>'version' IS DISTINCT FROM 'corpus-v1' THEN
  RAISE EXCEPTION 'Invalid network metadata'; END IF;
 IF p_kind='terms' THEN
  PERFORM app_private.knowledge_shape(p_payload,ARRAY['id','version','items']);
  identity=p_payload->>'id';
  IF coalesce(identity,'') !~ '^[0-9a-f]{24}$' OR jsonb_typeof(p_payload->'items') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_payload->'items') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid terminology batch'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_payload->'items') LOOP
   PERFORM app_private.knowledge_shape(x,ARRAY['concept_id','matched_label','vocabulary','year','checksum','status','entity_id','label','category','descriptor_ids','concept_ui']);
   IF x->>'vocabulary' IS DISTINCT FROM 'MeSH' OR coalesce(x->>'year','') !~ '^20[0-9]{2}$'
    OR coalesce(x->>'checksum','') !~ '^[0-9a-f]{64}$' OR coalesce(length(x->>'label'),0) NOT BETWEEN 1 AND 500
    OR coalesce(x->>'status','') NOT IN ('exact','ambiguous','unmapped')
    OR coalesce(x->>'category','') NOT IN ('anatomy','organism','condition','substance','technique','psychology','biological_process','discipline','social','technology','humanities','information','population','healthcare','publication','geography','multiple','unclassified')
    OR jsonb_typeof(x->'descriptor_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(x->'descriptor_ids')>30
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(x->'descriptor_ids') t(v) WHERE v !~ '^D[0-9]{6,9}$')
    OR NOT EXISTS(SELECT 1 FROM app_private.knowledge_concepts c WHERE c.id=x->>'concept_id' AND c.label=x->>'matched_label') THEN
      RAISE EXCEPTION 'Invalid terminology identity'; END IF;
   IF x->>'status'='exact' THEN
    IF coalesce(x->>'concept_ui','') !~ '^M[0-9]{6,9}$' OR x->>'entity_id' IS DISTINCT FROM left(md5('MeSH:'||(x->>'concept_ui')),24)
       OR jsonb_array_length(x->'descriptor_ids')=0 THEN RAISE EXCEPTION 'Invalid MeSH concept identity'; END IF;
   ELSIF x->>'entity_id' IS NOT NULL OR x->>'concept_ui' IS NOT NULL OR x->>'category'<>'unclassified'
       OR x->>'label' IS DISTINCT FROM x->>'matched_label' OR jsonb_array_length(x->'descriptor_ids')<>0 THEN
      RAISE EXCEPTION 'Unresolved terms must remain unclassified';
   END IF;
   INSERT INTO app_private.knowledge_term_resolutions VALUES(x->>'concept_id',x->>'entity_id',x->>'label',x->>'category',x->>'status',x->>'concept_ui',x->'descriptor_ids',x->>'year',x->>'checksum',x->>'matched_label',now())
   ON CONFLICT(concept_id) DO UPDATE SET entity_id=excluded.entity_id,label=excluded.label,category=excluded.category,status=excluded.status,
    concept_ui=excluded.concept_ui,descriptor_ids=excluded.descriptor_ids,vocabulary_year=excluded.vocabulary_year,checksum=excluded.checksum,matched_label=excluded.matched_label,updated_at=excluded.updated_at;
  END LOOP;
 ELSE
  PERFORM app_private.knowledge_shape(p_payload,ARRAY['version','pmid','title','content_hash','source','fetched_at','references']);
  identity=p_payload->>'pmid';
  IF coalesce(identity,'') !~ '^[0-9]{1,12}$' OR p_payload->>'source' IS DISTINCT FROM 'PubMed'
    OR p_payload->>'fetched_at' IS NULL OR (p_payload->>'fetched_at')::timestamptz>now()+interval '1 day'
    OR jsonb_typeof(p_payload->'references') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'references')>500 THEN
    RAISE EXCEPTION 'Invalid bibliography'; END IF;
  SELECT p.id INTO STRICT pid FROM public.papers p JOIN app_private.knowledge_documents d ON d.paper_id=p.id
   JOIN app_private.local_fulltext_sources s ON s.paper_id=p.id AND s.content_hash=d.content_hash
   WHERE p.pmid=identity AND p.title=p_payload->>'title' AND p.integrity_status='current'
    AND s.worker_id=p_worker_id AND d.content_hash=p_payload->>'content_hash';
  FOR r IN SELECT value FROM jsonb_array_elements(p_payload->'references') LOOP
   PERFORM app_private.knowledge_shape(r,ARRAY['source_id','pmid','doi']);
   IF coalesce(length(r->>'source_id'),0) NOT BETWEEN 1 AND 100
    OR (r->>'pmid' IS NOT NULL AND r->>'pmid' !~ '^[0-9]{1,12}$')
    OR (r->>'doi' IS NOT NULL AND (length(r->>'doi')>500 OR r->>'doi' !~* '^10\.[0-9]{4,9}/[^[:space:]]+$'))
    OR (r->>'pmid' IS NULL AND r->>'doi' IS NULL) THEN RAISE EXCEPTION 'Invalid citation identifier'; END IF;
  END LOOP;
  INSERT INTO app_private.knowledge_bibliographies VALUES(pid,p_payload->>'content_hash',(p_payload->>'fetched_at')::timestamptz,p_payload->'references')
   ON CONFLICT(paper_id) DO UPDATE SET content_hash=excluded.content_hash,fetched_at=excluded.fetched_at,references_data=excluded.references_data;
 END IF;
 RETURN jsonb_build_object('id',identity,'revision',p_revision);
END; $$;
REVOKE ALL ON FUNCTION public.publish_knowledge(uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_knowledge(uuid,text,text,text,jsonb) TO anon,authenticated;

CREATE VIEW app_private.knowledge_entity_terms WITH (security_invoker=true) AS
 SELECT c.id concept_id,coalesce(r.entity_id,c.id) entity_id,
  CASE WHEN r.status='exact' THEN r.label ELSE c.label END label,
  CASE WHEN r.status='exact' THEN r.category ELSE 'unclassified' END category,
  coalesce(r.status,'pending') resolution,r.concept_ui,r.descriptor_ids,r.vocabulary_year,c.label source_label,c.aliases
 FROM app_private.knowledge_concepts c LEFT JOIN app_private.knowledge_term_resolutions r ON r.concept_id=c.id AND r.matched_label=c.label;
REVOKE ALL ON app_private.knowledge_entity_terms FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.knowledge_network(p_filters jsonb DEFAULT '{}') RETURNS jsonb
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
   coalesce(b.references_data,s.payload->'bibliography'->'references','[]'::jsonb) refs,
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
REVOKE ALL ON FUNCTION public.knowledge_network(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_network(jsonb) TO authenticated;

-- Existing narrative pages retain their exact source scope and labels. Their
-- category displays use the same authority overlay as the atlas, never a model
-- guess. No narratives or original annotations are rewritten by this migration.
CREATE FUNCTION app_private.knowledge_display_term(value jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT value || jsonb_build_object('kind',t.category,'authority',jsonb_build_object(
 'entity_id',t.entity_id,'label',t.label,'status',t.resolution,'concept_ui',t.concept_ui,'year',t.vocabulary_year))
 FROM app_private.knowledge_entity_terms t WHERE t.concept_id=value->>'id';
$$;
REVOKE ALL ON FUNCTION app_private.knowledge_display_term(jsonb) FROM PUBLIC,anon,authenticated;
ALTER FUNCTION public.knowledge_search(text,text,integer) RENAME TO knowledge_search_original;
ALTER FUNCTION public.knowledge_search_original(text,text,integer) SET SCHEMA app_private;
REVOKE ALL ON FUNCTION app_private.knowledge_search_original(text,text,integer) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.knowledge_search(p_query text DEFAULT '',p_pmid text DEFAULT NULL,p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='5s' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app_private.knowledge_reader();
 result=app_private.knowledge_search_original(p_query,p_pmid,p_page);
 RETURN jsonb_set(result,'{items}',coalesce((SELECT jsonb_agg(app_private.knowledge_display_term(value) ORDER BY ord)
 FROM jsonb_array_elements(result->'items') WITH ORDINALITY a(value,ord)),'[]'));
END; $$;
REVOKE ALL ON FUNCTION public.knowledge_search(text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_search(text,text,integer) TO authenticated;
ALTER FUNCTION public.knowledge_page(text,integer) RENAME TO knowledge_page_original;
ALTER FUNCTION public.knowledge_page_original(text,integer) SET SCHEMA app_private;
REVOKE ALL ON FUNCTION app_private.knowledge_page_original(text,integer) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.knowledge_page(p_id text,p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='5s' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app_private.knowledge_reader();
 result=app_private.knowledge_page_original(p_id,p_page);
 IF result IS NULL THEN RETURN NULL; END IF;
 result=jsonb_set(result,'{concept}',app_private.knowledge_display_term(result->'concept'));
 RETURN jsonb_set(result,'{neighbors}',coalesce((SELECT jsonb_agg(app_private.knowledge_display_term(value) ORDER BY ord)
 FROM jsonb_array_elements(result->'neighbors') WITH ORDINALITY a(value,ord)),'[]'));
END; $$;
REVOKE ALL ON FUNCTION public.knowledge_page(text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_page(text,integer) TO authenticated;

COMMIT;
