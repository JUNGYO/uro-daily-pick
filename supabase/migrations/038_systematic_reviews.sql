BEGIN;

-- Project-scoped research data. No credential or raw full-text column exists.
CREATE TABLE public.review_protocols (
 project_id bigint NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
 version integer NOT NULL CHECK(version>0), payload jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,version)
);
CREATE TABLE public.review_searches (
 id uuid PRIMARY KEY, project_id bigint NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
 source text NOT NULL, query text NOT NULL DEFAULT '', searched_at timestamptz NOT NULL,
 limits jsonb NOT NULL DEFAULT '{}', reported_hits integer CHECK(reported_hits>=0),
 status text NOT NULL CHECK(status IN ('partial','complete','failed')), file_hash text,
 revision integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id)
);
CREATE TABLE public.review_reports (
 id uuid PRIMARY KEY, project_id bigint NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
 paper_id bigint REFERENCES public.papers(id) ON DELETE SET NULL, bibliography jsonb NOT NULL,
 identity_key text NOT NULL, ta_decision text NOT NULL DEFAULT 'pending' CHECK(ta_decision IN ('pending','include','exclude','defer')),
 ft_decision text NOT NULL DEFAULT 'pending' CHECK(ft_decision IN ('pending','include','exclude','defer')),
 exclusion_reason text NOT NULL DEFAULT '', acquisition text NOT NULL DEFAULT 'unknown'
 CHECK(acquisition IN ('unknown','requested','acquired','unavailable')),
 duplicate_of uuid, source jsonb NOT NULL DEFAULT '{}', note text NOT NULL DEFAULT '',
 revision integer NOT NULL DEFAULT 1, updated_by uuid NOT NULL REFERENCES auth.users(id),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id), UNIQUE(project_id,identity_key),
 FOREIGN KEY(project_id,duplicate_of) REFERENCES public.review_reports(project_id,id), CHECK(duplicate_of IS DISTINCT FROM id)
);
CREATE TABLE public.review_records (
 id uuid PRIMARY KEY, project_id bigint NOT NULL, search_id uuid NOT NULL, report_id uuid NOT NULL,
 source_record_id text NOT NULL, bibliography jsonb NOT NULL, imported_by uuid NOT NULL REFERENCES auth.users(id),
 imported_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,search_id) REFERENCES public.review_searches(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,report_id) REFERENCES public.review_reports(project_id,id) ON DELETE CASCADE,
 UNIQUE(search_id,source_record_id)
);
CREATE TABLE public.review_studies (
 id uuid PRIMARY KEY, project_id bigint NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
 label text NOT NULL, design text NOT NULL, registry_id text NOT NULL DEFAULT '', overlap_group text NOT NULL DEFAULT '',
 population text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', revision integer NOT NULL DEFAULT 1,
 updated_by uuid NOT NULL REFERENCES auth.users(id), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id)
);
CREATE TABLE public.review_study_reports (
 project_id bigint NOT NULL, study_id uuid NOT NULL, report_id uuid NOT NULL, reason text NOT NULL,
 linked_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,study_id,report_id),
 FOREIGN KEY(project_id,study_id) REFERENCES public.review_studies(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,report_id) REFERENCES public.review_reports(project_id,id) ON DELETE CASCADE
);
CREATE TABLE public.review_observations (
 id uuid PRIMARY KEY, project_id bigint NOT NULL, study_id uuid NOT NULL, report_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('binary','continuous','effect','diagnostic','descriptive')),
 context jsonb NOT NULL, values jsonb NOT NULL, evidence jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('draft','confirmed','needs_revalidation','excluded')),
 reason text NOT NULL DEFAULT '', revision integer NOT NULL DEFAULT 1,
 confirmed_by uuid REFERENCES auth.users(id), confirmed_at timestamptz,
 updated_by uuid NOT NULL REFERENCES auth.users(id), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id),
 FOREIGN KEY(project_id,study_id,report_id) REFERENCES public.review_study_reports(project_id,study_id,report_id) ON DELETE CASCADE
);
CREATE TABLE public.review_assessments (
 id uuid PRIMARY KEY, project_id bigint NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
 study_id uuid, kind text NOT NULL CHECK(kind IN ('bias','certainty')), target text NOT NULL,
 tool text NOT NULL, tool_version text NOT NULL, domains jsonb NOT NULL, judgment text NOT NULL,
 reason text NOT NULL, evidence jsonb NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 1,
 updated_by uuid NOT NULL REFERENCES auth.users(id), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id),
 FOREIGN KEY(project_id,study_id) REFERENCES public.review_studies(project_id,id) ON DELETE CASCADE
);
CREATE TABLE public.review_analysis_runs (
 id uuid PRIMARY KEY, project_id bigint NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
 requested_by uuid NOT NULL REFERENCES auth.users(id), protocol_version integer NOT NULL,
 input_manifest jsonb NOT NULL, input_hash text NOT NULL, config jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','needs_review','failed','cancelled')),
 result jsonb, error_code text, worker_id uuid REFERENCES app_private.institution_workers(id),
 lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(project_id,id), FOREIGN KEY(project_id,protocol_version) REFERENCES public.review_protocols(project_id,version)
);
CREATE TABLE public.review_audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, project_id bigint NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
 actor_id uuid REFERENCES auth.users(id), kind text NOT NULL, target_id text NOT NULL,
 before_value jsonb, after_value jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_reports_page ON public.review_reports(project_id,updated_at DESC,id);
