BEGIN;
CREATE FUNCTION public.review_start_analysis(p_project bigint,p_run_id uuid,p_protocol_version integer,p_rows jsonb,p_config jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='15s' AS $$
DECLARE protocol public.review_protocols; run public.review_analysis_runs; manifest jsonb; data jsonb='[]'; item jsonb; obs record;
 ids uuid[]='{}'; independence_keys text[]='{}'; overlap_keys text[]='{}'; cohort_keys text[]='{}'; key text; field text; expected_kind text; h text;
BEGIN
 IF NOT public.collection_access(p_project,true) THEN RAISE EXCEPTION 'Project editor required' USING ERRCODE='42501'; END IF;
 IF p_run_id IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 2000
  OR NOT app_private.review_object(p_config,ARRAY['profile','measure','outcome','timepoint','comparison','unit','analysis_population','adjustment','model','justification','analysis_intent','prediction_interval'])
  OR coalesce(p_config->>'profile','') NOT IN ('pairwise-binary-v1','pairwise-continuous-v1','pairwise-estimate-v1','mh-common-binary-v1','dta-bivariate-v1')
  OR coalesce(p_config->>'analysis_intent','') NOT IN ('prespecified','exploratory') THEN RAISE EXCEPTION 'Invalid analysis configuration' USING ERRCODE='22023'; END IF;
 expected_kind=CASE p_config->>'profile' WHEN 'pairwise-binary-v1' THEN 'binary' WHEN 'mh-common-binary-v1' THEN 'binary'
  WHEN 'pairwise-continuous-v1' THEN 'continuous' WHEN 'pairwise-estimate-v1' THEN 'effect' WHEN 'dta-bivariate-v1' THEN 'diagnostic' END;
 IF expected_kind='binary' AND coalesce(p_config->>'measure','') NOT IN ('RR','OR','RD') OR expected_kind='continuous' AND coalesce(p_config->>'measure','') NOT IN ('MD','SMD')
  OR expected_kind='effect' AND coalesce(p_config->>'measure','') NOT IN ('RR','OR','HR','MD','SMD') OR expected_kind='diagnostic' AND coalesce(p_config->>'measure','')<>'SeSp'
 THEN RAISE EXCEPTION 'Incompatible effect measure' USING ERRCODE='22023'; END IF;
 IF p_config->>'profile'='mh-common-binary-v1' AND coalesce(length(btrim(p_config->>'justification')),0)=0 THEN RAISE EXCEPTION 'Common effect justification required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('review:'||p_project::text,0));
 SELECT * INTO protocol FROM public.review_protocols WHERE project_id=p_project ORDER BY version DESC LIMIT 1;
 IF protocol.version IS DISTINCT FROM p_protocol_version THEN RAISE EXCEPTION 'Protocol changed' USING ERRCODE='40001'; END IF;
 IF protocol.payload->>'status'<>'locked' THEN RAISE EXCEPTION 'Lock the protocol before analysis' USING ERRCODE='22023'; END IF;
 IF (expected_kind='diagnostic') IS DISTINCT FROM (protocol.payload->>'type'='diagnostic') THEN RAISE EXCEPTION 'Protocol and analysis type differ' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF NOT app_private.review_object(item,ARRAY['id','revision']) THEN RAISE EXCEPTION 'Invalid row manifest' USING ERRCODE='22023'; END IF;
  SELECT o.*,s.label study_label,s.design,s.revision study_revision,s.overlap_group,r.revision report_revision,r.bibliography,r.source,r.paper_id,r.ft_decision,r.duplicate_of
   INTO obs FROM public.review_observations o JOIN public.review_studies s ON s.id=o.study_id JOIN public.review_reports r ON r.id=o.report_id
   WHERE o.project_id=p_project AND o.id=(item->>'id')::uuid;
  IF obs.id IS NULL OR obs.id=ANY(ids) THEN RAISE EXCEPTION 'Missing or repeated observation' USING ERRCODE='22023'; END IF;
  IF obs.revision IS DISTINCT FROM (item->>'revision')::integer OR (obs.evidence->>'report_revision')::integer IS DISTINCT FROM obs.report_revision
  THEN RAISE EXCEPTION 'Observation or report changed' USING ERRCODE='40001'; END IF;
  IF obs.status<>'confirmed' OR obs.kind<>expected_kind OR obs.ft_decision<>'include' OR obs.duplicate_of IS NOT NULL THEN RAISE EXCEPTION 'Only source-confirmed included observations may be analysed' USING ERRCODE='22023'; END IF;
  IF obs.paper_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.papers WHERE id=obs.paper_id AND (integrity_status IN ('retracted','concern') OR summary_review_required)) THEN RAISE EXCEPTION 'Integrity review required' USING ERRCODE='22023'; END IF;
  IF obs.paper_id IS NOT NULL AND obs.evidence->>'source_type'='fulltext' AND EXISTS(SELECT 1 FROM app_private.local_fulltext_sources WHERE paper_id=obs.paper_id)
   AND NOT EXISTS(SELECT 1 FROM app_private.local_fulltext_sources WHERE paper_id=obs.paper_id AND content_hash=obs.evidence->>'source_hash') THEN RAISE EXCEPTION 'Source changed' USING ERRCODE='40001'; END IF;
  FOREACH field IN ARRAY ARRAY['outcome','timepoint','comparison','unit','analysis_population','adjustment'] LOOP
   IF coalesce(p_config->>field,'')='' OR p_config->>field IS DISTINCT FROM obs.context->>field THEN RAISE EXCEPTION 'Incompatible observation context: %',field USING ERRCODE='22023'; END IF;
  END LOOP;
  IF expected_kind IN ('binary','continuous') AND obs.design<>'parallel_RCT' THEN RAISE EXCEPTION 'Raw arm analysis currently supports parallel RCTs only; use a design-adjusted reported effect' USING ERRCODE='22023'; END IF;
  IF expected_kind='effect' AND obs.design IN ('cluster','crossover','cohort','case_control') AND (obs.context->>'adjustment' IS DISTINCT FROM 'adjusted' OR coalesce(length(btrim(obs.context->>'covariates')),0)=0)
  THEN RAISE EXCEPTION 'Document design-adjusted estimates and covariates before analysis' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(data)>0 AND obs.design IS DISTINCT FROM data->0->>'design' THEN RAISE EXCEPTION 'Different study designs require separate syntheses' USING ERRCODE='22023'; END IF;
  IF expected_kind='effect' AND obs.values->>'measure'<>p_config->>'measure' THEN RAISE EXCEPTION 'Effect measures cannot be mixed' USING ERRCODE='22023'; END IF;
  key=obs.study_id::text||':'||(obs.context->>'cohort');
  IF key=ANY(cohort_keys) OR obs.context->>'independence_group'=ANY(independence_keys) OR (obs.overlap_group<>'' AND obs.overlap_group=ANY(overlap_keys)) THEN RAISE EXCEPTION 'Dependent or overlapping cohorts require a different analysis' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(data)>0 AND (obs.context->>'direction' IS DISTINCT FROM data->0->'context'->>'direction'
   OR obs.context->>'value_type' IS DISTINCT FROM data->0->'context'->>'value_type'
   OR expected_kind='diagnostic' AND (obs.context->>'threshold' IS DISTINCT FROM data->0->'context'->>'threshold'
    OR obs.context->>'index_test' IS DISTINCT FROM data->0->'context'->>'index_test' OR obs.context->>'reference_standard' IS DISTINCT FROM data->0->'context'->>'reference_standard'))
  THEN RAISE EXCEPTION 'Scale direction, measurement type or diagnostic definition differs' USING ERRCODE='22023'; END IF;
  ids=array_append(ids,obs.id); independence_keys=array_append(independence_keys,obs.context->>'independence_group'); overlap_keys=array_append(overlap_keys,obs.overlap_group); cohort_keys=array_append(cohort_keys,key);
  data=data||jsonb_build_array(to_jsonb(obs));
 END LOOP;
 SELECT jsonb_build_object('schema_version',1,'project_id',p_project,'protocol',to_jsonb(protocol),'observations',data,
  'excluded_observations',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'revision',revision,'status',status,'reason',CASE WHEN reason<>'' THEN reason ELSE 'Not selected for this specified synthesis' END)) FROM public.review_observations WHERE project_id=p_project AND NOT id=ANY(ids)),'[]'),
  'review_status','not_peer_reviewed','counts',jsonb_build_object('observations',cardinality(ids),'independence_groups',cardinality(independence_keys)),
  'screening',public.review_workspace(p_project)-ARRAY['protocol','can_edit'],
  'search_history',coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM public.review_searches s WHERE project_id=p_project),'[]'),
  'assessments',coalesce((SELECT jsonb_agg(to_jsonb(a)) FROM public.review_assessments a WHERE project_id=p_project),'[]')) INTO manifest;
 IF octet_length(manifest::text)>8000000 THEN RAISE EXCEPTION 'Analysis snapshot exceeds 8 MB; narrow the planned synthesis' USING ERRCODE='22023'; END IF;
 h=encode(sha256(convert_to(jsonb_build_object('input',manifest,'config',p_config)::text,'UTF8')),'hex');
 SELECT * INTO run FROM public.review_analysis_runs WHERE id=p_run_id;
 IF run.id IS NOT NULL THEN
  IF run.project_id<>p_project OR run.requested_by<>auth.uid() OR run.input_hash<>h THEN RAISE EXCEPTION 'Run identity conflict' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('id',run.id,'status',run.status,'input_hash',h);
 END IF;
 INSERT INTO public.review_analysis_runs(id,project_id,requested_by,protocol_version,input_manifest,input_hash,config,status)
 VALUES(p_run_id,p_project,auth.uid(),protocol.version,manifest,h,p_config,'queued');
 PERFORM app_private.review_audit(p_project,'analysis_frozen',p_run_id::text,NULL,jsonb_build_object('input_hash',h,'rows',cardinality(ids)));
 RETURN jsonb_build_object('id',p_run_id,'status','queued','input_hash',h);
