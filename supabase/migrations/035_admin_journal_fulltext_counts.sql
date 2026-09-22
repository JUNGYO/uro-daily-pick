-- Journal coverage is based on verified original receipts, not citation updates.
BEGIN;
CREATE OR REPLACE FUNCTION public.admin_journal_fulltext_counts()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE ready boolean; result jsonb;
BEGIN
 PERFORM app_private.require_admin();
 SELECT coalesce((SELECT complete FROM app_private.admin_catalog_metrics_state WHERE singleton),false) INTO ready;
 IF NOT ready THEN
  RETURN jsonb_build_object('counts_available',false,'counts_updated_at',NULL,'journals',NULL);
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.fulltext_count DESC,t.journal),'[]'::jsonb)
 INTO result FROM (
  SELECT coalesce(nullif(btrim(journal),''),'') AS journal,count(*) AS fulltext_count
  FROM app_private.admin_catalog_metrics
  WHERE original_acquired AND pub_date>=DATE '2000-01-01'
  GROUP BY coalesce(nullif(btrim(journal),''),'')
  ORDER BY fulltext_count DESC,journal LIMIT 30
 ) t;
 RETURN jsonb_build_object('counts_available',true,'counts_updated_at',statement_timestamp(),'journals',result);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_journal_fulltext_counts() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_journal_fulltext_counts() TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
