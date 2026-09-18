// Isolated regression database; no production calls, bodies or credentials.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const worker='00000000-0000-0000-0000-000000000009';
const admin='00000000-0000-0000-0000-000000000001',reader='00000000-0000-0000-0000-000000000002';
const token='admin-metrics-fixture-token-'.repeat(3);
const scalar=async(sql,params=[])=> (await db.query(sql,params)).rows[0]?.r;
const snapshot=()=>scalar('SELECT public.catalog_backfill_status() r');
const bootstrap=(limit=200)=>scalar('SELECT public.bootstrap_admin_catalog_metrics($1) r',[limit]);
const projection=()=>scalar('SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY paper_id),\'[]\') r FROM app_private.admin_catalog_metrics m');
const metric=id=>scalar('SELECT to_jsonb(m)||jsonb_build_object(\'xmin\',xmin::text) r FROM app_private.admin_catalog_metrics m WHERE paper_id=$1',[id]);
const source=id=>db.query(`INSERT INTO app_private.local_fulltext_sources(paper_id,worker_id,title,content_hash,summary_source_hash,characters,section_count)
 SELECT id,$2,title,repeat('b',64),repeat('a',64),3000,3 FROM public.papers WHERE id=$1`,[id,worker]);
const summary=(id,model='spark/nvidia/Qwen3.8-27B-NVFP4.evidence-v1')=>db.query(`UPDATE public.papers SET
 fulltext_available=true,fulltext_storage='z8',summary_basis='fulltext',summary_source_hash=repeat('a',64),
 summarized_at=now(),summary_model=$2,summary_ko=E'First\nSecond\nThird' WHERE id=$1`,[id,model]);
