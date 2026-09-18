-- Keep administrative counts off the wide, frequently updated paper rows.
-- Existing rows are projected later through bounded, resumable transactions.
BEGIN;
SET LOCAL lock_timeout='5s';
-- Establish the initial boundary and install change tracking under one explicit
-- writer barrier. No insert or receipt change can fall between those steps.
-- The transaction performs DDL only; historical projection happens later.
LOCK TABLE public.papers,app_private.local_fulltext_sources IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE app_private.admin_catalog_metrics (
 paper_id bigint PRIMARY KEY REFERENCES public.papers(id) ON DELETE CASCADE,
 pub_date date,
 journal text,
 fetched_at timestamptz,
 original_acquired boolean NOT NULL,
 summary_ready boolean NOT NULL,
 qwen_ready boolean NOT NULL
);
CREATE INDEX admin_catalog_metrics_publication ON app_private.admin_catalog_metrics(pub_date);
CREATE INDEX admin_catalog_metrics_fetched ON app_private.admin_catalog_metrics(fetched_at);
CREATE TABLE app_private.admin_catalog_metrics_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 high_water_id bigint NOT NULL,
 cursor bigint NOT NULL DEFAULT 0,
 complete boolean NOT NULL DEFAULT false
);
ALTER TABLE app_private.admin_catalog_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.admin_catalog_metrics_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.admin_catalog_metrics,app_private.admin_catalog_metrics_state
 FROM PUBLIC,anon,authenticated,service_role;
-- A single backwards primary-key lookup, not a catalog aggregation/backfill.
INSERT INTO app_private.admin_catalog_metrics_state(singleton,high_water_id,cursor,complete)
 SELECT true,coalesce(id,0),0,id IS NULL
 FROM (SELECT (SELECT p.id FROM public.papers p ORDER BY p.id DESC LIMIT 1) AS id) initial;

