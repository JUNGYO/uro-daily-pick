BEGIN;
-- A separate, original-bound layer. No reader notes, projects or daily summaries.
CREATE TABLE app_private.knowledge_science (
 paper_id bigint PRIMARY KEY REFERENCES app_private.knowledge_documents(paper_id) ON DELETE CASCADE,
 content_hash text NOT NULL, revision text NOT NULL, payload jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_private.knowledge_references (
 paper_id bigint NOT NULL REFERENCES app_private.knowledge_science(paper_id) ON DELETE CASCADE,
 ordinal integer NOT NULL, target_pmid text, target_doi text, PRIMARY KEY(paper_id,ordinal)
);
CREATE INDEX knowledge_reference_pmid ON app_private.knowledge_references(target_pmid) WHERE target_pmid IS NOT NULL;
CREATE INDEX knowledge_reference_doi ON app_private.knowledge_references(target_doi) WHERE target_doi IS NOT NULL;
CREATE TABLE app_private.knowledge_registries (
 paper_id bigint NOT NULL REFERENCES app_private.knowledge_science(paper_id) ON DELETE CASCADE,
 registry_id text NOT NULL, relation text NOT NULL CHECK(relation IN ('registered','mentioned')),
 PRIMARY KEY(paper_id,registry_id,relation)
);
CREATE INDEX knowledge_registry_lookup ON app_private.knowledge_registries(registry_id,paper_id);
ALTER TABLE app_private.knowledge_science ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.knowledge_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.knowledge_registries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.knowledge_science,app_private.knowledge_references,app_private.knowledge_registries FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.knowledge_shape(v jsonb, keys text[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR v-keys<>'{}' OR NOT v ?& keys THEN
  RAISE EXCEPTION 'Invalid scientific fields' USING ERRCODE='22023'; END IF;
END; $$;
REVOKE ALL ON FUNCTION app_private.knowledge_shape(jsonb,text[]) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.publish_scientific_knowledge(p_worker_id uuid,p_token text,p_revision text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE pid bigint; original app_private.local_fulltext_sources; b jsonb; x jsonb; l jsonb; k text; n integer;
BEGIN
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 PERFORM app_private.knowledge_shape(p_payload,ARRAY['version','pmid','title','content_hash','bibliography','facts','results','terminology','registry_mentions','provenance','coverage']);
 IF p_payload->>'version' IS DISTINCT FROM 'scientific-v1' OR octet_length(p_payload::text)>180000
   OR coalesce(p_revision,'') !~ '^[0-9a-f]{64}$' OR coalesce(p_payload->>'content_hash','') !~ '^[0-9a-f]{64}$' THEN
   RAISE EXCEPTION 'Invalid scientific publication'; END IF;
 SELECT p.id INTO STRICT pid FROM public.papers p JOIN app_private.knowledge_documents d ON d.paper_id=p.id
 WHERE p.pmid=p_payload->>'pmid' AND p.title=p_payload->>'title' AND p.integrity_status='current'
 AND p.fulltext_available AND d.content_hash=p_payload->>'content_hash' FOR SHARE OF p,d;
 SELECT * INTO STRICT original FROM app_private.local_fulltext_sources s WHERE s.paper_id=pid
 AND s.worker_id=p_worker_id AND s.title=p_payload->>'title' AND s.content_hash=p_payload->>'content_hash' FOR SHARE;
 b=p_payload->'bibliography';
 PERFORM app_private.knowledge_shape(b,ARRAY['source','fetched_at','pmid','title','doi','pmcid','journal','volume','issue','pages','authors','issns','dates','publication_types','mesh','registry_ids','references','related_articles']);
 IF b->>'pmid' IS DISTINCT FROM p_payload->>'pmid' OR coalesce(b->>'source','') NOT IN ('PubMed','catalog') THEN
  RAISE EXCEPTION 'Invalid bibliography identity'; END IF;
 FOREACH k IN ARRAY ARRAY['title','journal','volume','issue','pages','doi','pmcid'] LOOP
  IF jsonb_typeof(b->k) NOT IN ('string','null') OR length(b->>k)>3000 THEN RAISE EXCEPTION 'Invalid bibliographic text'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['authors','issns','publication_types','registry_ids'] LOOP
  IF jsonb_typeof(b->k) IS DISTINCT FROM 'array' OR jsonb_array_length(b->k)>500 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(b->k) v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}')>300) THEN
    RAISE EXCEPTION 'Invalid bibliographic list'; END IF;
 END LOOP;
 IF b->>'fetched_at' IS NOT NULL THEN PERFORM (b->>'fetched_at')::timestamptz; END IF;
 FOREACH k IN ARRAY ARRAY['dates','mesh','references','related_articles'] LOOP
  IF jsonb_typeof(b->k) IS DISTINCT FROM 'array' OR jsonb_array_length(b->k)>500 THEN RAISE EXCEPTION 'Invalid bibliography array'; END IF;
 END LOOP;
 FOR x IN SELECT value FROM jsonb_array_elements(b->'dates') LOOP
  PERFORM app_private.knowledge_shape(x,ARRAY['kind','date','precision','raw']);
  IF coalesce(x->>'precision','') NOT IN ('day','month','year','range','unknown') OR length(x->>'raw')>120
    OR coalesce(x->>'kind','') !~ '^[a-z_]{1,30}$' OR (x->>'date' IS NOT NULL AND x->>'date' !~ '^[0-9]{4}(-[0-9]{2})?(-[0-9]{2})?$') THEN
    RAISE EXCEPTION 'Invalid bibliographic date'; END IF;
 END LOOP;
 FOR x IN SELECT value FROM jsonb_array_elements(b->'mesh') LOOP
  PERFORM app_private.knowledge_shape(x,ARRAY['id','label']);
  IF coalesce(x->>'id','') !~ '^D[0-9]+$' OR coalesce(length(x->>'label'),0) NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid MeSH term'; END IF;
 END LOOP;
 FOR x IN SELECT value FROM jsonb_array_elements(b->'related_articles') LOOP
  PERFORM app_private.knowledge_shape(x,ARRAY['pmid','relation']);
  IF coalesce(x->>'pmid','') !~ '^[0-9]{1,12}$' OR length(x->>'relation')>80 THEN RAISE EXCEPTION 'Invalid article relation'; END IF;
 END LOOP;
 FOR x IN SELECT value FROM jsonb_array_elements(b->'references') LOOP
  PERFORM app_private.knowledge_shape(x,ARRAY['source_id','pmid','doi']);
  IF coalesce(length(x->>'source_id'),0) NOT BETWEEN 1 AND 80
    OR (x->>'pmid' IS NOT NULL AND x->>'pmid' !~ '^[0-9]{1,12}$')
    OR (x->>'doi' IS NOT NULL AND (x->>'doi' !~ '^10\.' OR length(x->>'doi')>300))
    OR (x->>'pmid' IS NULL AND x->>'doi' IS NULL) THEN RAISE EXCEPTION 'Invalid citation identifier'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['facts','results','terminology','registry_mentions'] LOOP
  IF jsonb_typeof(p_payload->k) IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->k)>256 THEN RAISE EXCEPTION 'Scientific array exceeds limits'; END IF;
 END LOOP;
 IF jsonb_array_length(p_payload->'facts')>160 OR jsonb_array_length(p_payload->'results')>80 THEN RAISE EXCEPTION 'Too many scientific records'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p_payload->'facts') LOOP
  PERFORM app_private.knowledge_shape(x,ARRAY['id','field','value','locations']);
  IF jsonb_typeof(x->'value') IS DISTINCT FROM 'string' OR coalesce(x->>'field','') NOT IN ('design','population','intervention','comparator','sample_size','follow_up','outcome','limitation')
    OR coalesce(length(x->>'value'),0) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Invalid scientific fact'; END IF;
 END LOOP;
 FOR x IN SELECT value FROM jsonb_array_elements(p_payload->'results') LOOP
  PERFORM app_private.knowledge_shape(x,ARRAY['id','measure','estimate','ci_low','ci_high','ci_level','outcome','population','comparison','timepoint','unit','adjustment','locations']);
  IF coalesce(x->>'measure','') NOT IN ('HR','RR','OR','MD','SMD','AUC','sensitivity','specificity','proportion','rate','other')
    OR coalesce(x->>'adjustment','') NOT IN ('adjusted','unadjusted','not_reported')
    OR x->>'estimate' IS NULL THEN RAISE EXCEPTION 'Invalid result measure'; END IF;
  FOREACH k IN ARRAY ARRAY['outcome','population','comparison','timepoint','unit'] LOOP
   IF jsonb_typeof(x->k) NOT IN ('string','null') OR length(x->>k)>120 THEN RAISE EXCEPTION 'Invalid result context'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['estimate','ci_low','ci_high','ci_level'] LOOP
   IF jsonb_typeof(x->k) NOT IN ('string','null') OR (x->>k IS NOT NULL AND x->>k !~ '^-?[0-9]{1,12}(\.[0-9]{1,10})?$') THEN
    RAISE EXCEPTION 'Invalid numeric result'; END IF;
  END LOOP;
  IF x->>'ci_low' IS NOT NULL OR x->>'ci_high' IS NOT NULL OR x->>'ci_level' IS NOT NULL THEN
   IF x->>'ci_low' IS NULL OR x->>'ci_high' IS NULL OR x->>'ci_level' IS NULL
     OR NOT (x->>'ci_low')::numeric<=(x->>'estimate')::numeric OR NOT (x->>'estimate')::numeric<=(x->>'ci_high')::numeric
     OR NOT (x->>'ci_level')::numeric BETWEEN 0.0001 AND 99.9999 THEN RAISE EXCEPTION 'Invalid confidence interval'; END IF;
  END IF;
  IF x->>'measure' IN ('HR','RR','OR') AND ((x->>'estimate')::numeric<=0 OR (x->>'ci_low')::numeric<=0) THEN RAISE EXCEPTION 'Invalid ratio'; END IF;
  IF x->>'measure'='AUC' AND NOT (x->>'estimate')::numeric BETWEEN 0 AND 1 THEN RAISE EXCEPTION 'Invalid AUC'; END IF;
 END LOOP;
 FOR x IN SELECT value FROM jsonb_array_elements((p_payload->'facts')||(p_payload->'results')) LOOP
  IF coalesce(x->>'id','') !~ '^[0-9a-f]{24}$' OR jsonb_typeof(x->'locations') IS DISTINCT FROM 'array'
    OR jsonb_array_length(x->'locations') NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'Missing source locator'; END IF;
  FOR l IN SELECT value FROM jsonb_array_elements(x->'locations') LOOP
   IF jsonb_typeof(l)<>'string' OR l#>>'{}' !~ '^(p|table|figure)-[0-9]{7}$'
    OR substring(l#>>'{}' from '[0-9]+$')::integer>=original.characters THEN RAISE EXCEPTION 'Invalid result source'; END IF;
  END LOOP;
 END LOOP;
 FOR x IN SELECT value FROM jsonb_array_elements(p_payload->'terminology') LOOP
  PERFORM app_private.knowledge_shape(x,ARRAY['concept_id','system','id','label']);
  IF x->>'system' IS DISTINCT FROM 'MeSH' OR coalesce(x->>'id','') !~ '^D[0-9]+$'
    OR NOT EXISTS(SELECT 1 FROM app_private.knowledge_memberships WHERE paper_id=pid AND concept_id=x->>'concept_id')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'mesh') t WHERE t->>'id'=x->>'id' AND t->>'label'=x->>'label') THEN
    RAISE EXCEPTION 'Invalid terminology mapping'; END IF;
 END LOOP;
 FOR x IN SELECT value FROM jsonb_array_elements((b->'registry_ids')||(p_payload->'registry_mentions')) LOOP
  IF jsonb_typeof(x)<>'string' OR upper(x#>>'{}') !~ '^(NCT[0-9]{8}|ISRCTN[0-9]{8})$' THEN RAISE EXCEPTION 'Invalid registry identifier'; END IF;
 END LOOP;
 x=p_payload->'provenance';
 PERFORM app_private.knowledge_shape(x,ARRAY['model','recipe','extracted_at','validation','review_status','chunks','rejected_candidates']);
 IF coalesce(length(x->>'model'),0) NOT BETWEEN 1 AND 120 OR x->>'recipe' IS DISTINCT FROM 'scientific-v1'
   OR x->>'validation' IS DISTINCT FROM 'source_checked' OR x->>'review_status' IS DISTINCT FROM 'unreviewed'
   OR coalesce(x->>'chunks','') !~ '^[0-9]{1,4}$' OR coalesce(x->>'rejected_candidates','') !~ '^[0-9]{1,6}$' THEN RAISE EXCEPTION 'Invalid extraction provenance'; END IF;
 PERFORM (x->>'extracted_at')::timestamptz;
 x=p_payload->'coverage';
 PERFORM app_private.knowledge_shape(x,ARRAY['facts_total','results_total','facts_published','results_published']);
 FOREACH k IN ARRAY ARRAY['facts_total','results_total','facts_published','results_published'] LOOP
  IF coalesce(x->>k,'') !~ '^[0-9]{1,6}$' THEN RAISE EXCEPTION 'Invalid coverage'; END IF;
 END LOOP;
 IF (x->>'facts_published')::int<>jsonb_array_length(p_payload->'facts') OR (x->>'results_published')::int<>jsonb_array_length(p_payload->'results')
 OR (x->>'facts_total')::int<(x->>'facts_published')::int OR (x->>'results_total')::int<(x->>'results_published')::int THEN RAISE EXCEPTION 'Inconsistent coverage'; END IF;
 INSERT INTO app_private.knowledge_science VALUES(pid,p_payload->>'content_hash',p_revision,p_payload,now()) ON CONFLICT(paper_id)
 DO UPDATE SET content_hash=excluded.content_hash,revision=excluded.revision,payload=excluded.payload,updated_at=now()
 WHERE knowledge_science.revision<>excluded.revision;
 DELETE FROM app_private.knowledge_references WHERE paper_id=pid;
 INSERT INTO app_private.knowledge_references SELECT pid,ordinality::int,v->>'pmid',lower(v->>'doi') FROM jsonb_array_elements(b->'references') WITH ORDINALITY t(v,ordinality);
 DELETE FROM app_private.knowledge_registries WHERE paper_id=pid;
 INSERT INTO app_private.knowledge_registries SELECT DISTINCT pid,upper(v),'registered' FROM jsonb_array_elements_text(b->'registry_ids') t(v);
 INSERT INTO app_private.knowledge_registries SELECT DISTINCT pid,upper(v),'mentioned' FROM jsonb_array_elements_text(p_payload->'registry_mentions') t(v);
 RETURN jsonb_build_object('id',p_payload->>'pmid','revision',p_revision);
END; $$;
REVOKE ALL ON FUNCTION public.publish_scientific_knowledge(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_scientific_knowledge(uuid,text,text,jsonb) TO anon,authenticated;

CREATE FUNCTION public.knowledge_atlas(p_query text DEFAULT '',p_from integer DEFAULT 2000,p_to integer DEFAULT 2100,
 p_journal text DEFAULT '',p_design text DEFAULT '',p_concept text DEFAULT NULL,p_page integer DEFAULT 0,p_relation text DEFAULT 'concepts')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app_private.knowledge_reader();
 IF p_from IS NULL OR p_to IS NULL OR p_from<2000 OR p_to>2100 OR p_from>p_to OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 10000
   OR length(coalesce(p_query,''))>200 OR length(coalesce(p_journal,''))>500 OR length(coalesce(p_design,''))>100
   OR p_relation IS NULL OR p_relation NOT IN ('concepts','citations') THEN RAISE EXCEPTION 'Invalid atlas filters'; END IF;
 WITH all_docs AS MATERIALIZED (
  SELECT p.id,p.pmid,p.journal,p.pub_date,p.study_type,d.content_hash,d.updated_at,
   s.paper_id IS NOT NULL AS structured FROM app_private.knowledge_documents d JOIN public.papers p ON p.id=d.paper_id
   LEFT JOIN app_private.knowledge_science s ON s.paper_id=p.id AND s.content_hash=d.content_hash
 ), matched AS MATERIALIZED (
  SELECT * FROM all_docs p WHERE p.pub_date>=make_date(p_from,1,1) AND p.pub_date<make_date(p_to+1,1,1)
  AND (coalesce(p_journal,'')='' OR p.journal=p_journal) AND (coalesce(p_design,'')='' OR p.study_type=p_design)
  AND (p_concept IS NULL OR EXISTS(SELECT 1 FROM app_private.knowledge_memberships m WHERE m.paper_id=p.id AND m.concept_id=p_concept))
  AND (coalesce(p_query,'')='' OR p.pmid=p_query OR EXISTS(SELECT 1 FROM public.papers q WHERE q.id=p.id AND (position(lower(p_query) in lower(q.title))>0 OR lower(q.doi)=lower(p_query)))
   OR EXISTS(SELECT 1 FROM app_private.knowledge_memberships m JOIN app_private.knowledge_concepts c ON c.id=m.concept_id
    WHERE m.paper_id=p.id AND position(lower(p_query) in lower(c.label||' '||c.aliases::text))>0))
 ), concept_nodes AS MATERIALIZED (
  SELECT c.id,c.label,c.kind,count(*) AS document_count FROM matched p JOIN app_private.knowledge_memberships m ON m.paper_id=p.id
  JOIN app_private.knowledge_concepts c ON c.id=m.concept_id GROUP BY c.id ORDER BY count(*) DESC,c.id LIMIT 24
 ), concept_edges AS (
  SELECT a.concept_id AS source,b.concept_id AS target,count(*) AS weight FROM matched p
  JOIN app_private.knowledge_memberships a ON a.paper_id=p.id JOIN app_private.knowledge_memberships b ON b.paper_id=p.id AND b.concept_id>a.concept_id
  WHERE a.concept_id IN (SELECT id FROM concept_nodes) AND b.concept_id IN (SELECT id FROM concept_nodes)
  GROUP BY a.concept_id,b.concept_id ORDER BY count(*) DESC,a.concept_id,b.concept_id LIMIT 90
 ), citation_nodes AS MATERIALIZED (
  SELECT n.*,p.title,p.doi FROM (SELECT * FROM matched ORDER BY pub_date DESC,id DESC LIMIT 24) n JOIN public.papers p ON p.id=n.id
 ), citation_edges AS (
  SELECT DISTINCT a.pmid AS source,b.pmid AS target,1 AS weight FROM citation_nodes a
  JOIN app_private.knowledge_references r ON r.paper_id=a.id JOIN citation_nodes b
  ON b.pmid=r.target_pmid OR (r.target_doi IS NOT NULL AND lower(b.doi)=r.target_doi) WHERE a.id<>b.id
 ), selected AS (SELECT n.*,p.title,p.authors,p.doi FROM (SELECT * FROM matched ORDER BY pub_date DESC,id DESC LIMIT 21 OFFSET p_page*20) n JOIN public.papers p ON p.id=n.id)
 SELECT jsonb_build_object(
  'nodes',CASE WHEN p_relation='concepts' THEN coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY document_count DESC,id) FROM concept_nodes c),'[]')
   ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('id',pmid,'label',title,'kind','paper','document_count',1,'year',extract(year FROM pub_date)) ORDER BY pub_date DESC,id DESC) FROM citation_nodes),'[]') END,
  'edges',CASE WHEN p_relation='concepts' THEN coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM concept_edges e),'[]')
   ELSE coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM citation_edges e),'[]') END,
  'relationship',p_relation,'matched_documents',(SELECT count(*) FROM matched),
  'indexed_documents',(SELECT count(*) FROM all_docs),'structured_documents',(SELECT count(*) FROM matched WHERE structured),
  'updated_at',(SELECT max(updated_at) FROM all_docs),
  'years',coalesce((SELECT jsonb_agg(to_jsonb(y) ORDER BY year) FROM (SELECT extract(year FROM pub_date)::int AS year,count(*) AS papers,count(*) FILTER(WHERE structured) AS structured FROM matched GROUP BY 1) y),'[]'),
  'journals',coalesce((SELECT jsonb_agg(to_jsonb(j) ORDER BY papers DESC,label) FROM (SELECT journal AS label,count(*) AS papers FROM all_docs WHERE journal IS NOT NULL AND journal<>'' GROUP BY journal) j),'[]'),
  'designs',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY papers DESC,label) FROM (SELECT study_type AS label,count(*) AS papers FROM all_docs WHERE study_type IS NOT NULL AND study_type<>'' GROUP BY study_type) t),'[]'),
  'papers',coalesce((SELECT jsonb_agg(to_jsonb(p)-'id' ORDER BY pub_date DESC,id DESC) FROM selected p),'[]'),
  'groups',coalesce((SELECT payload->'groups' FROM app_private.knowledge_network WHERE id),'[]')
 ) INTO result;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.knowledge_atlas(text,integer,integer,text,text,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_atlas(text,integer,integer,text,text,text,integer,text) TO authenticated;

CREATE FUNCTION public.knowledge_paper(p_pmid text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='5s' AS $$
DECLARE result jsonb; pid bigint;
BEGIN
 PERFORM app_private.knowledge_reader();
 SELECT p.id,jsonb_build_object('pmid',p.pmid,'title',p.title,'authors',p.authors,'journal',p.journal,'pub_date',p.pub_date,
  'doi',p.doi,'volume',p.volume,'issue',p.issue,'pages',p.pages,'study_type',p.study_type,'publication_types',p.publication_types,
  'content_hash',d.content_hash,'indexed_at',d.updated_at,'science',s.payload,'science_updated_at',s.updated_at)
 INTO pid,result FROM public.papers p JOIN app_private.knowledge_documents d ON d.paper_id=p.id
 LEFT JOIN app_private.knowledge_science s ON s.paper_id=p.id AND s.content_hash=d.content_hash WHERE p.pmid=p_pmid;
 IF result IS NULL THEN RETURN NULL; END IF;
 RETURN result||jsonb_build_object('related_reports',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
  SELECT DISTINCT p.pmid,p.title,a.registry_id,a.relation AS source_relation,b.relation AS target_relation
  FROM app_private.knowledge_registries a JOIN app_private.knowledge_registries b ON b.registry_id=a.registry_id AND b.paper_id<>a.paper_id
  JOIN public.papers p ON p.id=b.paper_id WHERE a.paper_id=pid ORDER BY p.pmid LIMIT 40) x),'[]'));
END; $$;
REVOKE ALL ON FUNCTION public.knowledge_paper(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_paper(text) TO authenticated;
COMMIT;
