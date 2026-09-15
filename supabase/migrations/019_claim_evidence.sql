BEGIN;
ALTER FUNCTION public.publish_institution_summary(uuid,text,text,text,text,jsonb,jsonb) RENAME TO publish_institution_summary_v1;
REVOKE ALL ON FUNCTION public.publish_institution_summary_v1(uuid,text,text,text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.publish_institution_summary(p_worker_id uuid,p_token text,p_pmid text,p_doi text,p_title text,p_source jsonb,p_summary jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_evidence jsonb=p_summary->'evidence';v_details jsonb=p_summary->'research_details';field text;refs jsonb;ref jsonb;
BEGIN
 PERFORM app_private.require_institution_worker(p_worker_id,p_token);
 IF p_summary?'evidence' THEN
 IF jsonb_typeof(v_evidence) IS DISTINCT FROM 'object' OR (v_evidence-ARRAY['version','content_hash','claims'])<>'{}'
 OR v_evidence->>'version' IS DISTINCT FROM '1' OR v_evidence->>'content_hash' IS DISTINCT FROM p_source->>'content_hash'
 OR jsonb_typeof(v_evidence->'claims') IS DISTINCT FROM 'object' OR octet_length(v_evidence::text)>16000
 OR jsonb_typeof(v_details) IS DISTINCT FROM 'object' OR (v_details-ARRAY['intervention','comparator','follow_up','outcome','limitations'])<>'{}' THEN
 RAISE EXCEPTION 'Invalid source metadata' USING ERRCODE='22023'; END IF;
 FOREACH field IN ARRAY ARRAY['intervention','comparator','follow_up','outcome','limitations'] LOOP
 IF jsonb_typeof(v_details->field) IS DISTINCT FROM 'string' OR length(v_details->>field) NOT BETWEEN 1 AND 1500 THEN RAISE EXCEPTION 'Invalid research detail'; END IF;
 END LOOP;
 FOR field,refs IN SELECT * FROM jsonb_each(v_evidence->'claims') LOOP
 IF field NOT IN ('summary_1','summary_2','summary_3','qa_1','qa_2','qa_3','study_design','sample_size','key_finding','population','intervention','comparator','follow_up','outcome','limitations')
 OR jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs)>8 THEN RAISE EXCEPTION 'Invalid claim locations'; END IF;
 FOR ref IN SELECT * FROM jsonb_array_elements(refs) LOOP
 IF jsonb_typeof(ref) IS DISTINCT FROM 'string' OR ref#>>'{}' !~ '^(p|table|figure)-[0-9]{7}$' THEN RAISE EXCEPTION 'Only source identifiers allowed'; END IF;
 END LOOP;
 END LOOP;
 FOREACH field IN ARRAY ARRAY['summary_1','summary_2','summary_3'] LOOP
 IF jsonb_array_length(v_evidence->'claims'->field) IS NULL OR jsonb_array_length(v_evidence->'claims'->field)=0 THEN RAISE EXCEPTION 'Summary source required'; END IF;
 END LOOP;
 END IF;
 PERFORM public.publish_institution_summary_v1(p_worker_id,p_token,p_pmid,p_doi,p_title,p_source,p_summary-ARRAY['evidence','research_details']);
 IF p_summary?'evidence' THEN UPDATE public.papers SET evidence=v_evidence,research_details=v_details WHERE pmid=p_pmid;
 ELSE UPDATE public.papers SET evidence='{}',research_details='{}' WHERE pmid=p_pmid; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.publish_institution_summary(uuid,text,text,text,text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_institution_summary(uuid,text,text,text,text,jsonb,jsonb) TO anon,authenticated;

CREATE FUNCTION app_private.invalidate_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.summary_source_hash IS DISTINCT FROM OLD.summary_source_hash OR NEW.title IS DISTINCT FROM OLD.title THEN NEW.evidence='{}';NEW.research_details='{}';END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_claim_evidence BEFORE UPDATE ON public.papers FOR EACH ROW EXECUTE FUNCTION app_private.invalidate_evidence();
COMMIT;