CREATE FUNCTION app_private.refresh_admin_catalog_metric(p_paper_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO app_private.admin_catalog_metrics AS m
  (paper_id,pub_date,journal,fetched_at,original_acquired,summary_ready,qwen_ready)
 SELECT p.id,p.pub_date,p.journal,p.fetched_at,s.paper_id IS NOT NULL,
  coalesce(p.fulltext_available AND p.summary_basis='fulltext'
   AND p.summary_source_hash=s.summary_source_hash AND p.summarized_at IS NOT NULL
   AND p.summary_model IS NOT NULL AND p.summary_ko IS NOT NULL,false),
  coalesce(p.summary_model='spark/nvidia/Qwen3.8-27B-NVFP4'
   AND p.summary_source_hash IS NOT NULL AND p.summarized_at IS NOT NULL,false)
 FROM public.papers p LEFT JOIN app_private.local_fulltext_sources s ON s.paper_id=p.id
 WHERE p.id=p_paper_id
 ON CONFLICT(paper_id) DO UPDATE SET pub_date=excluded.pub_date,journal=excluded.journal,
  fetched_at=excluded.fetched_at,original_acquired=excluded.original_acquired,
  summary_ready=excluded.summary_ready,qwen_ready=excluded.qwen_ready
 WHERE (m.pub_date,m.journal,m.fetched_at,m.original_acquired,m.summary_ready,m.qwen_ready)
  IS DISTINCT FROM (excluded.pub_date,excluded.journal,excluded.fetched_at,
   excluded.original_acquired,excluded.summary_ready,excluded.qwen_ready);
END;
$$;

CREATE FUNCTION app_private.track_admin_catalog_paper() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM app_private.refresh_admin_catalog_metric(NEW.id);
 RETURN NEW;
END;
$$;
CREATE TRIGGER track_admin_catalog_paper_insert AFTER INSERT ON public.papers
 FOR EACH ROW EXECUTE FUNCTION app_private.track_admin_catalog_paper();
-- Trigger WHEN avoids a function call, join or metric write for classification,
-- evidence, feedback and unchanged citation assignments.
CREATE TRIGGER track_admin_catalog_paper_update AFTER UPDATE ON public.papers
 FOR EACH ROW WHEN (
  (OLD.pub_date,OLD.journal,OLD.fetched_at,OLD.fulltext_available,OLD.summary_basis,
   OLD.summary_source_hash,OLD.summarized_at IS NOT NULL,OLD.summary_model,OLD.summary_ko IS NOT NULL)
  IS DISTINCT FROM
  (NEW.pub_date,NEW.journal,NEW.fetched_at,NEW.fulltext_available,NEW.summary_basis,
   NEW.summary_source_hash,NEW.summarized_at IS NOT NULL,NEW.summary_model,NEW.summary_ko IS NOT NULL))
 EXECUTE FUNCTION app_private.track_admin_catalog_paper();

CREATE FUNCTION app_private.track_admin_catalog_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE keys bigint[]; paper_key bigint;
BEGIN
 keys:=CASE WHEN TG_OP='INSERT' THEN ARRAY[NEW.paper_id]
  WHEN TG_OP='DELETE' THEN ARRAY[OLD.paper_id] ELSE ARRAY[OLD.paper_id,NEW.paper_id] END;
 FOR paper_key IN SELECT DISTINCT id FROM unnest(keys) AS ids(id) ORDER BY id LOOP
  -- Publication RPCs already acquire the paper lock before changing a receipt.
  -- This also serializes a direct maintenance write with the bootstrap page.
  PERFORM p.id FROM public.papers p WHERE p.id=paper_key FOR UPDATE;
  IF FOUND THEN PERFORM app_private.refresh_admin_catalog_metric(paper_key); END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER track_admin_catalog_source_insert AFTER INSERT ON app_private.local_fulltext_sources
 FOR EACH ROW EXECUTE FUNCTION app_private.track_admin_catalog_source();
CREATE TRIGGER track_admin_catalog_source_update AFTER UPDATE ON app_private.local_fulltext_sources
 FOR EACH ROW WHEN ((OLD.paper_id,OLD.summary_source_hash) IS DISTINCT FROM (NEW.paper_id,NEW.summary_source_hash))
 EXECUTE FUNCTION app_private.track_admin_catalog_source();
CREATE TRIGGER track_admin_catalog_source_delete AFTER DELETE ON app_private.local_fulltext_sources
 FOR EACH ROW EXECUTE FUNCTION app_private.track_admin_catalog_source();

CREATE FUNCTION public.bootstrap_admin_catalog_metrics(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE progress app_private.admin_catalog_metrics_state%ROWTYPE; keys bigint[];
 paper_key bigint; processed integer;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'Invalid metrics bootstrap page' USING ERRCODE='22023';
 END IF;
 SELECT * INTO STRICT progress FROM app_private.admin_catalog_metrics_state WHERE singleton FOR UPDATE;
 IF progress.complete THEN
  RETURN jsonb_build_object('processed',0,'cursor',progress.cursor,
   'high_water_id',progress.high_water_id,'complete',true);
 END IF;
 SELECT coalesce(array_agg(page.id ORDER BY page.id),'{}'::bigint[]) INTO keys FROM (
  SELECT p.id FROM public.papers p WHERE p.id>progress.cursor AND p.id<=progress.high_water_id
  ORDER BY p.id LIMIT p_limit FOR UPDATE
 ) page;
 processed:=cardinality(keys);
 -- Read the projection only after all page locks were acquired, using fresh
 -- statement snapshots. Never replay an unlocked, older metadata snapshot.
 FOREACH paper_key IN ARRAY keys LOOP
  PERFORM app_private.refresh_admin_catalog_metric(paper_key);
 END LOOP;
 progress.cursor:=CASE WHEN processed>0 THEN keys[processed] ELSE progress.high_water_id END;
 progress.complete:=processed<p_limit OR progress.cursor>=progress.high_water_id;
 IF progress.complete THEN progress.cursor:=progress.high_water_id; END IF;
 UPDATE app_private.admin_catalog_metrics_state SET cursor=progress.cursor,complete=progress.complete WHERE singleton;
 RETURN jsonb_build_object('processed',processed,'cursor',progress.cursor,
  'high_water_id',progress.high_water_id,'complete',progress.complete);
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_backfill_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH progress AS MATERIALIZED (
  SELECT complete FROM app_private.admin_catalog_metrics_state WHERE singleton
 ), totals AS MATERIALIZED (
  SELECT count(*) AS n,
   count(*) FILTER(WHERE pub_date>=DATE '2000-01-01') AS eligible,
   count(*) FILTER(WHERE pub_date<DATE '2000-01-01') AS archived,
   count(*) FILTER(WHERE pub_date IS NULL) AS undated,
   min(pub_date) AS oldest,max(pub_date) AS newest,
   count(*) FILTER(WHERE pub_date>=DATE '2000-01-01' AND original_acquired) AS originals,
   count(*) FILTER(WHERE pub_date>=DATE '2000-01-01' AND summary_ready) AS summaries,
   count(*) FILTER(WHERE pub_date>=DATE '2000-01-01' AND qwen_ready) AS qwen
  FROM app_private.admin_catalog_metrics WHERE (SELECT complete FROM progress)
 ), active_jobs AS MATERIALIZED (
  SELECT j.status,j.processed,jsonb_array_length(j.unavailable_pmids) AS unavailable,j.updated_at
  FROM public.catalog_backfill_jobs j JOIN app_private.catalog_registry_state r ON r.registry_version=j.registry_version
  WHERE r.singleton AND j.start_date=DATE '2000-01-01'
 ), jobs AS MATERIALIZED (
  SELECT coalesce(sum(processed),0) AS examined,coalesce(sum(unavailable),0) AS unavailable,max(updated_at) AS updated
  FROM active_jobs
 )
 SELECT jsonb_build_object(
  'counts_available',progress.complete,'counts_updated_at',CASE WHEN progress.complete THEN statement_timestamp() END,
  'automatic_start_date','2000-01-01','recent_years',5,
  'scope',(SELECT jsonb_build_object('registry_version',r.registry_version,'target_journals',r.target_journals,
   'urology_journals',r.urology_journals,'ancillary_journals',r.ancillary_journals)
   FROM app_private.catalog_registry_state r WHERE r.singleton),
  'catalog_papers',CASE WHEN progress.complete THEN totals.n END,
  'automatic_papers',CASE WHEN progress.complete THEN totals.eligible END,
  'archived_papers',CASE WHEN progress.complete THEN totals.archived END,
  'undated_papers',CASE WHEN progress.complete THEN totals.undated END,
  'oldest_publication',CASE WHEN progress.complete THEN totals.oldest END,
  'newest_publication',CASE WHEN progress.complete THEN totals.newest END,
  'qwen_summaries',CASE WHEN progress.complete THEN totals.qwen END,
  'awaiting_qwen',CASE WHEN progress.complete THEN totals.eligible-totals.qwen END,
  'originals_acquired',CASE WHEN progress.complete THEN totals.originals END,
  'summaries_ready',CASE WHEN progress.complete THEN totals.summaries END,
  'shards',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM
   (SELECT status,count(*) AS n FROM active_jobs GROUP BY status) states),
  'metadata_examined',jobs.examined,'metadata_unavailable',jobs.unavailable,'updated_at',jobs.updated,
  'local_catalog',coalesce((SELECT r.status||jsonb_build_object('available',true,'reported_at',r.reported_at,
    'stale',r.reported_at<now()-interval '2 hours')
   FROM app_private.institution_catalog_reports r JOIN app_private.institution_workers w ON w.id=r.worker_id AND w.enabled
   ORDER BY r.reported_at DESC,r.worker_id LIMIT 1),jsonb_build_object('available',false,'stale',true))
 ) FROM progress CROSS JOIN totals CROSS JOIN jobs
$$;

CREATE FUNCTION public.admin_worker_status()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM app_private.require_admin();
 RETURN jsonb_build_object('workers',(SELECT coalesce(jsonb_agg(jsonb_build_object(
  'name',name,'state',state,'last_seen_at',last_seen_at) ORDER BY id),'[]')
  FROM app_private.institution_workers WHERE enabled));
END;
$$;

REVOKE ALL ON FUNCTION app_private.refresh_admin_catalog_metric(bigint),
 app_private.track_admin_catalog_paper(),app_private.track_admin_catalog_source()
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.bootstrap_admin_catalog_metrics(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_admin_catalog_metrics(integer) TO service_role;
REVOKE ALL ON FUNCTION public.admin_worker_status() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_worker_status() TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