const compareCounts=async()=>{
 const expected=await scalar('SELECT public.catalog_backfill_status_v26() r');
 const actual=await snapshot();
 for(const [key,value] of Object.entries(expected)) assert.deepEqual(actual[key],value,`Preserve previous exact ${key} semantics`);
 assert.equal(actual.counts_available,true);assert.ok(Number.isFinite(Date.parse(actual.counts_updated_at)));
 return actual;
};
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 const migrations=(await readdir(new URL('../supabase/migrations/',import.meta.url)))
  .filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=31).sort();
 for(const file of migrations.filter(f=>!f.startsWith('031_')))
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 await db.query('INSERT INTO app_private.institution_workers(id,name,token_hash,state,last_seen_at) VALUES($1,$2,$3,$4,now())',
  [worker,'Fixture collector',createHash('sha256').update(token).digest('hex'),'running']);
 await db.query("INSERT INTO auth.users VALUES($1,'crazyslime@gmail.com',now(),'{}'),($2,'reader@example.test',now(),'{}')",[admin,reader]);
 await db.exec(`INSERT INTO public.papers(id,pmid,title,pub_date,journal,fetched_at) VALUES
 (1,'1','Current paper','2026-01-01','Urology',now()),
 (2,'2','Archived paper','1999-12-31','Historical Journal',now()-interval '40 days'),
 (3,'3','Undated paper',NULL,NULL,NULL),
 (4,'4','Legacy model summary','2025-01-01','Urology',now()),
 (5,'5','Current model summary','2021-01-01','Oncology',now()),
 (6,'6','Awaiting summary','2000-01-01','Urology',now());
 INSERT INTO public.catalog_backfill_jobs(job_key,query,start_date,status,processed,unavailable_pmids,registry_version)
 VALUES(repeat('c',64),'Active query','2000-01-01','active',5,'["11","12"]','2026-09-17.urology-centered-65.v1');`);
 for(const id of [2,4,5,6]) await source(id);
 await summary(4,'spark/nvidia/Qwen3.8-27B-NVFP4');await summary(5);
 await db.query('SELECT public.report_institution_catalog($1,$2,$3)',[worker,token,JSON.stringify({
  local_papers:20,synced_papers:6,citation_pending:14,local_originals:10,local_summaries:4,
  pending_originals:6,pending_summaries:2,sync_state:'capacity_blocked',last_sync_at:new Date().toISOString(),registry_version:'fixture',
 })]);
 const migration=await readFile(new URL('../supabase/migrations/031_admin_catalog_metrics.sql',import.meta.url),'utf8');

 // The empty-database installation path starts complete with exact zeros.
 await db.exec('BEGIN;DELETE FROM public.papers');
 await db.exec(migration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
 let state=await snapshot();
 assert.equal(state.counts_available,true);assert.equal(state.catalog_papers,0);assert.equal(state.originals_acquired,0);
 assert.deepEqual(await bootstrap(),{processed:0,cursor:0,high_water_id:0,complete:true});
 await db.exec('ROLLBACK');
 await db.exec(migration);

 assert.deepEqual(await scalar('SELECT to_jsonb(s) r FROM app_private.admin_catalog_metrics_state s'),
  {singleton:true,high_water_id:6,cursor:0,complete:false});
 assert.deepEqual(await projection(),[],'Installing the migration does not bulk scan/backfill existing papers');
 state=await snapshot();
 assert.equal(state.counts_available,false);assert.equal(state.counts_updated_at,null);
 for(const key of ['catalog_papers','automatic_papers','archived_papers','undated_papers','oldest_publication','newest_publication',
  'originals_acquired','summaries_ready','qwen_summaries','awaiting_qwen']) assert.equal(state[key],null,`${key} is unknown, not zero, before initialization`);
 assert.equal(state.local_catalog.local_papers,20);assert.equal(state.local_catalog.available,true);
 assert.equal(state.scope.target_journals,65);assert.deepEqual(state.shards,{active:1});
 assert.equal(state.metadata_examined,5);assert.equal(state.metadata_unavailable,2);
 await db.exec("INSERT INTO public.papers(id,pmid,title,pub_date,journal) VALUES(100,'100','Inserted during bootstrap','2027-01-01','New Journal')");
 assert.equal((await projection()).length,1);assert.equal((await snapshot()).catalog_papers,null);
 await db.exec('SET ROLE service_role');
 assert.deepEqual(await bootstrap(2),{processed:2,cursor:2,high_water_id:6,complete:false});
 await db.exec('RESET ROLE');
 assert.deepEqual((await projection()).map(row=>row.paper_id),[1,2,100]);
 assert.equal((await snapshot()).catalog_papers,null,'A partially initialized ledger never leaks partial totals');
 // Triggers keep both already-visited and not-yet-visited rows current.
 await db.exec("UPDATE public.papers SET pub_date='2002-02-02',journal='Updated Journal',fetched_at=now()-interval '2 days' WHERE id=2");
 await source(1);await summary(1);
 await db.exec("UPDATE public.papers SET pub_date='1998-01-01' WHERE id=5;DELETE FROM public.papers WHERE id=3");
 const beforeFailure=await projection();
 await db.exec(`CREATE FUNCTION public.fixture_interrupt_metrics() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.paper_id=5 THEN RAISE EXCEPTION 'fixture bootstrap interruption';END IF;RETURN NEW;END $$;
 CREATE TRIGGER fixture_interrupt_metrics BEFORE INSERT ON app_private.admin_catalog_metrics
 FOR EACH ROW EXECUTE FUNCTION public.fixture_interrupt_metrics();`);
 await assert.rejects(bootstrap(2),/fixture bootstrap interruption/);
 assert.deepEqual(await projection(),beforeFailure,'An interrupted page rolls back earlier projection writes');
 assert.equal(await scalar('SELECT cursor r FROM app_private.admin_catalog_metrics_state'),2,'An interrupted page never advances its durable cursor');
 await db.exec('DROP TRIGGER fixture_interrupt_metrics ON app_private.admin_catalog_metrics');
 await db.exec('SET ROLE service_role');
 assert.deepEqual(await bootstrap(2),{processed:2,cursor:5,high_water_id:6,complete:false});
 assert.deepEqual(await bootstrap(2),{processed:1,cursor:6,high_water_id:6,complete:true});
 assert.deepEqual(await bootstrap(),{processed:0,cursor:6,high_water_id:6,complete:true},'A completed bootstrap is a no-op, not a rescan');
 await db.exec('RESET ROLE');
 state=await compareCounts();
 assert.equal(state.catalog_papers,6);assert.equal(state.automatic_papers,5);assert.equal(state.archived_papers,1);
 assert.equal(state.originals_acquired,4);assert.equal(state.summaries_ready,2);assert.equal(state.qwen_summaries,1);
 assert.equal((await metric(2)).journal,'Updated Journal');

 // Instrument the projection function after bootstrap: classification updates
 // must not even enter it, and irrelevant receipt refreshes must not call it.
 await db.exec(`CREATE TABLE public.fixture_metric_calls(count integer);INSERT INTO public.fixture_metric_calls VALUES(0);
 ALTER FUNCTION app_private.refresh_admin_catalog_metric(bigint) RENAME TO fixture_original_refresh_admin_catalog_metric;
 CREATE FUNCTION app_private.refresh_admin_catalog_metric(p_paper_id bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
 BEGIN UPDATE public.fixture_metric_calls SET count=count+1;PERFORM app_private.fixture_original_refresh_admin_catalog_metric(p_paper_id);END $$;`);
 const unchanged=await metric(1);
 const candidates=await scalar('SELECT public.classification_candidates() r');
 const candidate=candidates.find(row=>row.id===1);
 await db.query('SELECT public.apply_paper_classifications($1)',[JSON.stringify([{id:1,source_hash:candidate.classification_source_hash,study_type:'other'}])]);
 assert.equal(await scalar('SELECT count r FROM public.fixture_metric_calls'),0,'Classification does not call the projection function');
 assert.deepEqual(await metric(1),unchanged,'Classification preserves metric values and row version');
 await db.exec("UPDATE public.papers SET journal=journal,fetched_at=fetched_at,summary_ko=E'Different\nValid\nSummary',summarized_at=now(),keywords='[\"New keyword\"]' WHERE id=1");
 assert.equal(await scalar('SELECT count r FROM public.fixture_metric_calls'),0,'Only count-relevant changes trigger projection');
 assert.deepEqual(await metric(1),unchanged);
 await db.exec('UPDATE app_private.local_fulltext_sources SET verified_at=now(),characters=4000 WHERE paper_id=1');
 assert.equal(await scalar('SELECT count r FROM public.fixture_metric_calls'),0,'Receipt heartbeat and size changes do not alter readiness');
 await db.exec("UPDATE public.papers SET summary_model='another-valid-model' WHERE id=1");
 assert.equal(await scalar('SELECT count r FROM public.fixture_metric_calls'),1);
 assert.deepEqual(await metric(1),unchanged,'Recomputed identical derived metrics do not rewrite the ledger');

 await db.exec("UPDATE app_private.local_fulltext_sources SET summary_source_hash=repeat('d',64) WHERE paper_id=1");
 assert.equal((await metric(1)).summary_ready,false);await compareCounts();
 await db.exec("UPDATE public.papers SET summary_source_hash=repeat('d',64) WHERE id=1");
 assert.equal((await metric(1)).summary_ready,true);await compareCounts();
 await db.exec('UPDATE public.papers SET summary_ko=NULL WHERE id=1');
 assert.equal((await metric(1)).summary_ready,false);await compareCounts();
 await db.exec('DELETE FROM app_private.local_fulltext_sources WHERE paper_id=6');
 assert.equal((await metric(6)).original_acquired,false);await compareCounts();
 await db.exec('DELETE FROM public.papers WHERE id=4');
 assert.equal(await metric(4),undefined);state=await compareCounts();assert.equal(state.qwen_summaries,0);
 await db.exec("UPDATE public.papers SET pub_date=NULL WHERE id=100");
 state=await compareCounts();assert.equal(state.undated_papers,1);

 for(const limit of [0,501,null]) await assert.rejects(bootstrap(limit),{code:'22023'});
 for(const role of ['anon','authenticated']) {
  await db.exec(`SET ROLE ${role}`);
  await assert.rejects(bootstrap(),{code:'42501'});
  await assert.rejects(db.query('SELECT * FROM app_private.admin_catalog_metrics'),{code:'42501'});
  await assert.rejects(db.query('SELECT * FROM app_private.admin_catalog_metrics_state'),{code:'42501'});
  await assert.rejects(db.query('SELECT app_private.refresh_admin_catalog_metric(1)'),{code:'42501'});
  await assert.rejects(snapshot(),{code:'42501'});
  await db.exec('RESET ROLE');
 }
 await db.exec('SET ROLE authenticated');
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[reader]);
 await assert.rejects(db.query('SELECT public.admin_worker_status()'),/admin|authentication/i);
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[admin]);
 const workers=await scalar('SELECT public.admin_worker_status() r');
 assert.deepEqual(Object.keys(workers),['workers']);assert.equal(workers.workers.length,1);
 assert.deepEqual(Object.keys(workers.workers[0]).sort(),['last_seen_at','name','state']);
 assert.equal((await scalar('SELECT public.admin_catalog_status() r')).counts_available,true);
 await db.exec('RESET ROLE;SET ROLE service_role');
 await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
 await assert.rejects(db.query('SELECT public.admin_worker_status()'),{code:'42501'});
 assert.equal(await scalar("SELECT has_function_privilege('service_role','public.admin_worker_status()','EXECUTE') r"),true,
  'Service schema discovery sees the endpoint while its admin identity check still denies an ordinary service JWT');
 await assert.rejects(db.query('SELECT * FROM app_private.admin_catalog_metrics'),{code:'42501'});
 await db.exec('RESET ROLE');
 // Removing the obsolete implementation cannot break current metrics or worker
 // reads. Every count was also compared with that implementation above.
 await db.exec(`CREATE OR REPLACE FUNCTION public.catalog_backfill_status_v26() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
 BEGIN RAISE EXCEPTION 'obsolete full scan';END $$;`);
 assert.equal((await snapshot()).counts_available,true);
 assert.equal(await scalar("SELECT provolatile r FROM pg_proc WHERE oid='public.catalog_backfill_status()'::regprocedure"),'s');
 assert.equal(await scalar("SELECT provolatile r FROM pg_proc WHERE oid='public.admin_worker_status()'::regprocedure"),'s');
 console.log('Admin catalog metrics: bounded bootstrap, truthful initialization, exact incremental counts, unchanged/classification no-write paths, receipt invalidation, legacy semantics and authorization passed.');
} finally {await db.close();}
