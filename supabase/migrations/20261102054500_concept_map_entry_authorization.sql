BEGIN;

-- Keep the public entry point in the same explicit approval family as other reader RPCs.
-- The private core still verifies the confirmed reader and project/library scope.
CREATE OR REPLACE FUNCTION public.knowledge_concept_map(p_filters jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='15s'
AS $$
BEGIN
 IF NOT public.reader_access_allowed() THEN
  RAISE EXCEPTION 'Approved membership required' USING ERRCODE='42501';
 END IF;
 RETURN app_private.knowledge_concept_map_core(p_filters,false);
END;
$$;
REVOKE ALL ON FUNCTION public.knowledge_concept_map(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.knowledge_concept_map(jsonb) TO authenticated;

COMMIT;
