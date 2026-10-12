BEGIN;
ALTER TABLE public.profiles
 ADD COLUMN original_access_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN original_access_revision integer NOT NULL DEFAULT 0,
 ADD COLUMN original_access_updated_at timestamptz;
-- Preserve only the existing operator's access. Membership approval alone grants nothing.
UPDATE public.profiles p SET original_access_enabled=true,original_access_updated_at=now()
 FROM auth.users u WHERE u.id=p.id AND lower(u.email)='crazyslime@gmail.com' AND u.email_confirmed_at IS NOT NULL;

CREATE TABLE app_private.original_access_reviews (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 enabled boolean NOT NULL, revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_private.original_access_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.original_access_reviews FROM PUBLIC,anon,authenticated;

CREATE FUNCTION app_private.protect_original_access() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF current_user IN ('anon','authenticated') AND
  (TG_OP='INSERT' OR ROW(NEW.original_access_enabled,NEW.original_access_revision,NEW.original_access_updated_at)
    IS DISTINCT FROM ROW(OLD.original_access_enabled,OLD.original_access_revision,OLD.original_access_updated_at)) THEN
  RAISE EXCEPTION 'Administrator original access permission required' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.protect_original_access() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER protect_original_access BEFORE INSERT OR UPDATE ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION app_private.protect_original_access();

CREATE FUNCTION public.reader_original_access() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.reader_access_allowed() AND EXISTS(
  SELECT 1 FROM public.profiles p JOIN auth.users u ON u.id=p.id
  WHERE p.id=auth.uid() AND p.original_access_enabled AND u.email_confirmed_at IS NOT NULL
 );
$$;
REVOKE ALL ON FUNCTION public.reader_original_access() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reader_original_access() TO authenticated;

CREATE FUNCTION public.admin_set_original_access(p_user_id uuid,p_enabled boolean,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE previous public.profiles; verified boolean; owner_account boolean;
BEGIN
 PERFORM app_private.require_admin();
 IF p_enabled IS NULL OR p_revision IS NULL THEN RAISE EXCEPTION 'Invalid permission decision' USING ERRCODE='22023'; END IF;
 SELECT * INTO previous FROM public.profiles WHERE id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account no longer exists' USING ERRCODE='P0002'; END IF;
 IF previous.original_access_revision<>p_revision THEN RAISE EXCEPTION 'Original access changed; refresh before reviewing' USING ERRCODE='40001'; END IF;
 SELECT email_confirmed_at IS NOT NULL,lower(email)='crazyslime@gmail.com' INTO verified,owner_account FROM auth.users WHERE id=p_user_id;
 IF owner_account THEN RAISE EXCEPTION 'Operator access is preserved' USING ERRCODE='22023'; END IF;
 IF p_enabled AND (previous.access_status<>'approved' OR NOT coalesce(verified,false)) THEN
  RAISE EXCEPTION 'Approved membership and verified email required' USING ERRCODE='22023';
 END IF;
 IF previous.original_access_enabled=p_enabled THEN
  RETURN jsonb_build_object('id',p_user_id,'enabled',p_enabled,'revision',p_revision);
 END IF;
 UPDATE public.profiles SET original_access_enabled=p_enabled,original_access_revision=original_access_revision+1,
  original_access_updated_at=now() WHERE id=p_user_id;
 INSERT INTO app_private.original_access_reviews(user_id,actor_id,enabled,revision)
  VALUES(p_user_id,auth.uid(),p_enabled,p_revision+1);
 RETURN jsonb_build_object('id',p_user_id,'enabled',p_enabled,'revision',p_revision+1);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_original_access(uuid,boolean,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_set_original_access(uuid,boolean,integer) TO authenticated;

-- Preserve the existing reader payload and administrator search/paging contracts.
DO $$
DECLARE definition text; source text; updated text;
BEGIN
 SELECT pg_get_functiondef(oid),prosrc INTO definition,source FROM pg_proc WHERE oid='public.reader_paper(text)'::regprocedure;
 updated=replace(source, 'SELECT lower(email)=''crazyslime@gmail.com'' AND email_confirmed_at IS NOT NULL INTO access_allowed FROM auth.users WHERE id=auth.uid();',
  'SELECT public.reader_original_access() INTO access_allowed;');
 IF updated=source THEN RAISE EXCEPTION 'Reader access contract changed'; END IF;
 EXECUTE replace(definition,source,updated);
 SELECT pg_get_functiondef(oid),prosrc INTO definition,source FROM pg_proc WHERE oid='public.admin_memberships(text,text,integer)'::regprocedure;
 updated=replace(source,'p.access_reviewed_at,p.access_note',
  'p.access_reviewed_at,p.access_note,p.original_access_enabled,p.original_access_revision,p.original_access_updated_at,(lower(u.email)=''crazyslime@gmail.com'') AS original_access_locked');
 IF updated=source THEN RAISE EXCEPTION 'Membership list contract changed'; END IF;
 EXECUTE replace(definition,source,updated);
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
