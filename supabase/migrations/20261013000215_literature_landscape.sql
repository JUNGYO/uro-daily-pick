-- Whole-catalog metadata landscape; original-derived citation coverage stays separate.
BEGIN;
CREATE TABLE app_private.literature_metadata (
 paper_id bigint PRIMARY KEY REFERENCES public.papers(id) ON DELETE CASCADE,
 pmid text NOT NULL, doi text, pub_date date, year int, journal text NOT NULL,
 subjects text[] NOT NULL, fulltext_available boolean NOT NULL, integrity_status text NOT NULL
);
CREATE INDEX literature_metadata_pmid ON app_private.literature_metadata(pmid);
CREATE INDEX literature_metadata_doi ON app_private.literature_metadata(doi) WHERE doi IS NOT NULL;
CREATE INDEX literature_metadata_subjects ON app_private.literature_metadata USING gin(subjects);
CREATE TABLE app_private.literature_metadata_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 through_id bigint NOT NULL DEFAULT 0, initial_max_id bigint NOT NULL,
 ready boolean NOT NULL DEFAULT false, initialized_at timestamptz
);
INSERT INTO app_private.literature_metadata_state(initial_max_id,ready,initialized_at)
 SELECT coalesce(max(id),0),max(id) IS NULL,CASE WHEN max(id) IS NULL THEN now() END FROM public.papers;
