BEGIN;
CREATE TABLE app_private.catalog_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  budget_bytes bigint NOT NULL CHECK(budget_bytes>=1048576)
);
INSERT INTO app_private.catalog_capacity VALUES(true,450::bigint*1024*1024);
ALTER TABLE app_private.catalog_capacity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.catalog_capacity FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.catalog_storage_status()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('database_bytes',pg_catalog.pg_database_size(pg_catalog.current_database()),
   'budget_bytes',(SELECT budget_bytes FROM app_private.catalog_capacity WHERE singleton));
$$;
REVOKE ALL ON FUNCTION public.catalog_storage_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.catalog_storage_status() TO service_role;

CREATE OR REPLACE FUNCTION public.admin_catalog_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM app_private.require_admin();
 RETURN public.catalog_backfill_status()||jsonb_build_object('storage',public.catalog_storage_status());
END;
$$;
COMMIT;
