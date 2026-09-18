-- Separate completed classification (including "other") from pending work.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.papers
 ADD COLUMN classification_version integer NOT NULL DEFAULT 0,
 ADD COLUMN classification_source_hash text,
 ADD COLUMN classified_at timestamptz;

CREATE INDEX idx_papers_classification_pending ON public.papers(id)
 WHERE classification_version<1 AND pub_date>=DATE '2000-01-01';

CREATE FUNCTION app_private.classification_pub_types(p_publication_types jsonb,p_pub_types jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN p_publication_types IS NOT NULL AND p_publication_types<>'[]'::jsonb
  THEN p_publication_types ELSE coalesce(p_pub_types,'[]'::jsonb) END
$$;

CREATE FUNCTION app_private.classification_fingerprint(p_title text,p_abstract text,p_mesh_terms jsonb,p_pub_types jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array('classification-v1',coalesce(p_title,''),
  coalesce(p_abstract,''),coalesce(p_mesh_terms,'[]'::jsonb),coalesce(p_pub_types,'[]'::jsonb))::text,'UTF8')),'hex')
$$;

CREATE FUNCTION app_private.preserve_classification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.classification_version:=0;
  NEW.classification_source_hash:=NULL;
  NEW.classified_at:=NULL;
 ELSIF ROW(coalesce(NEW.title,''),coalesce(NEW.abstract,''),coalesce(NEW.mesh_terms,'[]'::jsonb),
    app_private.classification_pub_types(NEW.publication_types,NEW.pub_types))
  IS DISTINCT FROM ROW(coalesce(OLD.title,''),coalesce(OLD.abstract,''),coalesce(OLD.mesh_terms,'[]'::jsonb),
    app_private.classification_pub_types(OLD.publication_types,OLD.pub_types)) THEN
  NEW.classification_version:=0;
  NEW.classification_source_hash:=NULL;
  NEW.classified_at:=NULL;
 ELSIF OLD.classification_version>=1 THEN
  -- A citation replay may contain a stale ingestion fallback. Version 1 is
  -- deterministic for the same source; only changed input requires more work.
  NEW.study_type:=OLD.study_type;
  NEW.classification_version:=OLD.classification_version;
  NEW.classification_source_hash:=OLD.classification_source_hash;
  NEW.classified_at:=OLD.classified_at;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_classification BEFORE INSERT OR UPDATE ON public.papers
 FOR EACH ROW EXECUTE FUNCTION app_private.preserve_classification();

