// Isolated PostgreSQL health contract; no production calls or credentials.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const worker='00000000-0000-0000-0000-000000000009',other='00000000-0000-0000-0000-000000000010';
const owner='00000000-0000-0000-0000-000000000001',reader='00000000-0000-0000-0000-000000000002';
const token='health-fixture-token-'.repeat(3);
const scalar=async(sql,params=[])=> (await db.query(sql,params)).rows[0].r;
const health=()=>scalar('SELECT public.catalog_sync_health() r');
const status={local_papers:100,synced_papers:80,citation_pending:20,local_originals:30,
 local_summaries:10,pending_originals:3,pending_summaries:2,sync_state:'capacity_blocked',
 last_sync_at:new Date().toISOString(),registry_version:'fixture-v1'};
const report=(value,id=worker)=>db.query('SELECT public.report_institution_catalog($1,$2,$3)',[id,token,JSON.stringify(value)]);
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 await db.query('INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES($1,$2,$3),($4,$5,$3)',
  [worker,'Fixture',createHash('sha256').update(token).digest('hex'),other,'Second']);
 await db.query("INSERT INTO auth.users VALUES($1,'crazyslime@gmail.com',now(),'{}'),($2,'reader@example.test',now(),'{}')",[owner,reader]);
 await db.exec('SET ROLE service_role');
 assert.deepEqual(await health(),{available:false,report_stale:true,sync_stale:true});
 await db.exec('RESET ROLE');await report(status);
 await db.exec('SET ROLE service_role');
 let current=await health();
 assert.equal(current.available,true);assert.equal(current.report_stale,false);assert.equal(current.sync_stale,false);
 assert.equal(current.sync_state,'capacity_blocked');assert.equal(current.citation_pending,20);
 assert.equal('worker_id' in current,false);assert.equal('token_hash' in current,false);
 await db.exec("RESET ROLE;UPDATE app_private.institution_catalog_reports SET reported_at=now()-interval '3 hours'");
 current=await health();assert.equal(current.report_stale,true);assert.equal(current.sync_stale,false);
 await db.exec("UPDATE app_private.institution_catalog_reports SET reported_at=now()+interval '10 minutes'");
 assert.equal((await health()).report_stale,true,'Future reports cannot extend freshness');
 for(const last_sync_at of [null,'2020-01-01T00:00:00+00:00']) {
  await report({...status,last_sync_at});current=await health();
  assert.equal(current.report_stale,false);assert.equal(current.sync_stale,true,'Recent report must not hide absent/old cycle');
 }
 // Malformed legacy/manual rows do not turn fresh. Token publication already
 // rejects malformed/future timestamps, tested by the publication suite.
 for(const value of ['invalid','infinity','2099-01-01T00:00:00+00:00',123,{}]) {
  await db.query("UPDATE app_private.institution_catalog_reports SET status=jsonb_set(status,'{last_sync_at}',$1)",[JSON.stringify(value)]);
  assert.equal((await health()).sync_stale,true);
 }
 await report(status);
 await db.exec("UPDATE app_private.institution_catalog_reports SET reported_at=now()-interval '1 minute'");
 await report({...status,local_papers:200,citation_pending:120},other);
 assert.equal((await health()).local_papers,200,'Newest enabled worker provides the report');
 await db.query('UPDATE app_private.institution_workers SET enabled=false WHERE id=$1',[other]);
 assert.equal((await health()).local_papers,100,'Disabled workers cannot mask a stale or missing active report');
 await db.query('UPDATE app_private.institution_workers SET enabled=false WHERE id=$1',[worker]);
 assert.equal((await health()).available,false);
 await db.query('UPDATE app_private.institution_workers SET enabled=true WHERE id=$1',[worker]);
 for(const state of ['offline','error','syncing']) {
  await report({...status,sync_state:state});assert.equal((await health()).sync_state,state,'RPC preserves failures for the monitor');
 }
 await db.exec('SET ROLE anon');await assert.rejects(health(),{code:'42501'});
 await assert.rejects(db.query('SELECT * FROM app_private.institution_catalog_reports'),{code:'42501'});
 await db.exec('RESET ROLE;SET ROLE authenticated');
 for(const id of [reader,owner]) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);
  await assert.rejects(health(),{code:'42501'},'Direct health RPC remains service-only, including admin accounts');
 }
 assert.equal((await scalar('SELECT public.admin_catalog_status() r')).local_catalog.local_papers,100,'Existing admin wrapper remains available');
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[reader]);
 await assert.rejects(db.query('SELECT public.admin_catalog_status()'),{code:'42501'});
 await db.exec(`RESET ROLE;
 CREATE OR REPLACE FUNCTION public.catalog_backfill_status_v26() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'aggregate sentinel'; END $$;
 SET ROLE service_role;`);
 assert.equal((await health()).local_papers,100,'Heartbeat does not execute catalog aggregates');
 assert.equal((await scalar('SELECT public.catalog_backfill_status() r')).local_catalog.local_papers,100,
  'Administrative status also avoids the obsolete wide aggregate after metrics migration');
 console.log('Catalog sync health: lightweight report access, report/cycle freshness, enabled-worker selection and service/admin boundaries passed.');
} finally {await db.close();}
