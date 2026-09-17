-- Monitor synchronization without scanning citation or acquisition tables.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE FUNCTION public.catalog_sync_health()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE report jsonb; received timestamptz; synced timestamptz;
BEGIN
 SELECT r.status,r.reported_at INTO report,received
 FROM app_private.institution_catalog_reports r
 JOIN app_private.institution_workers w ON w.id=r.worker_id AND w.enabled
 ORDER BY r.reported_at DESC,r.worker_id LIMIT 1;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('available',false,'report_stale',true,'sync_stale',true);
 END IF;
 -- A recent report must not hide an absent or old successful cycle. The
 -- publication RPC already validates timestamps; malformed legacy data also
 -- remains unhealthy rather than being silently replaced with the current time.
 IF jsonb_typeof(report->'last_sync_at')='string' THEN
  BEGIN synced:=(report->>'last_sync_at')::timestamptz;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
   synced:=NULL;
  END;
 END IF;
 RETURN report||jsonb_build_object(
  'available',true,'reported_at',received,
  'report_stale',NOT isfinite(received) OR received<now()-interval '2 hours'
    OR received>now()+interval '5 minutes',
  'sync_stale',synced IS NULL OR NOT isfinite(synced)
    OR synced<now()-interval '2 hours' OR synced>now()+interval '5 minutes');
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_sync_health() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.catalog_sync_health() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