CREATE FUNCTION public.classification_candidates(p_after_id bigint DEFAULT 0,p_limit integer DEFAULT 100,
 p_reclassify_all boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF p_after_id IS NULL OR p_after_id<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
   OR p_reclassify_all IS NULL THEN
  RAISE EXCEPTION 'Invalid classification page' USING ERRCODE='22023';
 END IF;
 -- Separate plans retain the partial-index path for normal pending work.
 IF p_reclassify_all THEN
  WITH page AS MATERIALIZED (
   SELECT p.id,p.pmid,p.title,p.abstract,p.mesh_terms,
    app_private.classification_pub_types(p.publication_types,p.pub_types) AS pub_types,p.study_type
   FROM public.papers p WHERE p.id>p_after_id AND p.pub_date>=DATE '2000-01-01'
   ORDER BY p.id LIMIT p_limit)
  SELECT coalesce(jsonb_agg(to_jsonb(page)||jsonb_build_object('classification_source_hash',
    app_private.classification_fingerprint(page.title,page.abstract,page.mesh_terms,page.pub_types)) ORDER BY page.id),'[]'::jsonb)
   INTO result FROM page;
 ELSE
  WITH page AS MATERIALIZED (
   SELECT p.id,p.pmid,p.title,p.abstract,p.mesh_terms,
    app_private.classification_pub_types(p.publication_types,p.pub_types) AS pub_types,p.study_type
   FROM public.papers p WHERE p.id>p_after_id AND p.pub_date>=DATE '2000-01-01'
    AND p.classification_version<1 ORDER BY p.id LIMIT p_limit)
  SELECT coalesce(jsonb_agg(to_jsonb(page)||jsonb_build_object('classification_source_hash',
    app_private.classification_fingerprint(page.title,page.abstract,page.mesh_terms,page.pub_types)) ORDER BY page.id),'[]'::jsonb)
   INTO result FROM page;
 END IF;
 RETURN result;
END;
$$;

CREATE FUNCTION public.apply_paper_classifications(p_results jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; paper_key bigint; seen bigint[]:='{}'; paper public.papers%ROWTYPE;
 updated_count integer:=0; stale_count integer:=0; expected_hash text;
BEGIN
 IF p_results IS NULL OR jsonb_typeof(p_results)<>'array' OR jsonb_array_length(p_results)>200
   OR octet_length(p_results::text)>100000 THEN
  RAISE EXCEPTION 'Invalid classification batch' USING ERRCODE='22023';
 END IF;
 -- Validate the complete envelope before taking any row locks or writing.
 FOR item IN SELECT value FROM jsonb_array_elements(p_results) LOOP
  IF jsonb_typeof(item)<>'object' OR (item-ARRAY['id','source_hash','study_type'])<>'{}'::jsonb
    OR NOT (item ?& ARRAY['id','source_hash','study_type'])
    OR jsonb_typeof(item->'id')<>'number' OR (item->>'id') !~ '^[1-9][0-9]{0,18}$'
    OR jsonb_typeof(item->'source_hash')<>'string' OR (item->>'source_hash') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(item->'study_type')<>'string' OR (item->>'study_type') NOT IN
      ('rct','meta_analysis','guideline','case_report','ai_ml','imaging','biomarker','surgical',
       'basic_research','prospective','retrospective','epidemiology','review','other') THEN
   RAISE EXCEPTION 'Invalid classification result' USING ERRCODE='22023';
  END IF;
  paper_key:=(item->>'id')::bigint;
  IF paper_key=ANY(seen) THEN
   RAISE EXCEPTION 'Duplicate classification result' USING ERRCODE='22023';
  END IF;
  seen:=array_append(seen,paper_key);
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(p_results) ORDER BY (value->>'id')::bigint LOOP
  SELECT p.* INTO paper FROM public.papers p WHERE p.id=(item->>'id')::bigint FOR UPDATE;
  IF NOT FOUND OR paper.pub_date IS NULL OR paper.pub_date<DATE '2000-01-01' THEN
   stale_count:=stale_count+1;
   CONTINUE;
  END IF;
  expected_hash:=app_private.classification_fingerprint(paper.title,paper.abstract,paper.mesh_terms,
   app_private.classification_pub_types(paper.publication_types,paper.pub_types));
  IF expected_hash IS DISTINCT FROM item->>'source_hash' THEN
   stale_count:=stale_count+1;
   CONTINUE;
  END IF;
  IF paper.classification_version=1 AND paper.classification_source_hash=expected_hash
    AND paper.study_type IS NOT DISTINCT FROM item->>'study_type' AND paper.classified_at IS NOT NULL THEN
   -- A lost response can be retried without rewriting an already-completed row.
   updated_count:=updated_count+1;
   CONTINUE;
  END IF;
  UPDATE public.papers SET study_type=item->>'study_type',classification_version=1,
   classification_source_hash=expected_hash,classified_at=now() WHERE id=paper.id;
  updated_count:=updated_count+1;
 END LOOP;
 RETURN jsonb_build_object('updated',updated_count,'stale',stale_count);
END;
$$;

REVOKE ALL ON FUNCTION app_private.classification_pub_types(jsonb,jsonb),
 app_private.classification_fingerprint(text,text,jsonb,jsonb),app_private.preserve_classification()
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.classification_candidates(bigint,integer,boolean),
 public.apply_paper_classifications(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.classification_candidates(bigint,integer,boolean),
 public.apply_paper_classifications(jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
