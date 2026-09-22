// Isolated receipt-based journal counts; no production requests or source bodies.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const admin='00000000-0000-0000-0000-000000000001';
const reader='00000000-0000-0000-0000-000000000002';
const worker='00000000-0000-0000-0000-000000000003';
const scalar=async(sql,params=[]) => (await db.query(sql,params)).rows[0].r;
const call=()=>scalar('SELECT public.admin_journal_fulltext_counts() r');
const source=ids=>db.query(`INSERT INTO app_private.local_fulltext_sources
 (paper_id,worker_id,title,content_hash,summary_source_hash,characters,section_count)
 SELECT id,$1,title,repeat('a',64),repeat('b',64),3000,3 FROM public.papers WHERE id=ANY($2)`,[worker,ids]);
async function asUser(role,id='') {
 await db.exec(`RESET ROLE;SET ROLE ${role}`);
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);
}
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 await db.exec(`INSERT INTO auth.users VALUES('${admin}','crazyslime@gmail.com',now(),'{}'),('${reader}','reader@example.test',now(),'{}');
 INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES('${worker}','Fixture',repeat('a',64));
 INSERT INTO public.papers(id,pmid,title,journal,pub_date,fulltext_available) VALUES
 (1,'1','Citation only','Journal A','2026-01-01',false),
 (2,'2','Flag without receipt','Journal A','2026-01-01',true),
 (3,'3','Original awaiting summary','Journal B','2026-01-01',false),
 (4,'4','Another original','Journal B','2000-01-01',true),
 (5,'5','Before catalog period','Journal A','1999-12-31',true),
 (6,'6','Undated','Journal A',NULL,true),
 (7,'7','Unknown journal',NULL,'2026-01-01',true);`);
 await source([3,4,5,6,7]);
 const definition=await scalar("SELECT pg_get_functiondef('public.admin_journal_fulltext_counts()'::regprocedure) r");
 assert.doesNotMatch(definition,/\bpublic\.papers\b/,'Read only the compact existing ledger');
 assert.equal(await scalar("SELECT has_function_privilege('anon','public.admin_journal_fulltext_counts()','EXECUTE') r"),false);
 for(const [role,id] of [['anon',''],['authenticated',reader],['authenticated',''],['service_role','']]) {
  await asUser(role,id);await assert.rejects(call,{code:'42501'});
 }
 await asUser('authenticated',admin);
 let value=await call();
 assert.equal(value.counts_available,true);
 assert.deepEqual(value.journals,[{journal:'Journal B',fulltext_count:2},{journal:'',fulltext_count:1}]);
 assert.ok(Number.isFinite(Date.parse(value.counts_updated_at)));
 assert.ok(value.journals.every(j=>!('recent_count' in j)),'Citation updates are not new original acquisitions');
 await db.exec(`RESET ROLE;UPDATE public.papers SET fetched_at=now(),title=title||' updated';`);
 await asUser('authenticated',admin);
 assert.deepEqual((await call()).journals,value.journals,'Metadata refresh cannot inflate original counts');
 await db.exec('RESET ROLE;DELETE FROM app_private.local_fulltext_sources WHERE paper_id=4');
 await asUser('authenticated',admin);
 assert.equal((await call()).journals.find(j=>j.journal==='Journal B').fulltext_count,1,'Removed receipt stops counting');
 await db.exec('RESET ROLE;UPDATE app_private.admin_catalog_metrics_state SET complete=false');
 await asUser('authenticated',admin);
 assert.deepEqual(await call(),{counts_available:false,counts_updated_at:null,journals:null});
 await db.exec('RESET ROLE;UPDATE app_private.admin_catalog_metrics_state SET complete=true');
 await db.exec(`INSERT INTO public.papers(id,pmid,title,journal,pub_date)
 SELECT 100+i,(100+i)::text,'Original','Extra '||lpad(i::text,2,'0'),'2026-01-01'::date FROM generate_series(1,31) s(i)`);
 await source(Array.from({length:31},(_,i)=>101+i));
 await asUser('authenticated',admin);value=await call();
 assert.equal(value.journals.length,30);
 await db.exec('RESET ROLE;ALTER TABLE public.papers RENAME TO fixture_unavailable');
 await asUser('authenticated',admin);
 assert.deepEqual((await call()).journals,value.journals,'The RPC never falls back to scanning full paper payloads');
 await db.exec('RESET ROLE;ALTER TABLE public.fixture_unavailable RENAME TO papers;DELETE FROM public.papers;BEGIN READ ONLY');
 await asUser('authenticated',admin);value=await call();
 assert.equal(value.counts_available,true);assert.deepEqual(value.journals,[]);
 await db.exec('COMMIT');
 console.log('Journal full-text counts: actual receipts, date bounds, metadata-only exclusion, receipt deletion, authorization, initialization and bounded ledger-only reads passed.');
} finally {await db.close();}
