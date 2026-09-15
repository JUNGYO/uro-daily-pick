BEGIN;
CREATE FUNCTION app_private.flag_summary_review() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF (NEW.integrity_status IS DISTINCT FROM OLD.integrity_status OR NEW.related_notices IS DISTINCT FROM OLD.related_notices)
 AND NEW.integrity_status IN ('corrected','concern','retracted') THEN
 NEW.summary_review_required=true;NEW.summary_review_note='';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER flag_summary_review BEFORE UPDATE ON public.papers FOR EACH ROW EXECUTE FUNCTION app_private.flag_summary_review();
UPDATE public.papers SET summary_review_required=true WHERE integrity_status<>'current';
CREATE FUNCTION public.admin_integrity_review(p_paper_id bigint DEFAULT NULL,p_source_hash text DEFAULT NULL,p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM app_private.require_admin();
 IF p_paper_id IS NOT NULL THEN
 IF p_note IS NULL OR length(trim(p_note)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'Record the review result (10–2000 characters)'; END IF;
 UPDATE public.papers SET summary_review_required=false,summary_review_note=p_note WHERE id=p_paper_id
 AND summary_source_hash=p_source_hash AND p_source_hash IS NOT NULL AND integrity_status<>'retracted';
 IF NOT FOUND THEN RAISE EXCEPTION 'Source changed or paper retracted. Review the current article'; END IF;
 END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (
 SELECT id,pmid,title,integrity_status,related_notices,summary_source_hash FROM public.papers
 WHERE summary_review_required ORDER BY integrity_checked_at DESC NULLS LAST,id DESC LIMIT 100) x);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_integrity_review(bigint,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_integrity_review(bigint,text,text) TO authenticated;
COMMIT;
