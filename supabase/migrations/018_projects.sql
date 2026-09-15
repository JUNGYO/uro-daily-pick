BEGIN;
ALTER TABLE public.collections ADD COLUMN keywords text[] NOT NULL DEFAULT '{}' CHECK(cardinality(keywords)<=30);
CREATE TABLE public.collection_members (
 collection_id bigint REFERENCES public.collections(id) ON DELETE CASCADE,
 user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('reader','editor')),
 accepted boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(collection_id,user_id)
);
ALTER TABLE public.collection_members ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.collection_access(p_id bigint,p_edit boolean DEFAULT false) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path='' AS $$
 SELECT auth.uid() IS NOT NULL AND (EXISTS(SELECT 1 FROM public.collections WHERE id=p_id AND user_id=auth.uid()) OR
 EXISTS(SELECT 1 FROM public.collection_members WHERE collection_id=p_id AND user_id=auth.uid() AND accepted AND (NOT p_edit OR role='editor')))
$$;
REVOKE ALL ON FUNCTION public.collection_access(bigint,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.collection_access(bigint,boolean) TO authenticated;
DROP POLICY collections_all ON public.collections;
CREATE POLICY collections_read ON public.collections FOR SELECT TO authenticated USING(public.collection_access(id));
CREATE POLICY collections_insert ON public.collections FOR INSERT TO authenticated WITH CHECK(user_id=auth.uid());
CREATE POLICY collections_update ON public.collections FOR UPDATE TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
CREATE POLICY collections_delete ON public.collections FOR DELETE TO authenticated USING(user_id=auth.uid());
DROP POLICY collection_papers_all ON public.collection_papers;
CREATE POLICY project_papers_read ON public.collection_papers FOR SELECT TO authenticated USING(public.collection_access(collection_id));
CREATE POLICY project_papers_insert ON public.collection_papers FOR INSERT TO authenticated WITH CHECK(public.collection_access(collection_id,true));
CREATE POLICY project_papers_delete ON public.collection_papers FOR DELETE TO authenticated USING(public.collection_access(collection_id,true));
CREATE POLICY memberships_read ON public.collection_members FOR SELECT TO authenticated USING(user_id=auth.uid() OR public.collection_access(collection_id));
GRANT SELECT ON public.collection_members TO authenticated;

CREATE TABLE public.project_notes (
 collection_id bigint NOT NULL,paper_id bigint NOT NULL,note text NOT NULL DEFAULT '' CHECK(length(note)<=6000),
 tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(tags)<=20),updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(collection_id,paper_id),
 FOREIGN KEY(collection_id,paper_id) REFERENCES public.collection_papers(collection_id,paper_id) ON DELETE CASCADE
);
ALTER TABLE public.project_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_notes_read ON public.project_notes FOR SELECT TO authenticated USING(public.collection_access(collection_id));
CREATE POLICY project_notes_write ON public.project_notes FOR ALL TO authenticated USING(public.collection_access(collection_id,true)) WITH CHECK(public.collection_access(collection_id,true) AND updated_by=auth.uid());
GRANT SELECT,INSERT,UPDATE,DELETE ON public.project_notes TO authenticated;

CREATE FUNCTION public.project_members(p_id bigint,p_email text DEFAULT NULL,p_role text DEFAULT 'reader',p_remove uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE member uuid; owner uuid;
BEGIN
 SELECT user_id INTO owner FROM public.collections WHERE id=p_id;
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM owner THEN RAISE EXCEPTION 'Project owner required' USING ERRCODE='42501'; END IF;
 IF p_remove IS NOT NULL THEN DELETE FROM public.collection_members WHERE collection_id=p_id AND user_id=p_remove; END IF;
 IF p_email IS NOT NULL THEN
 IF p_role NOT IN ('reader','editor') OR length(p_email)>254 THEN RAISE EXCEPTION 'Invalid member'; END IF;
 IF trim(p_email) ~* '^URO-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
 SELECT id INTO member FROM auth.users WHERE id=substring(trim(p_email) FROM 5)::uuid;
 ELSE
 SELECT id INTO member FROM auth.users WHERE lower(email)=lower(trim(p_email)) AND email_confirmed_at IS NOT NULL;
 END IF;
 IF member IS NULL THEN RAISE EXCEPTION 'Verified service account required' USING ERRCODE='22023'; END IF;
 IF member=owner THEN RAISE EXCEPTION 'Owner already has access'; END IF;
 INSERT INTO public.collection_members(collection_id,user_id,role) VALUES(p_id,member,p_role)
 ON CONFLICT(collection_id,user_id) DO UPDATE SET role=excluded.role;
 END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'email',u.email,'role',m.role,'accepted',m.accepted)),'[]') FROM public.collection_members m JOIN auth.users u ON u.id=m.user_id WHERE m.collection_id=p_id);
END;
$$;
REVOKE ALL ON FUNCTION public.project_members(bigint,text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.project_members(bigint,text,text,uuid) TO authenticated;
CREATE FUNCTION public.project_invitations(p_accept bigint DEFAULT NULL,p_decline bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 UPDATE public.collection_members SET accepted=true WHERE collection_id=p_accept AND user_id=auth.uid();
 DELETE FROM public.collection_members WHERE collection_id=p_decline AND user_id=auth.uid();
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'role',m.role)),'[]') FROM public.collection_members m JOIN public.collections c ON c.id=m.collection_id WHERE m.user_id=auth.uid() AND NOT accepted);
END;
$$;
REVOKE ALL ON FUNCTION public.project_invitations(bigint,bigint) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.project_invitations(bigint,bigint) TO authenticated;

CREATE FUNCTION public.project_papers(p_id bigint,p_page integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 IF p_page NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'Invalid page'; END IF;
 RETURN jsonb_build_object('items',(SELECT coalesce(jsonb_agg(public.reader_card(p)||jsonb_build_object('note',n.note,'tags',n.tags)),'[]') FROM
 (SELECT p.* FROM public.collection_papers cp JOIN public.papers p ON p.id=cp.paper_id WHERE cp.collection_id=p_id ORDER BY cp.added_at DESC,p.id DESC LIMIT 20 OFFSET p_page*20) p
 LEFT JOIN public.project_notes n ON n.collection_id=p_id AND n.paper_id=p.id),
 'total',(SELECT count(*) FROM public.collection_papers WHERE collection_id=p_id),'can_edit',public.collection_access(p_id,true));
END;
$$;
REVOKE ALL ON FUNCTION public.project_papers(bigint,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.project_papers(bigint,integer) TO authenticated;

CREATE FUNCTION public.project_recommendations(p_id bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE kw text[];
BEGIN
 IF NOT public.collection_access(p_id) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
 SELECT keywords INTO kw FROM public.collections WHERE id=p_id;
 RETURN (SELECT coalesce(jsonb_agg(public.reader_card(p)),'[]') FROM (SELECT p.* FROM public.papers p WHERE p.pub_date>='2000-01-01'
 AND p.integrity_status<>'retracted' AND EXISTS(SELECT 1 FROM unnest(kw) k WHERE p.search_vector@@plainto_tsquery('english',k))
 AND NOT EXISTS(SELECT 1 FROM public.collection_papers cp WHERE cp.collection_id=p_id AND cp.paper_id=p.id)
 ORDER BY p.pub_date DESC,p.id DESC LIMIT 10) p);
END;
$$;
REVOKE ALL ON FUNCTION public.project_recommendations(bigint) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.project_recommendations(bigint) TO authenticated;
COMMIT;
