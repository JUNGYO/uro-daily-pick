BEGIN;
-- Existing accounts keep access. Only accounts created after this migration wait.
ALTER TABLE public.profiles
 ADD COLUMN access_status text NOT NULL DEFAULT 'pending' CHECK(access_status IN ('pending','approved','rejected')),
 ADD COLUMN access_revision integer NOT NULL DEFAULT 0,
 ADD COLUMN access_reviewed_at timestamptz,
 ADD COLUMN access_reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 ADD COLUMN access_note text NOT NULL DEFAULT '' CHECK(length(access_note)<=500);
UPDATE public.profiles SET access_status='approved',access_reviewed_at=now();
CREATE INDEX profiles_access_queue ON public.profiles(access_status,created_at,id);

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO public.profiles(id,name,institution) VALUES(NEW.id,
  left(coalesce(NEW.raw_user_meta_data->>'name',''),100),left(coalesce(NEW.raw_user_meta_data->>'institution',''),200));
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC,anon,authenticated;

CREATE TABLE app_private.membership_reviews (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 previous_status text NOT NULL, status text NOT NULL, note text NOT NULL,
 revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_private.membership_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.membership_reviews FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.protect_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF current_user IN ('anon','authenticated') THEN
  IF TG_OP='INSERT' OR ROW(NEW.access_status,NEW.access_revision,NEW.access_reviewed_at,NEW.access_reviewed_by,NEW.access_note)
    IS DISTINCT FROM ROW(OLD.access_status,OLD.access_revision,OLD.access_reviewed_at,OLD.access_reviewed_by,OLD.access_note) THEN
   RAISE EXCEPTION 'Administrator approval required' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.protect_membership() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER protect_membership BEFORE INSERT OR UPDATE ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION app_private.protect_membership();

CREATE FUNCTION public.reader_access_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND access_status='approved');
$$;
REVOKE ALL ON FUNCTION public.reader_access_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reader_access_allowed() TO anon,authenticated,service_role;

-- Restrictive policies combine with every existing owner/project policy.
-- Pending readers can still read/edit their own profile and delete their account.
DO $$
DECLARE t record;
BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND c.relname<>'profiles'
 LOOP
  EXECUTE format('CREATE POLICY membership_required ON public.%I AS RESTRICTIVE FOR ALL TO anon,authenticated USING ((SELECT public.reader_access_allowed())) WITH CHECK ((SELECT public.reader_access_allowed()))',t.relname);
 END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.collection_access(p_id bigint,p_edit boolean DEFAULT false) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path='' AS $$
 SELECT public.reader_access_allowed() AND (EXISTS(SELECT 1 FROM public.collections WHERE id=p_id AND user_id=auth.uid()) OR
 EXISTS(SELECT 1 FROM public.collection_members WHERE collection_id=p_id AND user_id=auth.uid() AND accepted AND (NOT p_edit OR role='editor')))
$$;

-- Definer RPCs bypass RLS: gate every reader entry point as well. Worker-token,
-- administrator, account-deletion and trigger functions keep their own guards.
DO $$
DECLARE f record; guarded text;
BEGIN
 FOR f IN SELECT p.oid,p.prosrc,pg_get_functiondef(p.oid) definition FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
  WHERE n.nspname='public' AND p.prosecdef AND l.lanname='plpgsql'
    AND has_function_privilege('authenticated',p.oid,'EXECUTE')
    AND p.proname NOT LIKE 'admin_%'
    AND p.proname NOT IN ('handle_new_user','delete_own_account',
      'claim_research_extractions','fail_research_extraction','finish_research_extraction',
      'claim_review_analysis','finish_review_analysis','confirm_local_fulltext_archive',
      'institution_cloud_archive','institution_worker_status','publish_institution_summary',
      'publish_knowledge','publish_scientific_knowledge','register_institution_original',
      'report_institution_catalog','sync_institution_catalog','sync_institution_events')
 LOOP
  IF f.prosrc !~* '\mBEGIN\M' THEN RAISE EXCEPTION 'Missing reader function body: %',f.oid::regprocedure; END IF;
  guarded=regexp_replace(f.prosrc,'\mBEGIN\M',E'BEGIN\n IF NOT public.reader_access_allowed() THEN RAISE EXCEPTION ''Membership approval required'' USING ERRCODE=''42501''; END IF;','i');
  EXECUTE replace(f.definition,f.prosrc,guarded);
 END LOOP;
