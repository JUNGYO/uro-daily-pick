import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
try {
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 const migrations=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
 for(const file of migrations.filter(f=>Number(f.slice(0,3))<26))
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 await db.exec(`INSERT INTO public.catalog_backfill_jobs(job_key,query,start_date,status,processed,pmids,unavailable_pmids)
 VALUES(repeat('a',64),'old journal','2000-01-01','active',3,'["1","2","3","4"]','["2"]');
 INSERT INTO public.papers(pmid,title,pub_date) VALUES('1','Existing paper','2025-01-01');`);
 const old=(await db.query('SELECT to_jsonb(j) r FROM public.catalog_backfill_jobs j')).rows[0].r;
 await db.exec(await readFile(new URL('../supabase/migrations/026_journal_coverage.sql',import.meta.url),'utf8'));
 const saved=(await db.query('SELECT to_jsonb(j) r FROM public.catalog_backfill_jobs j')).rows[0].r;
 for(const [k,v] of Object.entries(old)) assert.deepEqual(saved[k],v,'Historical checkpoint '+k+' preserved');
 assert.equal(saved.registry_version,null); assert.equal(saved.priority,20);
 let state=(await db.query('SELECT public.catalog_backfill_status() r')).rows[0].r;
 assert.deepEqual(state.scope,{registry_version:'2026-09-17.urology-centered-65.v1',target_journals:65,urology_journals:51,ancillary_journals:14});
 assert.equal(state.catalog_papers,1);assert.equal(state.originals_acquired,0);assert.equal(state.summaries_ready,0);
 assert.equal(state.metadata_examined,0);assert.deepEqual(state.shards,{});
 await db.exec(`INSERT INTO public.catalog_backfill_jobs(job_key,query,start_date,status,processed,pmids,unavailable_pmids,journal_id,query_version,registry_version,priority)
 VALUES(repeat('b',64),'new journal','2000-01-01','active',2,'["5","6","7"]','["6"]','new-journal',repeat('c',64),'2026-09-17.urology-centered-65.v1',0);
 SET ROLE service_role;`);
 state=(await db.query('SELECT public.catalog_backfill_status() r')).rows[0].r;
 assert.equal(state.metadata_examined,2);assert.equal(state.metadata_unavailable,1);assert.deepEqual(state.shards,{active:1});
 assert.equal(state.catalog_papers,1,'Queue targets and search IDs never inflate registered paper count');
 await db.exec('RESET ROLE;SET ROLE anon;');
 await assert.rejects(db.query('SELECT public.catalog_backfill_status()'),/permission denied/);
 await assert.rejects(db.query('SELECT * FROM public.catalog_backfill_jobs'),/permission denied/);
 await db.exec('RESET ROLE;SET ROLE authenticated;');
 await assert.rejects(db.query('SELECT public.catalog_backfill_status()'),/permission denied/);
 await assert.rejects(db.query('SELECT * FROM app_private.catalog_registry_state'),/permission denied/);
 await assert.rejects(db.query('SELECT public.admin_catalog_status()'),/admin|authentication/i);
 console.log('Journal coverage migration: historical checkpoints, scoped queue, real stage counts and permissions passed.');
} finally {await db.close();}
