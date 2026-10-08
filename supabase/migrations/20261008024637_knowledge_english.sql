-- English wiki prose has a separate recipe; source indexes/checkpoints retain their version.
BEGIN;
CREATE OR REPLACE FUNCTION public.publish_knowledge(p_worker_id uuid,p_token text,p_kind text,p_revision text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE identity text; pid bigint; item jsonb; paragraph jsonb; source jsonb; location jsonb;
 original app_private.local_fulltext_sources; previous text; old_concepts text[];
BEGIN
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 IF p_revision IS NULL OR p_revision !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
   OR octet_length(p_payload::text)>180000 OR p_payload->>'version' IS DISTINCT FROM (CASE WHEN p_kind='page' THEN 'corpus-v1-en' ELSE 'corpus-v1' END) THEN
   RAISE EXCEPTION 'Invalid knowledge publication' USING ERRCODE='22023'; END IF;
 IF p_kind='source' THEN
   identity=p_payload->>'pmid';
   IF coalesce(identity,'') !~ '^[0-9]{1,12}$' OR p_payload-ARRAY['pmid','title','content_hash','version','concepts']<>'{}'
     OR jsonb_typeof(p_payload->'concepts') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_payload->'concepts')>256 THEN
     RAISE EXCEPTION 'Invalid knowledge document' USING ERRCODE='22023'; END IF;
   SELECT p.id INTO STRICT pid FROM public.papers p WHERE p.pmid=identity
     AND p.title=p_payload->>'title' AND p.pub_date>='2000-01-01' AND p.integrity_status='current' AND p.fulltext_available FOR UPDATE;
   SELECT * INTO STRICT original FROM app_private.local_fulltext_sources s
     WHERE s.paper_id=pid AND s.content_hash=p_payload->>'content_hash' AND s.title=p_payload->>'title' AND s.worker_id=p_worker_id;
   SELECT revision INTO previous FROM app_private.knowledge_documents WHERE paper_id=pid;
   IF previous=p_revision THEN RETURN jsonb_build_object('id',identity,'revision',p_revision); END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'concepts') c GROUP BY c->>'id' HAVING count(*)>1) THEN
     RAISE EXCEPTION 'Duplicate concept'; END IF;
   FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'concepts') LOOP
     IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['id','label','label_ko','kind','aliases']<>'{}'
       OR coalesce(item->>'id','') !~ '^[0-9a-f]{24}$'
       OR coalesce(length(item->>'label'),0) NOT BETWEEN 3 AND 140 OR coalesce(length(item->>'label_ko'),0) NOT BETWEEN 2 AND 140
       OR coalesce(item->>'kind','') NOT IN ('condition','intervention','test','outcome','method')
       OR jsonb_typeof(item->'aliases') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'aliases')>4
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'aliases') a WHERE jsonb_typeof(a)<>'string' OR length(a#>>'{}') NOT BETWEEN 2 AND 140) THEN
       RAISE EXCEPTION 'Invalid concept fields' USING ERRCODE='22023'; END IF;
   END LOOP;
   SELECT array_agg(concept_id) INTO old_concepts FROM app_private.knowledge_memberships WHERE paper_id=pid;
   UPDATE app_private.knowledge_pages SET stale=true WHERE concept_id IN
     (SELECT concept_id FROM app_private.knowledge_dependencies WHERE paper_id=pid);
   INSERT INTO app_private.knowledge_documents VALUES(pid,p_payload->>'content_hash',p_revision,p_payload->>'version',now())
     ON CONFLICT(paper_id) DO UPDATE SET content_hash=excluded.content_hash,revision=excluded.revision,version=excluded.version,updated_at=now();
   DELETE FROM app_private.knowledge_memberships WHERE paper_id=pid;
   FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'concepts') LOOP
     INSERT INTO app_private.knowledge_concepts(id,label,label_ko,kind,aliases)
       VALUES(item->>'id',item->>'label',item->>'label_ko',item->>'kind',item->'aliases') ON CONFLICT(id) DO NOTHING;
     IF NOT EXISTS(SELECT 1 FROM app_private.knowledge_concepts WHERE id=item->>'id' AND kind=item->>'kind'
       AND lower(label)=lower(item->>'label')) THEN RAISE EXCEPTION 'Concept identity collision'; END IF;
     INSERT INTO app_private.knowledge_memberships VALUES(item->>'id',pid);
   END LOOP;
 ELSIF p_kind='network' THEN
   identity='corpus';
   IF p_payload-ARRAY['version','groups','scope_concepts','source_documents']<>'{}'
     OR jsonb_typeof(p_payload->'groups') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'groups')>375
     OR coalesce(p_payload->>'scope_concepts','') !~ '^[0-9]{1,3}$' OR (p_payload->>'scope_concepts')::integer>750
     OR coalesce(p_payload->>'source_documents','') !~ '^[0-9]{1,9}$' THEN RAISE EXCEPTION 'Invalid corpus groups'; END IF;
   FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'groups') LOOP
     IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['id','label','concepts']<>'{}'
       OR coalesce(item->>'id','') !~ '^[0-9a-f]{24}$' OR coalesce(length(item->>'label'),0) NOT BETWEEN 2 AND 140
       OR jsonb_typeof(item->'concepts') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'concepts') NOT BETWEEN 2 AND 750
       OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(item->'concepts') m WHERE NOT EXISTS(SELECT 1 FROM app_private.knowledge_concepts c WHERE c.id=m)) THEN
       RAISE EXCEPTION 'Invalid group membership'; END IF;
   END LOOP;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'groups') g CROSS JOIN LATERAL jsonb_array_elements_text(g->'concepts') m GROUP BY m HAVING count(*)>1) THEN RAISE EXCEPTION 'Repeated group concept'; END IF;
   INSERT INTO app_private.knowledge_network VALUES(true,p_revision,p_payload,now()) ON CONFLICT(id)
     DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=now();
 ELSIF p_kind='page' THEN
   identity=p_payload->>'id';
   IF coalesce(identity,'') !~ '^[0-9a-f]{24}$' OR p_payload-ARRAY['id','version','paragraphs']<>'{}'
     OR jsonb_typeof(p_payload->'paragraphs') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'paragraphs')>5 THEN
     RAISE EXCEPTION 'Invalid knowledge page' USING ERRCODE='22023'; END IF;
   PERFORM 1 FROM app_private.knowledge_concepts WHERE id=identity FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Publish source concepts first'; END IF;
   -- Validate source dependencies even on an idempotent replay: a source can change.
   FOR paragraph IN SELECT value FROM jsonb_array_elements(p_payload->'paragraphs') LOOP
     IF jsonb_typeof(paragraph) IS DISTINCT FROM 'object' OR paragraph-ARRAY['text','sources']<>'{}'
       OR coalesce(length(paragraph->>'text'),0) NOT BETWEEN 5 AND 700
       OR paragraph->>'text' !~ '[A-Za-z]' OR paragraph->>'text' ~ U&'[\1100-\11FF\3130-\318F\AC00-\D7AF\3040-\30FF\3400-\9FFF]'
       OR jsonb_typeof(paragraph->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(paragraph->'sources') NOT BETWEEN 1 AND 6 THEN
       RAISE EXCEPTION 'Invalid wiki paragraph'; END IF;
     FOR source IN SELECT value FROM jsonb_array_elements(paragraph->'sources') LOOP
       IF jsonb_typeof(source) IS DISTINCT FROM 'object' OR source-ARRAY['pmid','content_hash','locations']<>'{}'
         OR coalesce(source->>'pmid','') !~ '^[0-9]{1,12}$' OR coalesce(source->>'content_hash','') !~ '^[0-9a-f]{64}$'
         OR jsonb_typeof(source->'locations') IS DISTINCT FROM 'array' OR jsonb_array_length(source->'locations') NOT BETWEEN 1 AND 18 THEN
         RAISE EXCEPTION 'Invalid wiki source'; END IF;
       SELECT s.* INTO STRICT original FROM app_private.local_fulltext_sources s JOIN public.papers p ON p.id=s.paper_id
         JOIN app_private.knowledge_documents d ON d.paper_id=p.id
         JOIN app_private.knowledge_memberships m ON m.paper_id=p.id AND m.concept_id=identity
         WHERE p.pmid=source->>'pmid' AND p.integrity_status='current' AND p.fulltext_available
         AND p.title=s.title AND s.content_hash=source->>'content_hash' AND d.content_hash=s.content_hash AND s.worker_id=p_worker_id
         FOR SHARE OF p,s,d;
       FOR location IN SELECT value FROM jsonb_array_elements(source->'locations') LOOP
         IF jsonb_typeof(location)<>'string' OR (location#>>'{}') !~ '^(p|table|figure)-[0-9]{7}$'
           OR substring(location#>>'{}' from '[0-9]+$')::integer>=original.characters THEN
           RAISE EXCEPTION 'Invalid source location'; END IF;
       END LOOP;
     END LOOP;
   END LOOP;
   INSERT INTO app_private.knowledge_pages VALUES(identity,p_revision,p_payload->'paragraphs',p_payload->>'version',false,now())
     ON CONFLICT(concept_id) DO UPDATE SET revision=excluded.revision,paragraphs=excluded.paragraphs,version=excluded.version,stale=false,updated_at=now();
   DELETE FROM app_private.knowledge_dependencies WHERE concept_id=identity;
   INSERT INTO app_private.knowledge_dependencies
     SELECT DISTINCT identity,p.id FROM jsonb_array_elements(p_payload->'paragraphs') a
     CROSS JOIN LATERAL jsonb_array_elements(a->'sources') s JOIN public.papers p ON p.pmid=s->>'pmid';
 ELSE RAISE EXCEPTION 'Unsupported knowledge publication' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('id',identity,'revision',p_revision);
END; $$;

-- Hide legacy prose while the local worker regenerates it from verified findings.
UPDATE app_private.knowledge_pages SET stale=true WHERE version<>'corpus-v1-en';
COMMIT;
