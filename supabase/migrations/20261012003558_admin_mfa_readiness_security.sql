BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION app_private.require_admin()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id=auth.uid()
  AND lower(email)='crazyslime@gmail.com' AND email_confirmed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501';
 END IF;
 IF coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'aal','')<>'aal2'
  OR NOT EXISTS (SELECT 1 FROM auth.mfa_factors WHERE user_id=auth.uid() AND status='verified') THEN
  RAISE EXCEPTION 'Administrator two-factor authentication required' USING ERRCODE='42501';
 END IF;
END;
$$;
REVOKE ALL ON FUNCTION app_private.require_admin() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.admin_security_status() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM app_private.require_admin();
 RETURN jsonb_build_object('verified',true);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_security_status() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_security_status() TO authenticated;

-- A SET clause disables SQL-function inlining. Expand the existing, pure
-- readiness predicate inside stored callers before fixing the function path.
-- This preserves the partial-index query plans needed by the large catalog.
DO $$
DECLARE f record; source text; updated text; match text[]; expression text;
BEGIN
 FOR f IN SELECT p.oid,pg_get_functiondef(p.oid) AS definition,p.prosrc
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('public','app_private') AND p.prosrc LIKE '%public.paper_ready(%'
 LOOP
  source=f.prosrc; updated=source;
  FOR match IN SELECT regexp_matches(source,'public\.paper_ready\(([a-zA-Z_][a-zA-Z_0-9]*(?:\.[a-zA-Z_][a-zA-Z_0-9]*)?)\)','g') LOOP
   expression=format('((%1$s).fulltext_available AND (%1$s).summary_basis=''fulltext'' AND (%1$s).summary_source_hash IS NOT NULL AND (%1$s).summarized_at IS NOT NULL AND coalesce((%1$s).summary_model,'''')<>'''' AND pg_catalog.array_length(pg_catalog.string_to_array(pg_catalog.btrim((%1$s).summary_ko),pg_catalog.chr(10)),1)=3)',match[1]);
   updated=replace(updated,'public.paper_ready('||match[1]||')',expression);
  END LOOP;
  IF updated LIKE '%public.paper_ready(%' THEN RAISE EXCEPTION 'Unrecognized readiness caller: %',f.oid::regprocedure; END IF;
  EXECUTE replace(f.definition,source,updated);
 END LOOP;
END;
$$;
ALTER FUNCTION public.paper_ready(public.papers) SET search_path='';
NOTIFY pgrst,'reload schema';
COMMIT;