END $$;

CREATE FUNCTION public.review_analysis(p_project bigint,p_id uuid,p_cancel boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE run public.review_analysis_runs;
BEGIN
 IF NOT public.collection_access(p_project,p_cancel) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 SELECT * INTO run FROM public.review_analysis_runs WHERE project_id=p_project AND id=p_id FOR UPDATE;
 IF run.id IS NULL THEN RAISE EXCEPTION 'Run not found' USING ERRCODE='22023'; END IF;
 IF p_cancel AND run.status IN ('queued','running') THEN
  UPDATE public.review_analysis_runs SET status='cancelled',lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=p_id RETURNING * INTO run;
  PERFORM app_private.review_audit(p_project,'analysis_cancelled',p_id::text,NULL,jsonb_build_object('status','cancelled'));
 END IF;
 RETURN to_jsonb(run)-ARRAY['lease_token','worker_id']||jsonb_build_object('stale_input',EXISTS(
  SELECT 1 FROM jsonb_array_elements(run.input_manifest->'observations') f
  LEFT JOIN public.review_observations o ON o.id=(f->>'id')::uuid
  LEFT JOIN public.review_reports r ON r.id=o.report_id
  LEFT JOIN public.papers p ON p.id=r.paper_id
  WHERE o.id IS NULL OR o.revision IS DISTINCT FROM (f->>'revision')::integer OR r.revision IS DISTINCT FROM (f->>'report_revision')::integer
   OR p.integrity_status IN ('retracted','concern') OR p.summary_review_required
   OR f->'evidence'->>'source_type'='fulltext' AND EXISTS(SELECT 1 FROM app_private.local_fulltext_sources src WHERE src.paper_id=r.paper_id AND src.content_hash IS DISTINCT FROM f->'evidence'->>'source_hash')));
END $$;

CREATE FUNCTION public.claim_review_analysis(p_worker_id uuid,p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE job public.review_analysis_runs;
BEGIN
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 UPDATE public.review_analysis_runs SET status='failed',error_code='worker_timeout',lease_token=NULL,lease_until=NULL,completed_at=now()
 WHERE status='running' AND lease_until<now() AND attempts>=3;
 SELECT * INTO job FROM public.review_analysis_runs WHERE status='queued' OR (status='running' AND lease_until<now() AND attempts<3)
 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF job.id IS NULL THEN RETURN NULL; END IF;
 UPDATE public.review_analysis_runs SET status='running',worker_id=p_worker_id,lease_token=gen_random_uuid(),lease_until=now()+interval '12 minutes',attempts=attempts+1
 WHERE id=job.id RETURNING * INTO job;
 RETURN jsonb_build_object('id',job.id,'lease_token',job.lease_token,'input_hash',job.input_hash,'input',job.input_manifest,'config',job.config);
END $$;

CREATE FUNCTION public.finish_review_analysis(p_worker_id uuid,p_token text,p_id uuid,p_lease_token uuid,p_input_hash text,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE job public.review_analysis_runs;
BEGIN
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 IF NOT app_private.review_object(p_result,ARRAY['schema_version','status','input_hash','engine','config','rows','pooled','diagnostics','warnings','sensitivity','artifacts','error_code'],4000000)
  OR coalesce(p_result->>'status','') NOT IN ('succeeded','needs_review','failed') OR p_result->>'input_hash' IS DISTINCT FROM p_input_hash
  OR p_result->>'schema_version' IS DISTINCT FROM '1'
  OR jsonb_typeof(p_result->'engine') IS DISTINCT FROM 'object' OR jsonb_typeof(p_result->'rows') IS DISTINCT FROM 'array'
  OR p_result->'engine'->>'name' IS DISTINCT FROM 'uro-review-python'
  OR jsonb_typeof(p_result->'config') IS DISTINCT FROM 'object'
  OR p_result->>'status' IN ('succeeded','needs_review') AND (coalesce(p_result->'engine'->>'code_sha256','') !~ '^[a-f0-9]{64}$'
   OR jsonb_array_length(p_result->'rows')=0)
 THEN RAISE EXCEPTION 'Invalid analysis result' USING ERRCODE='22023'; END IF;
 SELECT * INTO job FROM public.review_analysis_runs WHERE id=p_id FOR UPDATE;
 IF job.id IS NULL OR job.status<>'running' OR job.worker_id IS DISTINCT FROM p_worker_id OR job.lease_token IS DISTINCT FROM p_lease_token OR job.lease_until<now() OR job.input_hash<>p_input_hash THEN RETURN false; END IF;
 IF p_result->'config' IS DISTINCT FROM job.config THEN RAISE EXCEPTION 'Analysis configuration mismatch' USING ERRCODE='22023'; END IF;
 UPDATE public.review_analysis_runs SET status=p_result->>'status',result=p_result,error_code=p_result->>'error_code',completed_at=now(),lease_token=NULL,lease_until=NULL WHERE id=p_id;
 RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.review_start_analysis(bigint,uuid,integer,jsonb,jsonb),public.review_analysis(bigint,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_start_analysis(bigint,uuid,integer,jsonb,jsonb),public.review_analysis(bigint,uuid,boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.claim_review_analysis(uuid,text),public.finish_review_analysis(uuid,text,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_review_analysis(uuid,text),public.finish_review_analysis(uuid,text,uuid,uuid,text,jsonb) TO anon,authenticated;
COMMIT;