END;
$$;

CREATE FUNCTION public.admin_membership_count() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM app_private.require_admin();
 RETURN (SELECT count(*)::integer FROM public.profiles WHERE access_status='pending');
END;
$$;
REVOKE ALL ON FUNCTION public.admin_membership_count() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_membership_count() TO authenticated;

CREATE FUNCTION public.admin_memberships(p_status text DEFAULT 'pending',p_query text DEFAULT '',p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app_private.require_admin();
 IF p_status NOT IN ('pending','approved','rejected') OR p_status IS NULL OR p_page NOT BETWEEN 0 AND 10000 OR p_page IS NULL
  OR p_query IS NULL OR length(p_query)>200 THEN RAISE EXCEPTION 'Invalid membership filter' USING ERRCODE='22023'; END IF;
 SELECT jsonb_build_object('pending_count',(SELECT count(*) FROM public.profiles WHERE access_status='pending'),
  'total',(SELECT count(*) FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.access_status=p_status
    AND (p_query='' OR position(lower(p_query) in lower(coalesce(u.email,'')||' '||p.name||' '||coalesce(p.institution,'')))>0)),
  'items',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (
   SELECT p.id,u.email,p.name,p.institution,p.created_at,u.email_confirmed_at,p.access_status,p.access_revision,p.access_reviewed_at,p.access_note
   FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.access_status=p_status
    AND (p_query='' OR position(lower(p_query) in lower(coalesce(u.email,'')||' '||p.name||' '||coalesce(p.institution,'')))>0)
   ORDER BY p.created_at,p.id LIMIT 20 OFFSET p_page*20
  ) r),'[]'::jsonb)) INTO result;
 RETURN result;
END;
$$;

CREATE FUNCTION public.admin_review_membership(p_user_id uuid,p_status text,p_revision integer,p_note text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE previous public.profiles; email_verified boolean;
BEGIN
 PERFORM app_private.require_admin();
 IF p_status IS NULL OR p_status NOT IN ('approved','rejected') OR p_revision IS NULL OR p_note IS NULL OR length(p_note)>500 THEN
  RAISE EXCEPTION 'Invalid membership decision' USING ERRCODE='22023'; END IF;
 SELECT * INTO previous FROM public.profiles WHERE id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account no longer exists' USING ERRCODE='P0002'; END IF;
 IF previous.access_revision<>p_revision THEN RAISE EXCEPTION 'Membership changed; refresh before reviewing' USING ERRCODE='40001'; END IF;
 IF previous.access_status='approved' THEN RAISE EXCEPTION 'Existing approved accounts retain access' USING ERRCODE='22023'; END IF;
 SELECT email_confirmed_at IS NOT NULL INTO email_verified FROM auth.users WHERE id=p_user_id;
 IF p_status='approved' AND NOT coalesce(email_verified,false) THEN
  RAISE EXCEPTION 'Email verification is required before approval' USING ERRCODE='22023'; END IF;
 UPDATE public.profiles SET access_status=p_status,access_revision=access_revision+1,
  access_reviewed_at=now(),access_reviewed_by=auth.uid(),access_note=trim(p_note) WHERE id=p_user_id;
 INSERT INTO app_private.membership_reviews(user_id,actor_id,previous_status,status,note,revision)
  VALUES(p_user_id,auth.uid(),previous.access_status,p_status,trim(p_note),previous.access_revision+1);
 RETURN jsonb_build_object('id',p_user_id,'status',p_status,'revision',previous.access_revision+1);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_memberships(text,text,integer),public.admin_review_membership(uuid,text,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_memberships(text,text,integer),public.admin_review_membership(uuid,text,integer,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