ALTER TABLE app_private.literature_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.literature_metadata_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.literature_metadata,app_private.literature_metadata_state FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.literature_subjects(terms jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(array_agg(label ORDER BY label),ARRAY[]::text[]) FROM (
  SELECT DISTINCT lower(btrim(value #>> '{}')) label
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(terms)='array' THEN terms ELSE '[]'::jsonb END)
  WHERE jsonb_typeof(value)='string'
 ) t WHERE label<>'' AND label NOT IN
 ('humans','male','female','animals','adult','young adult','middle aged','aged','aged, 80 and over','adolescent','child','child, preschool','infant','infant, newborn');
$$;
REVOKE ALL ON FUNCTION app_private.literature_subjects(jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.sync_literature_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO app_private.literature_metadata
 VALUES(NEW.id,NEW.pmid,nullif(lower(btrim(NEW.doi)),''),NEW.pub_date,extract(year FROM NEW.pub_date)::int,
 coalesce(NEW.journal,''),app_private.literature_subjects(NEW.mesh_terms),coalesce(NEW.fulltext_available,false),coalesce(NEW.integrity_status,'current'))
 ON CONFLICT(paper_id) DO UPDATE SET pmid=excluded.pmid,doi=excluded.doi,pub_date=excluded.pub_date,
 year=excluded.year,journal=excluded.journal,subjects=excluded.subjects,
 fulltext_available=excluded.fulltext_available,integrity_status=excluded.integrity_status;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.sync_literature_metadata() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER literature_metadata_insert AFTER INSERT ON public.papers
 FOR EACH ROW EXECUTE FUNCTION app_private.sync_literature_metadata();
CREATE TRIGGER literature_metadata_update AFTER UPDATE OF pmid,doi,pub_date,journal,mesh_terms,fulltext_available,integrity_status ON public.papers
 FOR EACH ROW WHEN ((OLD.pmid,OLD.doi,OLD.pub_date,OLD.journal,OLD.mesh_terms,OLD.fulltext_available,OLD.integrity_status)
 IS DISTINCT FROM (NEW.pmid,NEW.doi,NEW.pub_date,NEW.journal,NEW.mesh_terms,NEW.fulltext_available,NEW.integrity_status))
 EXECUTE FUNCTION app_private.sync_literature_metadata();

-- Operator-only, resumable initialization. Row locks prevent an old backfill row
-- from overwriting a concurrent catalog update. No wide backfill in the migration.
CREATE FUNCTION app_private.backfill_literature_metadata(p_batch int DEFAULT 1000) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE s app_private.literature_metadata_state; last_id bigint; n int;
BEGIN
 IF p_batch NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Invalid batch' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM app_private.literature_metadata_state WHERE singleton FOR UPDATE;
 IF s.ready THEN RETURN jsonb_build_object('ready',true,'through_id',s.through_id,'processed',0); END IF;
 WITH batch AS MATERIALIZED (
  SELECT id,pmid,doi,pub_date,journal,mesh_terms,fulltext_available,integrity_status FROM public.papers
  WHERE id>s.through_id AND id<=s.initial_max_id ORDER BY id LIMIT p_batch FOR UPDATE
 ), written AS (
  INSERT INTO app_private.literature_metadata
  SELECT id,pmid,nullif(lower(btrim(doi)),''),pub_date,extract(year FROM pub_date)::int,coalesce(journal,''),
   app_private.literature_subjects(mesh_terms),coalesce(fulltext_available,false),coalesce(integrity_status,'current') FROM batch
  ON CONFLICT(paper_id) DO UPDATE SET pmid=excluded.pmid,doi=excluded.doi,pub_date=excluded.pub_date,
   year=excluded.year,journal=excluded.journal,subjects=excluded.subjects,
   fulltext_available=excluded.fulltext_available,integrity_status=excluded.integrity_status
  RETURNING paper_id
 ) SELECT max(paper_id),count(*) INTO last_id,n FROM written;
 UPDATE app_private.literature_metadata_state SET through_id=coalesce(last_id,s.through_id),
  ready=n<p_batch,initialized_at=CASE WHEN n<p_batch THEN now() END WHERE singleton;
 RETURN jsonb_build_object('ready',n<p_batch,'through_id',coalesce(last_id,s.through_id),'processed',n);
END;
$$;
REVOKE ALL ON FUNCTION app_private.backfill_literature_metadata(int) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.knowledge_landscape(p_filters jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE f jsonb=coalesce(p_filters,'{}'); answer jsonb;
 yr1 int=(f->>'from')::int; yr2 int=(f->>'to')::int;
 pg int=coalesce((f->>'subject_page')::int,0); after_id bigint=(f->>'after')::bigint;
 paper_year int=(f->>'paper_year')::int; cy int=(f->>'citing_year')::int; ty int=(f->>'target_year')::int;
 mode text=coalesce(f->>'mode','topics'); edge_after text=coalesce(f->>'edge_after','');
BEGIN
 PERFORM app_private.knowledge_reader();
 IF NOT public.reader_access_allowed() THEN
  RAISE EXCEPTION 'Membership approval required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR f-ARRAY['from','to','journal','subject','subject_q','subject_page','after','paper_year','mode','citing_year','target_year','edge_after']<>'{}'
  OR yr1 NOT BETWEEN 1000 AND 3000 OR yr2 NOT BETWEEN 1000 AND 3000 OR yr1>yr2
  OR pg NOT BETWEEN 0 AND 10000 OR after_id<0 OR paper_year NOT BETWEEN 0 AND 3000
  OR cy NOT BETWEEN 0 AND 3000 OR ty NOT BETWEEN 0 AND 3000
  OR mode NOT IN ('topics','citations') OR length(edge_after)>150
  OR length(coalesce(f->>'subject',''))>500 OR length(coalesce(f->>'subject_q',''))>200
  OR length(coalesce(f->>'journal',''))>500 THEN
  RAISE EXCEPTION 'Invalid landscape filters' USING ERRCODE='22023'; END IF;
 IF NOT (SELECT ready FROM app_private.literature_metadata_state WHERE singleton) THEN
  RETURN jsonb_build_object('ready',false); END IF;
 WITH catalog AS MATERIALIZED (
  SELECT * FROM app_private.literature_metadata WHERE integrity_status='current'
 ), base AS MATERIALIZED (
  SELECT * FROM catalog WHERE (yr1 IS NULL OR year>=yr1) AND (yr2 IS NULL OR year<=yr2)
   AND (coalesce(f->>'journal','')='' OR journal=f->>'journal')
 ), scoped AS MATERIALIZED (
  SELECT * FROM base WHERE coalesce(f->>'subject','')=''
   OR f->>'subject'=ANY(subjects) OR (f->>'subject'='__unassigned__' AND cardinality(subjects)=0)
 ), topic_year AS MATERIALIZED (
  SELECT topic,year,count(*) papers FROM base
  CROSS JOIN LATERAL unnest(CASE WHEN cardinality(subjects)=0 THEN ARRAY['__unassigned__'] ELSE subjects END) topic
  GROUP BY topic,year
 ), topics AS MATERIALIZED (
  SELECT topic,sum(papers) papers,jsonb_agg(jsonb_build_object('year',year,'papers',papers) ORDER BY year NULLS LAST) years
  FROM topic_year WHERE coalesce(f->>'subject_q','')='' OR position(lower(f->>'subject_q') in
   CASE WHEN topic='__unassigned__' THEN 'no subject metadata' ELSE topic END)>0
  GROUP BY topic
 ), topic_page AS (
  SELECT * FROM topics ORDER BY papers DESC,topic COLLATE "C" LIMIT 20 OFFSET pg*20
 ), selected AS MATERIALIZED (
  SELECT * FROM scoped WHERE paper_year IS NULL OR coalesce(year,0)=paper_year
 ), paper_page AS MATERIALIZED (
  SELECT * FROM selected WHERE after_id IS NULL OR paper_id<after_id ORDER BY paper_id DESC LIMIT 21
 ), docs AS MATERIALIZED (
  SELECT p.*,d.content_hash,b.paper_id IS NOT NULL OR coalesce(s.payload->'bibliography'->>'source'='PubMed',false) metadata_available,
   coalesce(b.references_data,'[]'::jsonb)||coalesce(s.payload->'bibliography'->'references','[]'::jsonb) refs
  FROM scoped p JOIN app_private.knowledge_documents d ON d.paper_id=p.paper_id
  LEFT JOIN app_private.knowledge_bibliographies b ON b.paper_id=d.paper_id AND b.content_hash=d.content_hash
  LEFT JOIN app_private.knowledge_science s ON s.paper_id=d.paper_id AND s.content_hash=d.content_hash
 ), refs AS MATERIALIZED (
  SELECT DISTINCT d.paper_id,d.year source_year,d.pmid source_pmid,
   nullif(r->>'pmid','') pmid,nullif(lower(btrim(r->>'doi')),'') doi
  FROM docs d CROSS JOIN LATERAL jsonb_array_elements(d.refs) r WHERE mode='citations'
   AND (nullif(r->>'pmid','') IS NOT NULL OR nullif(btrim(r->>'doi'),'') IS NOT NULL)
 ), edges AS MATERIALIZED (
  SELECT DISTINCT r.paper_id,r.source_year,r.source_pmid,
   coalesce(c.pmid,r.pmid,'doi:'||r.doi) target_key,coalesce(c.pmid,r.pmid) target_pmid,
   coalesce(c.doi,r.doi) target_doi,c.paper_id target_id,c.year target_year,c.integrity_status target_status
  FROM refs r LEFT JOIN LATERAL (
   SELECT m.* FROM app_private.literature_metadata m WHERE m.pmid=r.pmid
    OR (r.pmid IS NULL AND m.doi=r.doi) ORDER BY m.paper_id LIMIT 1
  ) c ON true WHERE coalesce(c.pmid,r.pmid,'doi:'||r.doi)<>r.source_pmid
 ), unique_edges AS MATERIALIZED (
  -- PMID and DOI occurrences resolving to the same catalog target count once.
  SELECT DISTINCT ON(paper_id,target_key) *,paper_id::text||':'||target_key edge_key
  FROM edges ORDER BY paper_id,target_key,target_doi NULLS LAST
 ), flow AS (
  SELECT source_year,target_year,count(*) links,count(DISTINCT paper_id) citing_papers
  FROM unique_edges GROUP BY source_year,target_year
 ), chosen_edges AS MATERIALIZED (
  SELECT * FROM unique_edges WHERE (cy IS NULL OR coalesce(source_year,0)=cy)
   AND (ty IS NULL OR coalesce(target_year,0)=ty)
 ), edge_page AS (
  SELECT * FROM chosen_edges WHERE edge_key COLLATE "C">edge_after COLLATE "C" ORDER BY edge_key COLLATE "C" LIMIT 21
 )
 SELECT jsonb_build_object('ready',true,'filters',f,
  'coverage',jsonb_build_object('catalog_papers',(SELECT count(*) FROM catalog),
   'matching_papers',(SELECT count(*) FROM base),'subject_papers',(SELECT count(*) FROM base WHERE cardinality(subjects)>0),
   'unknown_year',(SELECT count(*) FROM base WHERE year IS NULL),'selected_papers',(SELECT count(*) FROM scoped),
   'fulltext_papers',(SELECT count(*) FROM scoped WHERE fulltext_available),
   'indexed_papers',(SELECT count(*) FROM docs),'reference_metadata_papers',(SELECT count(*) FROM docs WHERE metadata_available),
   'papers_with_reference_ids',(SELECT count(*) FROM docs WHERE jsonb_array_length(refs)>0),
   'citation_links',(SELECT count(*) FROM unique_edges),'unknown_target_year_links',(SELECT count(*) FROM unique_edges WHERE target_year IS NULL)),
  'years',coalesce((SELECT jsonb_agg(to_jsonb(y) ORDER BY year NULLS LAST) FROM (SELECT year,count(*) papers FROM base GROUP BY year)y),'[]'),
  'journals',coalesce((SELECT jsonb_agg(to_jsonb(j) ORDER BY papers DESC,label) FROM (SELECT journal label,count(*) papers FROM catalog WHERE journal<>'' GROUP BY journal)j),'[]'),
  'subjects',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY papers DESC,topic COLLATE "C") FROM topic_page t),'[]'),
  'subject_count',(SELECT count(*) FROM topics),'subject_page',pg,
  'paper_count',(SELECT count(*) FROM selected),
  'papers',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY id DESC) FROM (
   SELECT p.id,p.pmid,p.title,p.journal,p.pub_date FROM (SELECT * FROM paper_page ORDER BY paper_id DESC LIMIT 20)m JOIN public.papers p ON p.id=m.paper_id)p),'[]'),
  'next_after',CASE WHEN (SELECT count(*) FROM paper_page)>20 THEN (SELECT min(paper_id) FROM (SELECT * FROM paper_page ORDER BY paper_id DESC LIMIT 20) x) END,
  'flows',coalesce((SELECT jsonb_agg(to_jsonb(fl) ORDER BY source_year NULLS LAST,target_year NULLS LAST) FROM flow fl),'[]'),
  'edge_count',(SELECT count(*) FROM chosen_edges),
  'citation_papers',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY edge_key COLLATE "C") FROM (
   SELECT ep.*,a.title source_title,b.title target_title FROM (SELECT * FROM edge_page ORDER BY edge_key COLLATE "C" LIMIT 20)ep
   JOIN public.papers a ON a.id=ep.paper_id LEFT JOIN public.papers b ON b.id=ep.target_id)e),'[]'),
  'next_edge',CASE WHEN (SELECT count(*) FROM edge_page)>20 THEN (SELECT max(edge_key COLLATE "C") FROM (SELECT * FROM edge_page ORDER BY edge_key COLLATE "C" LIMIT 20)x) END
 ) INTO answer;
 RETURN answer;
END;
$$;
REVOKE ALL ON FUNCTION public.knowledge_landscape(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_landscape(jsonb) TO authenticated;
-- Deployment readiness is visible only to the service preflight, not readers.
CREATE FUNCTION public.literature_landscape_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT ready FROM app_private.literature_metadata_state WHERE singleton),false);
$$;
REVOKE ALL ON FUNCTION public.literature_landscape_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.literature_landscape_ready() TO service_role;
COMMIT;