CREATE INDEX review_records_search ON public.review_records(project_id,search_id,report_id);
CREATE INDEX review_studies_page ON public.review_studies(project_id,label,id);
CREATE INDEX review_observations_page ON public.review_observations(project_id,study_id,id);
CREATE INDEX review_assessments_page ON public.review_assessments(project_id,kind,id);
CREATE INDEX review_runs_queue ON public.review_analysis_runs(status,created_at) WHERE status IN ('queued','running');
CREATE INDEX review_runs_project ON public.review_analysis_runs(project_id,created_at DESC);
CREATE INDEX review_audit_project ON public.review_audit_events(project_id,id DESC);

DO $$DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['review_protocols','review_searches','review_reports','review_records','review_studies','review_study_reports','review_observations','review_assessments','review_analysis_runs','review_audit_events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
  EXECUTE format('CREATE POLICY project_read ON public.%I FOR SELECT TO authenticated USING (public.collection_access(project_id))',t);
 END LOOP;
END $$;

CREATE FUNCTION app_private.review_object(p jsonb,keys text[],maximum integer DEFAULT 16000) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(jsonb_typeof(p)='object' AND octet_length(p::text)<=maximum AND p-keys='{}',false)
$$;
CREATE FUNCTION app_private.review_number(p jsonb,k text,minimum numeric DEFAULT NULL,maximum numeric DEFAULT NULL,whole boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v numeric;
BEGIN
 IF jsonb_typeof(p->k) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
 v=(p->>k)::numeric;
 RETURN (minimum IS NULL OR v>=minimum) AND (maximum IS NULL OR v<=maximum) AND (NOT whole OR trunc(v)=v);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION app_private.review_values_valid(k text,v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE f text;
BEGIN
 IF k='binary' THEN
  RETURN app_private.review_object(v,ARRAY['events_t','n_t','events_c','n_c'])
   AND app_private.review_number(v,'n_t',1,100000000,true) AND app_private.review_number(v,'n_c',1,100000000,true)
   AND app_private.review_number(v,'events_t',0,(v->>'n_t')::numeric,true) AND app_private.review_number(v,'events_c',0,(v->>'n_c')::numeric,true);
 ELSIF k='continuous' THEN
  RETURN app_private.review_object(v,ARRAY['n_t','mean_t','sd_t','n_c','mean_c','sd_c'])
   AND app_private.review_number(v,'n_t',2,100000000,true) AND app_private.review_number(v,'n_c',2,100000000,true)
   AND app_private.review_number(v,'mean_t') AND app_private.review_number(v,'mean_c')
   AND app_private.review_number(v,'sd_t',0) AND app_private.review_number(v,'sd_c',0);
 ELSIF k='effect' THEN
  RETURN app_private.review_object(v,ARRAY['measure','estimate','se','scale'])
   AND v->>'measure' IN ('RR','OR','HR','MD','SMD') AND v->>'scale' IN ('log','identity')
   AND (v->>'measure' NOT IN ('RR','OR','HR') OR v->>'scale'='log')
   AND (v->>'measure' NOT IN ('MD','SMD') OR v->>'scale'='identity')
   AND app_private.review_number(v,'estimate') AND app_private.review_number(v,'se',0.000000000001);
 ELSIF k='diagnostic' THEN
  IF NOT app_private.review_object(v,ARRAY['tp','fp','fn','tn']) THEN RETURN false; END IF;
  FOREACH f IN ARRAY ARRAY['tp','fp','fn','tn'] LOOP IF NOT app_private.review_number(v,f,0,100000000,true) THEN RETURN false; END IF; END LOOP;
  RETURN (v->>'tp')::numeric+(v->>'fn')::numeric>0 AND (v->>'tn')::numeric+(v->>'fp')::numeric>0;
 ELSIF k='descriptive' THEN RETURN app_private.review_object(v,ARRAY['text']) AND length(v->>'text') BETWEEN 1 AND 2000;
 END IF;
 RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION app_private.review_draft_values_valid(k text,v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE fields text[]; f text; missing jsonb; n numeric;
BEGIN
 IF app_private.review_values_valid(k,v) IS TRUE THEN RETURN true; END IF;
 fields=CASE k WHEN 'binary' THEN ARRAY['events_t','n_t','events_c','n_c']
  WHEN 'continuous' THEN ARRAY['n_t','mean_t','sd_t','n_c','mean_c','sd_c']
  WHEN 'effect' THEN ARRAY['estimate','se'] WHEN 'diagnostic' THEN ARRAY['tp','fp','fn','tn'] END;
 IF fields IS NULL OR NOT app_private.review_object(v,fields||CASE WHEN k='effect' THEN ARRAY['missing','measure','scale'] ELSE ARRAY['missing'] END) THEN RETURN false; END IF;
 missing=v->'missing';
 IF NOT app_private.review_object(missing,fields,3000) OR missing='{}' THEN RETURN false; END IF;
 FOREACH f IN ARRAY fields LOOP
  IF v->f IS NULL OR v->f='null' THEN
   IF jsonb_typeof(missing->f) IS DISTINCT FROM 'string' OR coalesce(length(btrim(missing->>f)),0) NOT BETWEEN 1 AND 300 THEN RETURN false; END IF;
  ELSE
   IF missing ? f OR NOT app_private.review_number(v,f) THEN RETURN false; END IF;
   n=(v->>f)::numeric;
   IF f IN ('n_t','n_c','events_t','events_c','tp','fp','fn','tn') AND (n<0 OR n>100000000 OR trunc(n)<>n) THEN RETURN false; END IF;
   IF f IN ('n_t','n_c') AND n<(CASE WHEN k='continuous' THEN 2 ELSE 1 END) THEN RETURN false; END IF;
   IF f IN ('sd_t','sd_c') AND n<0 OR f='se' AND n<0.000000000001 THEN RETURN false; END IF;
  END IF;
 END LOOP;
 IF k='binary' AND ((v->>'events_t')::numeric>(v->>'n_t')::numeric OR (v->>'events_c')::numeric>(v->>'n_c')::numeric) THEN RETURN false; END IF;
 IF k='effect' AND (coalesce(v->>'measure','') NOT IN ('RR','OR','HR','MD','SMD') OR v->>'scale' IS DISTINCT FROM (CASE WHEN v->>'measure' IN ('RR','OR','HR') THEN 'log' ELSE 'identity' END)) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION app_private.review_audit(p_project bigint,p_kind text,p_id text,p_before jsonb,p_after jsonb) RETURNS void
LANGUAGE sql SET search_path='' AS $$
 INSERT INTO public.review_audit_events(project_id,actor_id,kind,target_id,before_value,after_value)
 VALUES(p_project,auth.uid(),p_kind,p_id,p_before,p_after)
$$;

CREATE FUNCTION public.review_save_protocol(p_project bigint,p_expected_version integer,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE current_version integer; result jsonb;
BEGIN
 IF NOT public.collection_access(p_project,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF NOT app_private.review_object(p_payload,ARRAY['question','type','population','intervention','comparator','outcomes','timepoints','eligibility','search_plan','analysis_plan','registration','amendment_reason','status'])
  OR coalesce(length(btrim(p_payload->>'question')),0) NOT BETWEEN 1 AND 4000 OR coalesce(p_payload->>'type','') NOT IN ('intervention','diagnostic')
  OR coalesce(p_payload->>'status','') NOT IN ('draft','locked') THEN RAISE EXCEPTION 'Invalid protocol' USING ERRCODE='22023'; END IF;
 IF p_payload->>'status'='locked' AND (coalesce(length(btrim(p_payload->>'eligibility')),0)=0 OR coalesce(length(btrim(p_payload->>'outcomes')),0)=0
  OR coalesce(length(btrim(p_payload->>'analysis_plan')),0)=0 OR coalesce(length(btrim(p_payload->>'search_plan')),0)=0)
 THEN RAISE EXCEPTION 'Eligibility, outcomes, search and analysis plans are required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('review:'||p_project::text,0));
 SELECT coalesce(max(version),0) INTO current_version FROM public.review_protocols WHERE project_id=p_project;
 IF p_expected_version IS DISTINCT FROM current_version THEN RAISE EXCEPTION 'Protocol changed' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.review_protocols WHERE project_id=p_project AND payload->>'status'='locked')
  AND coalesce(length(btrim(p_payload->>'amendment_reason')),0)=0 THEN RAISE EXCEPTION 'Amendment reason required' USING ERRCODE='22023'; END IF;
 INSERT INTO public.review_protocols(project_id,version,payload,created_by) VALUES(p_project,current_version+1,p_payload,auth.uid()) RETURNING to_jsonb(review_protocols.*) INTO result;
 PERFORM app_private.review_audit(p_project,'protocol',(current_version+1)::text,NULL,result);
 RETURN result;
END $$;

CREATE FUNCTION public.review_save_search(p_project bigint,p_id uuid,p_expected_revision integer,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE old public.review_searches; result jsonb;
BEGIN
 IF NOT public.collection_access(p_project,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL OR NOT app_private.review_object(p_payload,ARRAY['source','query','searched_at','limits','reported_hits','status','file_hash'])
  OR coalesce(length(btrim(p_payload->>'source')),0) NOT BETWEEN 1 AND 200 OR length(coalesce(p_payload->>'query',''))>6000
  OR coalesce(p_payload->>'status','') NOT IN ('partial','complete','failed')
  OR NOT app_private.review_object(coalesce(p_payload->'limits','{}'),ARRAY['import_format','journal','from','to','topic','kind','keywords','page','language','date_field','coverage_note'])
  OR (p_payload->>'file_hash' IS NOT NULL AND p_payload->>'file_hash' !~ '^[a-f0-9]{64}$')
  OR (p_payload->>'reported_hits' IS NOT NULL AND NOT app_private.review_number(p_payload,'reported_hits',0,100000000,true))
  OR p_payload->>'searched_at' IS NULL THEN RAISE EXCEPTION 'Invalid search record' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('review:'||p_project::text,0));
 SELECT * INTO old FROM public.review_searches WHERE id=p_id AND project_id=p_project FOR UPDATE;
 IF coalesce(old.revision,0) IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Search changed' USING ERRCODE='40001'; END IF;
 IF old.id IS NULL THEN
  INSERT INTO public.review_searches(id,project_id,source,query,searched_at,limits,reported_hits,status,file_hash,created_by)
   VALUES(p_id,p_project,p_payload->>'source',coalesce(p_payload->>'query',''),(p_payload->>'searched_at')::timestamptz,coalesce(p_payload->'limits','{}'),
    (p_payload->>'reported_hits')::integer,p_payload->>'status',p_payload->>'file_hash',auth.uid()) RETURNING to_jsonb(review_searches.*) INTO result;
 ELSE
  UPDATE public.review_searches SET status=p_payload->>'status',revision=revision+1 WHERE id=p_id RETURNING to_jsonb(review_searches.*) INTO result;
 END IF;
 PERFORM app_private.review_audit(p_project,'search',p_id::text,to_jsonb(old),result); RETURN result;
END $$;

CREATE FUNCTION public.review_import_records(p_project bigint,p_search uuid,p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE item jsonb; bib jsonb; report_bib jsonb; catalog public.papers; identity text; rid uuid; existing uuid; pid bigint; n integer=0; matches integer=0; v_doi text; v_pmid text; seen public.review_reports;
BEGIN
 IF NOT public.collection_access(p_project,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Import batches contain 1 to 100 records' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('review:'||p_project::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.review_searches WHERE project_id=p_project AND id=p_search) THEN RAISE EXCEPTION 'Search not found' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  IF NOT app_private.review_object(item,ARRAY['source_record_id','bibliography','paper_id']) OR coalesce(length(item->>'source_record_id'),0) NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid source record' USING ERRCODE='22023'; END IF;
  bib=item->'bibliography'; pid=(item->>'paper_id')::bigint;
  IF NOT app_private.review_object(bib,ARRAY['title','authors','journal','year','date','doi','pmid','volume','issue','pages','abstract','url','zotero_key','report_type'],24000)
   OR coalesce(length(btrim(bib->>'title')),0) NOT BETWEEN 1 AND 2000 OR jsonb_typeof(coalesce(bib->'authors','[]'))<>'array'
   OR jsonb_array_length(coalesce(bib->'authors','[]'))>300 THEN RAISE EXCEPTION 'Invalid bibliography' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(bib->'authors','[]')) a WHERE jsonb_typeof(a)<>'string' OR length(a#>>'{}')>400) THEN RAISE EXCEPTION 'Invalid authors' USING ERRCODE='22023'; END IF;
  v_doi=lower(btrim(coalesce(bib->>'doi',''))); v_pmid=btrim(coalesce(bib->>'pmid',''));
  IF v_doi<>'' AND v_doi !~ '^10\.[0-9]{4,9}/[^[:space:]]+$' OR v_pmid<>'' AND v_pmid !~ '^[0-9]{1,10}$' THEN RAISE EXCEPTION 'Invalid identifier' USING ERRCODE='22023'; END IF;
  IF pid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.papers paper WHERE paper.id=pid AND paper.pmid=v_pmid AND paper.title=bib->>'title') THEN RAISE EXCEPTION 'Catalog identity changed' USING ERRCODE='22023'; END IF;
  report_bib=bib;
  IF pid IS NOT NULL THEN
   SELECT * INTO catalog FROM public.papers WHERE id=pid;
   report_bib=bib||jsonb_build_object('title',catalog.title,'authors',coalesce(catalog.authors,'[]'),'journal',catalog.journal,
    'date',catalog.pub_date,'year',extract(year FROM catalog.pub_date)::text,'abstract',catalog.abstract,'doi',catalog.doi,'pmid',catalog.pmid);
   v_doi=lower(btrim(coalesce(catalog.doi,'')));
  END IF;
  SELECT report_id INTO existing FROM public.review_records WHERE search_id=p_search AND source_record_id=item->>'source_record_id';
  IF existing IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.review_records WHERE search_id=p_search AND source_record_id=item->>'source_record_id' AND bibliography=bib) THEN RAISE EXCEPTION 'Source record was already imported with different content' USING ERRCODE='40001'; END IF;
   CONTINUE;
  END IF;
  identity=CASE WHEN v_doi<>'' THEN 'doi:'||v_doi WHEN v_pmid<>'' THEN 'pmid:'||v_pmid ELSE 'source:'||p_search||':'||(item->>'source_record_id') END;
  SELECT * INTO seen FROM public.review_reports WHERE project_id=p_project AND identity_key=identity;
  IF seen.id IS NOT NULL AND v_pmid<>'' AND coalesce(seen.bibliography->>'pmid','')<>'' AND seen.bibliography->>'pmid'<>v_pmid THEN
   identity=identity||':conflict:'||v_pmid; seen=NULL;
   SELECT * INTO seen FROM public.review_reports WHERE project_id=p_project AND identity_key=identity;
  END IF;
  IF seen.id IS NULL THEN
   rid=gen_random_uuid();
   INSERT INTO public.review_reports(id,project_id,paper_id,bibliography,identity_key,updated_by) VALUES(rid,p_project,pid,report_bib,identity,auth.uid());
  ELSE rid=seen.id; matches=matches+1; END IF;
  INSERT INTO public.review_records(id,project_id,search_id,report_id,source_record_id,bibliography,imported_by)
   VALUES(gen_random_uuid(),p_project,p_search,rid,item->>'source_record_id',bib,auth.uid()); n=n+1;
 END LOOP;
 PERFORM app_private.review_audit(p_project,'import',p_search::text,NULL,jsonb_build_object('records',n,'existing_reports',matches));
 RETURN jsonb_build_object('imported',n,'existing_reports',matches);
END $$;

CREATE FUNCTION public.review_save_report(p_project bigint,p_id uuid,p_expected_revision integer,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE old public.review_reports; result jsonb; dup uuid;
BEGIN
 IF NOT public.collection_access(p_project,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF NOT app_private.review_object(p_payload,ARRAY['ta_decision','ft_decision','exclusion_reason','acquisition','duplicate_of','source','note'])
  OR coalesce(p_payload->>'ta_decision','') NOT IN ('pending','include','exclude','defer')
  OR coalesce(p_payload->>'ft_decision','') NOT IN ('pending','include','exclude','defer')
  OR coalesce(p_payload->>'acquisition','') NOT IN ('unknown','requested','acquired','unavailable')
  OR length(coalesce(p_payload->>'note',''))>4000 OR length(coalesce(p_payload->>'exclusion_reason',''))>1000
  OR NOT app_private.review_object(coalesce(p_payload->'source','{}'),ARRAY['hash','locator','url','type','version','note'],4000)
 THEN RAISE EXCEPTION 'Invalid screening decision' USING ERRCODE='22023'; END IF;
 IF (p_payload->>'ta_decision'='exclude' OR p_payload->>'ft_decision'='exclude') AND coalesce(length(btrim(p_payload->>'exclusion_reason')),0)=0
 THEN RAISE EXCEPTION 'Exclusion reason required' USING ERRCODE='22023'; END IF;
 IF p_payload->>'ft_decision' IN ('include','exclude') AND (p_payload->>'ta_decision'<>'include' OR p_payload->>'acquisition'<>'acquired')
 THEN RAISE EXCEPTION 'Full text assessment requires an acquired report and title screening inclusion' USING ERRCODE='22023'; END IF;
 IF p_payload->'source'->>'hash' IS NOT NULL AND p_payload->'source'->>'hash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid source hash' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('review:'||p_project::text,0));
 SELECT * INTO old FROM public.review_reports WHERE id=p_id AND project_id=p_project FOR UPDATE;
 IF old.id IS NULL THEN RAISE EXCEPTION 'Report not found' USING ERRCODE='22023'; END IF;
 IF old.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Report changed' USING ERRCODE='40001'; END IF;
 dup=(p_payload->>'duplicate_of')::uuid;
 IF dup IS NOT NULL THEN
  IF dup=p_id OR NOT EXISTS(SELECT 1 FROM public.review_reports WHERE id=dup AND project_id=p_project AND duplicate_of IS NULL)
   OR EXISTS(SELECT 1 FROM public.review_reports WHERE duplicate_of=p_id AND project_id=p_project)
  THEN RAISE EXCEPTION 'Choose a canonical report; duplicate chains are not allowed' USING ERRCODE='22023'; END IF;
 END IF;
 UPDATE public.review_reports SET ta_decision=p_payload->>'ta_decision',ft_decision=p_payload->>'ft_decision',
  exclusion_reason=coalesce(p_payload->>'exclusion_reason',''),acquisition=p_payload->>'acquisition',duplicate_of=dup,
  source=coalesce(p_payload->'source','{}'),note=coalesce(p_payload->>'note',''),revision=revision+1,updated_by=auth.uid(),updated_at=now()
 WHERE id=p_id RETURNING to_jsonb(review_reports.*) INTO result;
 UPDATE public.review_observations SET status='needs_revalidation',revision=revision+1,confirmed_by=NULL,confirmed_at=NULL,updated_at=now()
 WHERE project_id=p_project AND report_id=p_id AND status='confirmed';
 PERFORM app_private.review_audit(p_project,'report',p_id::text,to_jsonb(old),result); RETURN result;
END $$;

CREATE FUNCTION public.review_save_study(p_project bigint,p_id uuid,p_expected_revision integer,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE old public.review_studies; result jsonb; rid uuid; ids uuid[];
BEGIN
 IF NOT public.collection_access(p_project,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL OR NOT app_private.review_object(p_payload,ARRAY['label','design','registry_id','overlap_group','population','notes','report_ids','link_reason'])
  OR coalesce(length(btrim(p_payload->>'label')),0) NOT BETWEEN 1 AND 300 OR coalesce(length(btrim(p_payload->>'design')),0) NOT BETWEEN 1 AND 100
  OR jsonb_typeof(p_payload->'report_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'report_ids') NOT BETWEEN 1 AND 100
  OR coalesce(length(btrim(p_payload->>'link_reason')),0) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid study or report links' USING ERRCODE='22023'; END IF;
 SELECT array_agg(value::uuid) INTO ids FROM jsonb_array_elements_text(p_payload->'report_ids');
 IF (SELECT count(*) FROM public.review_reports WHERE project_id=p_project AND id=ANY(ids))<>cardinality(ids) THEN RAISE EXCEPTION 'Reports must belong to this project and be distinct' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('review:'||p_project::text,0));
 SELECT * INTO old FROM public.review_studies WHERE id=p_id AND project_id=p_project FOR UPDATE;
 IF coalesce(old.revision,0) IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Study changed' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.review_observations WHERE project_id=p_project AND study_id=p_id AND NOT report_id=ANY(ids))
 THEN RAISE EXCEPTION 'A report used by observations cannot be unlinked' USING ERRCODE='22023'; END IF;
 INSERT INTO public.review_studies(id,project_id,label,design,registry_id,overlap_group,population,notes,updated_by)
 VALUES(p_id,p_project,p_payload->>'label',p_payload->>'design',coalesce(p_payload->>'registry_id',''),coalesce(p_payload->>'overlap_group',''),coalesce(p_payload->>'population',''),coalesce(p_payload->>'notes',''),auth.uid())
 ON CONFLICT(id) DO UPDATE SET label=excluded.label,design=excluded.design,registry_id=excluded.registry_id,overlap_group=excluded.overlap_group,
  population=excluded.population,notes=excluded.notes,revision=review_studies.revision+1,updated_by=auth.uid(),updated_at=now()
 WHERE review_studies.project_id=p_project RETURNING to_jsonb(review_studies.*) INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Study identity conflict' USING ERRCODE='42501'; END IF;
 DELETE FROM public.review_study_reports WHERE project_id=p_project AND study_id=p_id AND NOT report_id=ANY(ids);
 FOREACH rid IN ARRAY ids LOOP
  INSERT INTO public.review_study_reports(project_id,study_id,report_id,reason,linked_by) VALUES(p_project,p_id,rid,p_payload->>'link_reason',auth.uid())
  ON CONFLICT(project_id,study_id,report_id) DO UPDATE SET reason=excluded.reason,linked_by=auth.uid();
 END LOOP;
 UPDATE public.review_observations SET status='needs_revalidation',revision=revision+1,confirmed_by=NULL,confirmed_at=NULL,updated_at=now()
 WHERE project_id=p_project AND study_id=p_id AND status='confirmed';
 PERFORM app_private.review_audit(p_project,'study',p_id::text,to_jsonb(old),result);
 RETURN result||jsonb_build_object('report_ids',to_jsonb(ids));
END $$;

CREATE FUNCTION public.review_save_observation(p_project bigint,p_id uuid,p_expected_revision integer,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE old public.review_observations; result jsonb; report public.review_reports; ctx jsonb; evidence jsonb; field text; sid uuid; rid uuid;
BEGIN
 IF NOT public.collection_access(p_project,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL OR NOT app_private.review_object(p_payload,ARRAY['study_id','report_id','kind','context','values','evidence','status','reason'],24000)
  OR coalesce(p_payload->>'kind','') NOT IN ('binary','continuous','effect','diagnostic','descriptive')
  OR coalesce(p_payload->>'status','') NOT IN ('draft','confirmed','excluded') THEN RAISE EXCEPTION 'Invalid observation' USING ERRCODE='22023'; END IF;
 ctx=p_payload->'context'; evidence=p_payload->'evidence';
 IF NOT app_private.review_object(ctx,ARRAY['cohort','independence_group','outcome','timepoint','comparison','unit','direction','population','analysis_population','adjustment','covariates','index_test','threshold','reference_standard','value_origin','value_type','transformation','subgroup'])
  OR NOT app_private.review_object(evidence,ARRAY['source_hash','source_version','source_type','locator','page','table','row','column','footnote','quote','note','source_checked','report_revision'],8000)
  OR jsonb_typeof(p_payload->'values') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid observation context or source' USING ERRCODE='22023'; END IF;
 sid=(p_payload->>'study_id')::uuid; rid=(p_payload->>'report_id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.review_study_reports WHERE project_id=p_project AND study_id=sid AND report_id=rid) THEN RAISE EXCEPTION 'Link this report to the study first' USING ERRCODE='22023'; END IF;
 IF (CASE WHEN p_payload->>'status'='confirmed' THEN app_private.review_values_valid(p_payload->>'kind',p_payload->'values')
  ELSE app_private.review_draft_values_valid(p_payload->>'kind',p_payload->'values') END) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid numeric values; missing values are not zero' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('review:'||p_project::text,0));
 SELECT * INTO report FROM public.review_reports WHERE project_id=p_project AND id=rid;
 IF p_payload->>'status'='confirmed' THEN
  FOREACH field IN ARRAY ARRAY['cohort','independence_group','outcome','timepoint','comparison','unit','direction','analysis_population','adjustment','value_origin'] LOOP
   IF coalesce(length(btrim(ctx->>field)),0)=0 THEN RAISE EXCEPTION 'Observation context required: %',field USING ERRCODE='22023'; END IF;
  END LOOP;
  IF ctx->>'value_origin' NOT IN ('reported','transformed') OR ctx->>'direction' NOT IN ('higher_better','lower_better','not_applicable') THEN RAISE EXCEPTION 'Invalid direction or origin' USING ERRCODE='22023'; END IF;
  IF ctx->>'value_origin'='transformed' AND coalesce(length(btrim(ctx->>'transformation')),0)=0 THEN RAISE EXCEPTION 'Transformation provenance required' USING ERRCODE='22023'; END IF;
  IF p_payload->>'kind'='diagnostic' AND (coalesce(ctx->>'index_test','')='' OR coalesce(ctx->>'threshold','')='' OR coalesce(ctx->>'reference_standard','')='') THEN RAISE EXCEPTION 'Diagnostic test, threshold and reference required' USING ERRCODE='22023'; END IF;
  IF report.duplicate_of IS NOT NULL OR report.ft_decision<>'include' OR report.acquisition<>'acquired'
   OR evidence->'source_checked' IS DISTINCT FROM 'true'::jsonb OR (evidence->>'report_revision')::integer IS DISTINCT FROM report.revision
   OR coalesce(evidence->>'source_type','') NOT IN ('fulltext','supplement','registry','author_data')
   OR coalesce(evidence->>'source_hash','') !~ '^[a-f0-9]{64}$' OR coalesce(length(btrim(evidence->>'locator')),0)=0
  THEN RAISE EXCEPTION 'Verify the current included source before confirming' USING ERRCODE='22023'; END IF;
  IF evidence->>'source_type'='fulltext' AND report.source->>'hash' IS NOT NULL AND report.source->>'hash'<>evidence->>'source_hash' THEN RAISE EXCEPTION 'Source changed' USING ERRCODE='40001'; END IF;
  IF report.paper_id IS NOT NULL AND evidence->>'source_type'='fulltext' AND EXISTS(SELECT 1 FROM app_private.local_fulltext_sources WHERE paper_id=report.paper_id)
   AND NOT EXISTS(SELECT 1 FROM app_private.local_fulltext_sources WHERE paper_id=report.paper_id AND content_hash=evidence->>'source_hash')
  THEN RAISE EXCEPTION 'Original source version changed' USING ERRCODE='40001'; END IF;
 END IF;
 IF p_payload->>'status'='excluded' AND coalesce(length(btrim(p_payload->>'reason')),0)=0 THEN RAISE EXCEPTION 'Exclusion reason required' USING ERRCODE='22023'; END IF;
 SELECT * INTO old FROM public.review_observations WHERE id=p_id AND project_id=p_project FOR UPDATE;
 IF coalesce(old.revision,0) IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Observation changed' USING ERRCODE='40001'; END IF;
 INSERT INTO public.review_observations(id,project_id,study_id,report_id,kind,context,values,evidence,status,reason,confirmed_by,confirmed_at,updated_by)
 VALUES(p_id,p_project,sid,rid,p_payload->>'kind',ctx,p_payload->'values',evidence,p_payload->>'status',coalesce(p_payload->>'reason',''),
  CASE WHEN p_payload->>'status'='confirmed' THEN auth.uid() END,CASE WHEN p_payload->>'status'='confirmed' THEN now() END,auth.uid())
 ON CONFLICT(id) DO UPDATE SET study_id=excluded.study_id,report_id=excluded.report_id,kind=excluded.kind,context=excluded.context,values=excluded.values,evidence=excluded.evidence,
  status=excluded.status,reason=excluded.reason,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at,
  revision=review_observations.revision+1,updated_by=auth.uid(),updated_at=now()
 WHERE review_observations.project_id=p_project RETURNING to_jsonb(review_observations.*) INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Observation identity conflict' USING ERRCODE='42501'; END IF;
 PERFORM app_private.review_audit(p_project,'observation',p_id::text,to_jsonb(old),result); RETURN result;
END $$;

CREATE FUNCTION public.review_save_assessment(p_project bigint,p_id uuid,p_expected_revision integer,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE old public.review_assessments; result jsonb; domain jsonb;
BEGIN
 IF NOT public.collection_access(p_project,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL OR NOT app_private.review_object(p_payload,ARRAY['study_id','kind','target','tool','tool_version','domains','judgment','reason','evidence'])
  OR coalesce(p_payload->>'kind','') NOT IN ('bias','certainty') OR coalesce(length(btrim(p_payload->>'target')),0)=0
  OR coalesce(length(btrim(p_payload->>'tool')),0)=0 OR coalesce(length(btrim(p_payload->>'tool_version')),0)=0
  OR coalesce(length(btrim(p_payload->>'judgment')),0)=0 OR coalesce(length(btrim(p_payload->>'reason')),0)=0
  OR jsonb_typeof(p_payload->'domains') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'domains') NOT BETWEEN 1 AND 20
  OR NOT app_private.review_object(coalesce(p_payload->'evidence','{}'),ARRAY['source_hash','locator','note']) THEN RAISE EXCEPTION 'Invalid assessment' USING ERRCODE='22023'; END IF;
 FOR domain IN SELECT value FROM jsonb_array_elements(p_payload->'domains') LOOP
  IF NOT app_private.review_object(domain,ARRAY['id','judgment','reason']) OR coalesce(length(domain->>'id'),0)=0 OR coalesce(length(domain->>'judgment'),0)=0 OR coalesce(length(domain->>'reason'),0)=0
  THEN RAISE EXCEPTION 'Every domain needs a judgment and reason' USING ERRCODE='22023'; END IF;
 END LOOP;
 PERFORM pg_advisory_xact_lock(hashtextextended('review:'||p_project::text,0));
 SELECT * INTO old FROM public.review_assessments WHERE project_id=p_project AND id=p_id FOR UPDATE;
 IF coalesce(old.revision,0) IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Assessment changed' USING ERRCODE='40001'; END IF;
 INSERT INTO public.review_assessments(id,project_id,study_id,kind,target,tool,tool_version,domains,judgment,reason,evidence,updated_by)
 VALUES(p_id,p_project,(p_payload->>'study_id')::uuid,p_payload->>'kind',p_payload->>'target',p_payload->>'tool',p_payload->>'tool_version',p_payload->'domains',p_payload->>'judgment',p_payload->>'reason',coalesce(p_payload->'evidence','{}'),auth.uid())
 ON CONFLICT(id) DO UPDATE SET study_id=excluded.study_id,kind=excluded.kind,target=excluded.target,tool=excluded.tool,tool_version=excluded.tool_version,domains=excluded.domains,
  judgment=excluded.judgment,reason=excluded.reason,evidence=excluded.evidence,revision=review_assessments.revision+1,updated_by=auth.uid(),updated_at=now()
 WHERE review_assessments.project_id=p_project RETURNING to_jsonb(review_assessments.*) INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Assessment identity conflict' USING ERRCODE='42501'; END IF;
 PERFORM app_private.review_audit(p_project,'assessment',p_id::text,to_jsonb(old),result); RETURN result;
END $$;

CREATE FUNCTION public.review_workspace(p_project bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE counts jsonb; result jsonb;
BEGIN
 IF NOT public.collection_access(p_project) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('reports',count(*) FILTER(WHERE duplicate_of IS NULL),'all_reports',count(*),'duplicates',count(*) FILTER(WHERE duplicate_of IS NOT NULL),
  'ta_pending',count(*) FILTER(WHERE duplicate_of IS NULL AND ta_decision IN ('pending','defer')),
  'ta_excluded',count(*) FILTER(WHERE duplicate_of IS NULL AND ta_decision='exclude'),
  'sought',count(*) FILTER(WHERE duplicate_of IS NULL AND ta_decision='include'),
  'unavailable',count(*) FILTER(WHERE duplicate_of IS NULL AND ta_decision='include' AND acquisition='unavailable'),
  'ft_pending',count(*) FILTER(WHERE duplicate_of IS NULL AND ta_decision='include' AND acquisition<>'unavailable' AND ft_decision IN ('pending','defer')),
  'ft_excluded',count(*) FILTER(WHERE duplicate_of IS NULL AND ta_decision='include' AND ft_decision='exclude'),
  'included',count(*) FILTER(WHERE duplicate_of IS NULL AND ta_decision='include' AND ft_decision='include')) INTO counts
 FROM public.review_reports WHERE project_id=p_project;
 SELECT jsonb_build_object('project_id',p_project,'can_edit',public.collection_access(p_project,true),
  'protocol',(SELECT to_jsonb(p) FROM public.review_protocols p WHERE project_id=p_project ORDER BY version DESC LIMIT 1),
  'counts',counts||jsonb_build_object('records',(SELECT count(*) FROM public.review_records WHERE project_id=p_project),
   'studies',(SELECT count(DISTINCT l.study_id) FROM public.review_study_reports l JOIN public.review_reports r ON r.id=l.report_id WHERE l.project_id=p_project AND r.ft_decision='include' AND r.duplicate_of IS NULL),
   'observations',(SELECT count(*) FROM public.review_observations WHERE project_id=p_project),
   'confirmed',(SELECT count(*) FROM public.review_observations WHERE project_id=p_project AND status='confirmed')),
  'exclusion_reasons',coalesce((SELECT jsonb_agg(x) FROM (SELECT exclusion_reason reason,count(*) total FROM public.review_reports WHERE project_id=p_project AND duplicate_of IS NULL AND ft_decision='exclude' GROUP BY exclusion_reason) x),'[]'),
  'review_features',jsonb_build_object('human_peer_review','placeholder','ai_peer_review','placeholder','key_storage',false)) INTO result;
 RETURN result;
END $$;

CREATE FUNCTION public.review_list(p_project bigint,p_section text,p_query text DEFAULT '',p_filter text DEFAULT '',p_page integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE tab text; filter_sql text=''; items jsonb; total bigint; q text=lower(btrim(coalesce(p_query,'')));
BEGIN
 IF NOT public.collection_access(p_project) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 IF p_page IS NULL OR p_page NOT BETWEEN 0 AND 100000 OR length(q)>200 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 tab=CASE p_section WHEN 'searches' THEN 'review_searches' WHEN 'reports' THEN 'review_reports' WHEN 'records' THEN 'review_records'
  WHEN 'studies' THEN 'review_studies' WHEN 'observations' THEN 'review_observations' WHEN 'assessments' THEN 'review_assessments'
  WHEN 'runs' THEN 'review_analysis_runs' WHEN 'history' THEN 'review_audit_events' WHEN 'protocols' THEN 'review_protocols' END;
 IF tab IS NULL THEN RAISE EXCEPTION 'Invalid section' USING ERRCODE='22023'; END IF;
 IF p_section='reports' THEN
  IF p_filter NOT IN ('','ta_pending','ft_pending','included','excluded','duplicates') THEN RAISE EXCEPTION 'Invalid screening filter' USING ERRCODE='22023'; END IF;
  filter_sql=CASE p_filter WHEN 'ta_pending' THEN ' AND t.duplicate_of IS NULL AND t.ta_decision IN (''pending'',''defer'')'
   WHEN 'ft_pending' THEN ' AND t.duplicate_of IS NULL AND t.ta_decision=''include'' AND t.ft_decision IN (''pending'',''defer'')'
   WHEN 'included' THEN ' AND t.duplicate_of IS NULL AND t.ft_decision=''include'''
   WHEN 'excluded' THEN ' AND (t.ta_decision=''exclude'' OR t.ft_decision=''exclude'')'
   WHEN 'duplicates' THEN ' AND t.duplicate_of IS NOT NULL' ELSE '' END;
 END IF;
 EXECUTE format('SELECT count(*) FROM public.%I t WHERE project_id=$1 AND ($2='''' OR position($2 IN lower(to_jsonb(t)::text))>0)%s',tab,filter_sql) INTO total USING p_project,q;
 EXECUTE format('SELECT coalesce(jsonb_agg(x),''[]''::jsonb) FROM (SELECT t.* FROM public.%I t WHERE project_id=$1 AND ($2='''' OR position($2 IN lower(to_jsonb(t)::text))>0)%s ORDER BY %s DESC LIMIT 25 OFFSET $3) x',
  tab,filter_sql,CASE WHEN p_section='protocols' THEN 'version' ELSE 'id' END) INTO items USING p_project,q,p_page*25;
 IF p_section='reports' THEN
  SELECT coalesce(jsonb_agg(x.value||jsonb_build_object('local_source',(SELECT jsonb_build_object('hash',content_hash,'type','fulltext','version','current') FROM app_private.local_fulltext_sources WHERE paper_id=(x.value->>'paper_id')::bigint LIMIT 1))), '[]') INTO items FROM jsonb_array_elements(items) x;
 ELSIF p_section='studies' THEN
  SELECT coalesce(jsonb_agg(x.value||jsonb_build_object('report_ids',coalesce((SELECT jsonb_agg(report_id) FROM public.review_study_reports WHERE project_id=p_project AND study_id=(x.value->>'id')::uuid),'[]'))),'[]') INTO items FROM jsonb_array_elements(items) x;
 ELSIF p_section='runs' THEN
  SELECT coalesce(jsonb_agg(x.value-ARRAY['lease_token','worker_id','input_manifest','result']||jsonb_build_object('has_result',x.value->>'result' IS NOT NULL)), '[]') INTO items FROM jsonb_array_elements(items) x;
 END IF;
 RETURN jsonb_build_object('items',items,'total',total,'page',p_page);
END $$;

DO $$DECLARE f record; BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
 ('review_save_protocol','review_save_search','review_import_records','review_save_report','review_save_study','review_save_observation','review_save_assessment','review_workspace','review_list') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.signature);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app_private.review_object(jsonb,text[],integer),app_private.review_number(jsonb,text,numeric,numeric,boolean),app_private.review_values_valid(text,jsonb),app_private.review_draft_values_valid(text,jsonb),app_private.review_audit(bigint,text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE SELECT ON public.review_analysis_runs FROM authenticated;
GRANT SELECT(id,project_id,requested_by,protocol_version,input_manifest,input_hash,config,status,result,error_code,attempts,created_at,completed_at) ON public.review_analysis_runs TO authenticated;

COMMIT;
