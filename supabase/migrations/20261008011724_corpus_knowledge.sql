-- Shared original-derived knowledge; private projects/notes never enter this corpus.
BEGIN;
CREATE TABLE app_private.knowledge_documents (
 paper_id bigint PRIMARY KEY REFERENCES public.papers(id) ON DELETE CASCADE,
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 revision text NOT NULL CHECK(revision ~ '^[0-9a-f]{64}$'),
 version text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_private.knowledge_concepts (
 id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{24}$'), label text NOT NULL,
 label_ko text NOT NULL, kind text NOT NULL CHECK(kind IN ('condition','intervention','test','outcome','method')),
 aliases jsonb NOT NULL DEFAULT '[]', document_count integer NOT NULL DEFAULT 0
);
CREATE INDEX knowledge_concept_rank ON app_private.knowledge_concepts(document_count DESC,id);
CREATE TABLE app_private.knowledge_memberships (
 concept_id text NOT NULL REFERENCES app_private.knowledge_concepts(id),
 paper_id bigint NOT NULL REFERENCES app_private.knowledge_documents(paper_id) ON DELETE CASCADE,
 PRIMARY KEY(concept_id,paper_id)
);
CREATE INDEX knowledge_membership_paper ON app_private.knowledge_memberships(paper_id,concept_id);
CREATE TABLE app_private.knowledge_pages (
 concept_id text PRIMARY KEY REFERENCES app_private.knowledge_concepts(id),
 revision text NOT NULL CHECK(revision ~ '^[0-9a-f]{64}$'),
 paragraphs jsonb NOT NULL, version text NOT NULL, stale boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_private.knowledge_dependencies (
 concept_id text NOT NULL REFERENCES app_private.knowledge_pages(concept_id) ON DELETE CASCADE,
 paper_id bigint NOT NULL REFERENCES public.papers(id) ON DELETE CASCADE,
 PRIMARY KEY(concept_id,paper_id)
);
CREATE INDEX knowledge_dependency_paper ON app_private.knowledge_dependencies(paper_id,concept_id);
CREATE TABLE app_private.knowledge_network (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), revision text NOT NULL, payload jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_private.knowledge_network ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.knowledge_network FROM PUBLIC,anon,authenticated;
ALTER TABLE app_private.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.knowledge_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.knowledge_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.knowledge_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.knowledge_dependencies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.knowledge_documents,app_private.knowledge_concepts,app_private.knowledge_memberships,
 app_private.knowledge_pages,app_private.knowledge_dependencies FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.knowledge_reader() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM auth.users u JOIN public.profiles p ON p.id=u.id
   WHERE u.id=auth.uid() AND u.email_confirmed_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Reader authentication required' USING ERRCODE='42501'; END IF;
END; $$;
REVOKE ALL ON FUNCTION app_private.knowledge_reader() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.knowledge_count() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   UPDATE app_private.knowledge_concepts SET document_count=document_count+1 WHERE id=NEW.concept_id;
   RETURN NEW;
 END IF;
 UPDATE app_private.knowledge_concepts SET document_count=greatest(0,document_count-1) WHERE id=OLD.concept_id;
 RETURN OLD;
END; $$;
CREATE TRIGGER knowledge_membership_count AFTER INSERT OR DELETE ON app_private.knowledge_memberships
 FOR EACH ROW EXECUTE FUNCTION app_private.knowledge_count();
REVOKE ALL ON FUNCTION app_private.knowledge_count() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.invalidate_knowledge() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE pid bigint;
BEGIN
 IF TG_TABLE_NAME='papers' THEN
   pid=OLD.id;
   IF TG_OP='UPDATE' AND (NEW.title,NEW.integrity_status,NEW.related_notices,NEW.fulltext_available)
      IS NOT DISTINCT FROM (OLD.title,OLD.integrity_status,OLD.related_notices,OLD.fulltext_available) THEN RETURN NEW; END IF;
 ELSE
   pid=OLD.paper_id;
   IF TG_OP='UPDATE' AND (NEW.title,NEW.content_hash) IS NOT DISTINCT FROM (OLD.title,OLD.content_hash) THEN RETURN NEW; END IF;
 END IF;
 UPDATE app_private.knowledge_pages SET stale=true WHERE concept_id IN
   (SELECT concept_id FROM app_private.knowledge_dependencies WHERE paper_id=pid);
 DELETE FROM app_private.knowledge_documents WHERE paper_id=pid;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER invalidate_knowledge_paper BEFORE UPDATE OF title,integrity_status,related_notices,fulltext_available OR DELETE ON public.papers
 FOR EACH ROW EXECUTE FUNCTION app_private.invalidate_knowledge();
CREATE TRIGGER invalidate_knowledge_original BEFORE UPDATE OF title,content_hash OR DELETE ON app_private.local_fulltext_sources
 FOR EACH ROW EXECUTE FUNCTION app_private.invalidate_knowledge();
REVOKE ALL ON FUNCTION app_private.invalidate_knowledge() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.publish_knowledge(p_worker_id uuid,p_token text,p_kind text,p_revision text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE identity text; pid bigint; item jsonb; paragraph jsonb; source jsonb; location jsonb;
 original app_private.local_fulltext_sources; previous text; old_concepts text[];
BEGIN
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 IF p_revision IS NULL OR p_revision !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
   OR octet_length(p_payload::text)>180000 OR p_payload->>'version' IS DISTINCT FROM 'corpus-v1' THEN
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
REVOKE ALL ON FUNCTION public.publish_knowledge(uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_knowledge(uuid,text,text,text,jsonb) TO anon,authenticated;

CREATE FUNCTION public.knowledge_search(p_query text DEFAULT '',p_pmid text DEFAULT NULL,p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='5s' AS $$
DECLARE q text=lower(trim(coalesce(p_query,''))); result jsonb;
BEGIN
 PERFORM app_private.knowledge_reader();
 IF length(q)>200 OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 1000 THEN RAISE EXCEPTION 'Invalid search'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM (
   SELECT c.*,CASE WHEN w.stale=false AND jsonb_array_length(w.paragraphs)>0 THEN 'ready' ELSE 'building' END AS status
   FROM app_private.knowledge_concepts c LEFT JOIN app_private.knowledge_pages w ON w.concept_id=c.id
   WHERE c.document_count>0 AND (q='' OR position(q in lower(c.label||' '||c.label_ko||' '||c.aliases::text))>0)
     AND (p_pmid IS NULL OR EXISTS(SELECT 1 FROM app_private.knowledge_memberships m JOIN public.papers p ON p.id=m.paper_id WHERE m.concept_id=c.id AND p.pmid=p_pmid))
   ORDER BY c.document_count DESC,c.id LIMIT 21 OFFSET p_page*20) x;
 RETURN jsonb_build_object('items',result,'indexed_documents',(SELECT count(*) FROM app_private.knowledge_documents),
   'updated_at',(SELECT max(updated_at) FROM app_private.knowledge_documents));
END; $$;
REVOKE ALL ON FUNCTION public.knowledge_search(text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_search(text,text,integer) TO authenticated;

CREATE FUNCTION public.knowledge_page(p_id text,p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='5s' AS $$
DECLARE concept jsonb; wiki jsonb; papers jsonb; neighbors jsonb;
BEGIN
 PERFORM app_private.knowledge_reader();
 IF p_page IS NULL OR p_page NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'Invalid page'; END IF;
 SELECT to_jsonb(c) INTO concept FROM app_private.knowledge_concepts c WHERE c.id=p_id AND document_count>0;
 IF concept IS NULL THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('revision',revision,'updated_at',updated_at,'status',CASE WHEN stale THEN 'updating' ELSE 'ready' END,
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
REVOKE ALL ON FUNCTION public.knowledge_page(text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_page(text,integer) TO authenticated;

CREATE FUNCTION public.knowledge_graph(p_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE ids text[]; nodes jsonb; edges jsonb;
BEGIN
 PERFORM app_private.knowledge_reader();
 IF p_id IS NULL THEN
   SELECT array_agg(id) INTO ids FROM (SELECT id FROM app_private.knowledge_concepts WHERE document_count>0 ORDER BY document_count DESC,id LIMIT 30) x;
 ELSE
   SELECT array_agg(id) INTO ids FROM (SELECT b.concept_id AS id FROM app_private.knowledge_memberships a
     JOIN app_private.knowledge_memberships b ON b.paper_id=a.paper_id WHERE a.concept_id=p_id
     GROUP BY b.concept_id ORDER BY count(*) DESC,b.concept_id LIMIT 30) x;
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY document_count DESC,id),'[]') INTO nodes FROM app_private.knowledge_concepts c WHERE id=ANY(ids);
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO edges FROM (
   SELECT a.concept_id AS source,b.concept_id AS target,count(*) AS weight
   FROM app_private.knowledge_memberships a JOIN app_private.knowledge_memberships b ON b.paper_id=a.paper_id AND b.concept_id>a.concept_id
   WHERE a.concept_id=ANY(ids) AND b.concept_id=ANY(ids) GROUP BY a.concept_id,b.concept_id ORDER BY count(*) DESC,a.concept_id,b.concept_id LIMIT 90) x;
 RETURN jsonb_build_object('nodes',nodes,'edges',edges,'relationship','shared_papers',
   'groups',coalesce((SELECT payload->'groups' FROM app_private.knowledge_network WHERE id),'[]'),
   'group_scope',(SELECT payload->'scope_concepts' FROM app_private.knowledge_network WHERE id),
   'groups_updated_at',(SELECT updated_at FROM app_private.knowledge_network WHERE id));
END; $$;
REVOKE ALL ON FUNCTION public.knowledge_graph(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_graph(text) TO authenticated;
COMMIT;
