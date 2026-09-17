-- Reduce unnecessary work while preserving the current intake guard and grants.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.sync_institution_catalog(p_worker_id uuid,p_token text,p_papers jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; field text; element jsonb; paper_key bigint; publication_date date;
 accepted jsonb:='[]'; capacity_blocked boolean:=false; budget bigint; stamp timestamptz; seen text[]:='{}';
BEGIN
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 IF p_papers IS NULL OR jsonb_typeof(p_papers)<>'array'
   OR jsonb_array_length(p_papers)>50 OR octet_length(p_papers::text)>5000000 THEN
  RAISE EXCEPTION 'Invalid metadata batch' USING ERRCODE='22023';
 END IF;
 -- Serialize admission decisions, including concurrent calls from the same worker.
 PERFORM pg_catalog.pg_advisory_xact_lock(824730027);
 SELECT budget_bytes INTO STRICT budget FROM app_private.catalog_capacity WHERE singleton;
 FOR item IN SELECT value FROM jsonb_array_elements(p_papers) LOOP
  IF jsonb_typeof(item)<>'object' OR octet_length(item::text)>250000 OR
    (item-ARRAY['pmid','title','abstract','authors','journal','pub_date','mesh_terms','keywords','doi',
      'paper_type','pub_types','study_type','volume','issue','pages','publication_types',
      'integrity_status','related_notices','integrity_checked_at'])<>'{}'::jsonb OR
    NOT (item ?& ARRAY['pmid','title','pub_date']) THEN
   RAISE EXCEPTION 'Invalid metadata fields' USING ERRCODE='22023';
  END IF;
  -- Legacy cloud rows can contain null optional values. Treat them as absent,
  -- so mirroring older records cannot erase known metadata on a later upload.
  FOR field IN SELECT key FROM jsonb_each(item) WHERE value='null'::jsonb
    AND key NOT IN ('pmid','title','pub_date') LOOP
   item:=item-field;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['pmid','title','abstract','journal','pub_date','doi','paper_type',
     'study_type','volume','issue','pages','integrity_status','integrity_checked_at'] LOOP
   IF item ? field AND jsonb_typeof(item->field)<>'string' THEN
    RAISE EXCEPTION 'Invalid metadata string' USING ERRCODE='22023';
   END IF;
  END LOOP;
  IF (item->>'pmid') !~ '^[1-9][0-9]{0,11}$' OR length(trim(item->>'title')) NOT BETWEEN 1 AND 4000
    OR length(coalesce(item->>'abstract',''))>100000 OR length(coalesce(item->>'journal',''))>500
    OR length(coalesce(item->>'doi',''))>512 OR length(coalesce(item->>'paper_type',''))>80
    OR length(coalesce(item->>'study_type',''))>80 OR length(coalesce(item->>'volume',''))>100
    OR length(coalesce(item->>'issue',''))>100 OR length(coalesce(item->>'pages',''))>200
    OR (item->>'pub_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
   RAISE EXCEPTION 'Invalid metadata value' USING ERRCODE='22023';
  END IF;
  BEGIN publication_date:=(item->>'pub_date')::date;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
   RAISE EXCEPTION 'Invalid publication date' USING ERRCODE='22023';
  END;
  IF publication_date<DATE '2000-01-01' OR publication_date>=DATE '3001-01-01' THEN
   RAISE EXCEPTION 'Publication date outside collection scope' USING ERRCODE='22023';
  END IF;
  IF item->>'pmid'=ANY(seen) THEN
   RAISE EXCEPTION 'Duplicate PMID in metadata batch' USING ERRCODE='22023';
  END IF;
  seen:=array_append(seen,item->>'pmid');
  FOREACH field IN ARRAY ARRAY['authors','mesh_terms','keywords','pub_types','publication_types'] LOOP
   IF item ? field THEN
    IF jsonb_typeof(item->field)<>'array' OR jsonb_array_length(item->field)>2000 THEN
     RAISE EXCEPTION 'Invalid metadata array' USING ERRCODE='22023';
    END IF;
    FOR element IN SELECT value FROM jsonb_array_elements(item->field) LOOP
     IF jsonb_typeof(element)<>'string' OR length(element#>>'{}')>1000 THEN
      RAISE EXCEPTION 'Invalid metadata array item' USING ERRCODE='22023';
     END IF;
    END LOOP;
   END IF;
  END LOOP;
  IF item ? 'integrity_status' AND item->>'integrity_status' NOT IN ('current','corrected','retracted','concern') THEN
   RAISE EXCEPTION 'Invalid integrity status' USING ERRCODE='22023';
  END IF;
  IF item ? 'related_notices' THEN
   IF jsonb_typeof(item->'related_notices')<>'array' OR jsonb_array_length(item->'related_notices')>50 THEN
    RAISE EXCEPTION 'Invalid related notices' USING ERRCODE='22023';
   END IF;
   FOR element IN SELECT value FROM jsonb_array_elements(item->'related_notices') LOOP
    IF jsonb_typeof(element)<>'object' OR NOT (element ?& ARRAY['pmid','relation']) OR
      (element-ARRAY['pmid','relation'])<>'{}'::jsonb OR jsonb_typeof(element->'pmid')<>'string' OR
      jsonb_typeof(element->'relation')<>'string' OR (element->>'pmid') !~ '^[1-9][0-9]{0,11}$' OR
      (element->>'relation') NOT IN ('RetractionIn','RetractionOf','ErratumIn','ErratumFor',
        'ExpressionOfConcernIn','ExpressionOfConcernFor') THEN
     RAISE EXCEPTION 'Invalid related notice' USING ERRCODE='22023';
    END IF;
   END LOOP;
  END IF;
  stamp:=NULL;
  IF item ? 'integrity_checked_at' THEN
   BEGIN stamp:=(item->>'integrity_checked_at')::timestamptz;
   EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'Invalid integrity timestamp' USING ERRCODE='22023';
   END;
   IF NOT isfinite(stamp) OR stamp>now()+interval '5 minutes' OR stamp<DATE '2000-01-01' THEN
    RAISE EXCEPTION 'Invalid integrity timestamp' USING ERRCODE='22023';
   END IF;
  END IF;
  SELECT id INTO paper_key FROM public.papers WHERE pmid=item->>'pmid' FOR UPDATE;
  IF paper_key IS NULL THEN
   -- Once full, later new rows in this same batch cannot be admitted. Keep
   -- checking before each insert while below the guard; do not permit a batch
   -- to cross the existing admission boundary without another size check.
   IF NOT capacity_blocked THEN
    capacity_blocked:=pg_catalog.pg_database_size(pg_catalog.current_database())>=budget;
   END IF;
   IF capacity_blocked THEN CONTINUE; END IF;
  END IF;
  INSERT INTO public.papers AS p(pmid,title,abstract,authors,journal,pub_date,mesh_terms,keywords,doi,
    paper_type,pub_types,study_type,volume,issue,pages,publication_types,integrity_status,
    related_notices,integrity_checked_at)
   VALUES(item->>'pmid',item->>'title',coalesce(item->>'abstract',''),coalesce(item->'authors','[]'),
    coalesce(item->>'journal',''),publication_date,coalesce(item->'mesh_terms','[]'),coalesce(item->'keywords','[]'),
    coalesce(item->>'doi',''),coalesce(item->>'paper_type','article'),coalesce(item->'pub_types','[]'),
    coalesce(item->>'study_type','other'),coalesce(item->>'volume',''),coalesce(item->>'issue',''),
    coalesce(item->>'pages',''),coalesce(item->'publication_types','[]'),coalesce(item->>'integrity_status','current'),
    coalesce(item->'related_notices','[]'),stamp)
   ON CONFLICT(pmid) DO UPDATE SET title=excluded.title,pub_date=excluded.pub_date,fetched_at=now(),
    abstract=CASE WHEN item?'abstract' THEN excluded.abstract ELSE p.abstract END,
    authors=CASE WHEN item?'authors' THEN excluded.authors ELSE p.authors END,
    journal=CASE WHEN item?'journal' THEN excluded.journal ELSE p.journal END,
    mesh_terms=CASE WHEN item?'mesh_terms' THEN excluded.mesh_terms ELSE p.mesh_terms END,
    keywords=CASE WHEN item?'keywords' THEN excluded.keywords ELSE p.keywords END,
    doi=CASE WHEN item?'doi' THEN excluded.doi ELSE p.doi END,
    paper_type=CASE WHEN item?'paper_type' THEN excluded.paper_type ELSE p.paper_type END,
    pub_types=CASE WHEN item?'pub_types' THEN excluded.pub_types ELSE p.pub_types END,
    study_type=CASE WHEN item?'study_type' THEN excluded.study_type ELSE p.study_type END,
    volume=CASE WHEN item?'volume' THEN excluded.volume ELSE p.volume END,
    issue=CASE WHEN item?'issue' THEN excluded.issue ELSE p.issue END,
    pages=CASE WHEN item?'pages' THEN excluded.pages ELSE p.pages END,
    publication_types=CASE WHEN item?'publication_types' THEN excluded.publication_types ELSE p.publication_types END,
    integrity_status=CASE WHEN item?'integrity_status' THEN excluded.integrity_status ELSE p.integrity_status END,
    related_notices=CASE WHEN item?'related_notices' THEN excluded.related_notices ELSE p.related_notices END,
    integrity_checked_at=CASE WHEN item?'integrity_checked_at' THEN excluded.integrity_checked_at ELSE p.integrity_checked_at END
   RETURNING id INTO paper_key;
  accepted:=accepted||jsonb_build_array(jsonb_build_object('pmid',item->>'pmid','id',paper_key));
 END LOOP;
 RETURN jsonb_build_object('accepted',accepted,'capacity_blocked',capacity_blocked);
END;
$$;

-- Preserve the trusted vector for metadata-only updates. INSERT (including
-- ON CONFLICT's initial INSERT path) still derives the vector from source text.
CREATE OR REPLACE FUNCTION public.papers_search_update()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.title IS NOT DISTINCT FROM OLD.title
   AND NEW.abstract IS NOT DISTINCT FROM OLD.abstract THEN
  NEW.search_vector:=OLD.search_vector;
  RETURN NEW;
 END IF;
 NEW.search_vector:=
  setweight(to_tsvector('english',COALESCE(NEW.title,'')),'A')||
  setweight(to_tsvector('english',COALESCE(NEW.abstract,'')),'B');
 RETURN NEW;
END;
$$;
-- CREATE OR REPLACE keeps existing token-bound RPC execution grants. There is
-- no stored-data rewrite, quota change, role change or admission relaxation.
NOTIFY pgrst,'reload schema';
COMMIT;

