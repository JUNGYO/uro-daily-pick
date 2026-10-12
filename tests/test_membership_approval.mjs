import assert from 'node:assert/strict';
import {adminMfaFixture} from './approved_reader_fixture.mjs';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const admin='00000000-0000-0000-0000-000000000001';
const old='00000000-0000-0000-0000-000000000002';
const pending='00000000-0000-0000-0000-000000000003';
const unverified='00000000-0000-0000-0000-000000000004';
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].v;
const as=async(role,id='') => {await db.exec(`RESET ROLE; SET ROLE ${role}`);await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);};
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 ${adminMfaFixture}
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO anon,authenticated;`);
 const root=new URL('../supabase/migrations/',import.meta.url);
 for(const file of (await readdir(root)).filter(f=>f.endsWith('.sql')).sort()) {
  if(file.endsWith('_membership_approval.sql')) await db.exec(`INSERT INTO auth.users VALUES
   ('${admin}','crazyslime@gmail.com',now(),'{}'),('${old}','existing@example.test',now(),'{}');`);
  await db.exec(await readFile(new URL(file,root),'utf8'));
 }
 assert.equal(await scalar(`SELECT access_status v FROM public.profiles WHERE id='${old}'`),'approved');
 await db.exec(`INSERT INTO auth.users VALUES
 ('${pending}','new@example.test',now(),'{"name":"New reader","institution":"Clinic","access_status":"approved","original_access_enabled":true}'),
 ('${unverified}','unverified@example.test',null,'{}');
 INSERT INTO public.papers(id,pmid,title,pub_date) VALUES(1,'12345','Synthetic paper','2026-01-01');
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
 GRANT SELECT ON public.papers TO anon;`);
 assert.equal(await scalar(`SELECT access_status v FROM public.profiles WHERE id='${pending}'`),'pending');
 assert.equal(await scalar(`SELECT original_access_enabled v FROM public.profiles WHERE id='${pending}'`),false);
 assert.equal(await scalar(`SELECT institution v FROM public.profiles WHERE id='${pending}'`),'Clinic');
 await as('authenticated',pending);
 assert.equal(await scalar('SELECT public.reader_access_allowed() v'),false);
 assert.equal(await scalar('SELECT count(*)::int v FROM public.papers'),0);
 await assert.rejects(db.query(`UPDATE public.profiles SET access_status='approved' WHERE id='${pending}'`),{code:'42501'});
 await db.query(`UPDATE public.profiles SET name='Edited name' WHERE id='${pending}'`);
 for(const sql of ['SELECT public.reader_daily()','SELECT public.reader_paper(\'12345\')',
  'SELECT public.knowledge_network()','SELECT public.project_invitations()',
  'SELECT public.record_reader_visit()','SELECT public.admin_memberships()',
  `SELECT public.admin_review_membership('${pending}','approved',0)`]) await assert.rejects(db.query(sql),{code:'42501'});
 await assert.rejects(db.query(`INSERT INTO public.collections(user_id,name) VALUES('${pending}','Denied')`),{code:'42501'});
 await as('anon');
 assert.equal(await scalar('SELECT count(*)::int v FROM public.papers'),0);
 await assert.rejects(db.query('SELECT public.admin_memberships()'),{code:'42501'});
 await as('authenticated',admin);
 assert.equal(await scalar('SELECT public.admin_membership_count() v'),2);
 const list=await scalar("SELECT public.admin_memberships('pending','new@example',0) v");
 assert.equal(list.total,1);assert.equal(list.items[0].email,'new@example.test');
 await assert.rejects(db.query(`SELECT public.admin_review_membership('${unverified}','approved',0)`),{code:'22023'});
 await assert.rejects(db.query(`SELECT public.admin_set_original_access('${pending}',true,0)`),{code:'22023'});
 await db.query(`SELECT public.admin_review_membership('${pending}','rejected',0,'Please contact the administrator')`);
 await assert.rejects(db.query(`SELECT public.admin_review_membership('${pending}','approved',0)`),{code:'40001'});
 await db.query(`SELECT public.admin_review_membership('${pending}','approved',1)`);
 await assert.rejects(db.query(`SELECT public.admin_review_membership('${old}','rejected',0)`),{code:'22023'});
 await as('authenticated',pending);
 assert.equal(await scalar('SELECT public.reader_access_allowed() v'),true);
 assert.equal(await scalar('SELECT count(*)::int v FROM public.papers'),1);
 await db.query('SELECT public.reader_daily()');
 await as('postgres');
 assert.equal(await scalar('SELECT count(*)::int v FROM app_private.membership_reviews'),2);
 // Original access is independent of approved membership and cannot be self-granted.
 assert.equal(await scalar(`SELECT original_access_enabled v FROM public.profiles WHERE id='${admin}'`),true);
 assert.equal(await scalar(`SELECT original_access_enabled v FROM public.profiles WHERE id='${old}'`),false);
 await db.exec("UPDATE public.papers SET fulltext_available=true,fulltext_storage='z8' WHERE id=1");
 await as('authenticated',old);
 assert.equal(await scalar('SELECT public.reader_original_access() v'),false);
 await assert.rejects(db.query(`UPDATE public.profiles SET original_access_enabled=true WHERE id='${old}'`),{code:'42501'});
 await assert.rejects(db.query(`SELECT public.admin_set_original_access('${old}',true,0)`),{code:'42501'});
 await assert.rejects(db.query('SELECT * FROM app_private.original_access_reviews'),{code:'42501'});
 await as('anon');
 await assert.rejects(db.query('SELECT public.reader_original_access()'),{code:'42501'});
 await as('authenticated',admin);
 await assert.rejects(db.query(`SELECT public.admin_set_original_access('${unverified}',true,0)`),{code:'22023'});
 await assert.rejects(db.query(`SELECT public.admin_set_original_access('${admin}',false,0)`),{code:'22023'});
 await db.query(`SELECT public.admin_set_original_access('${old}',true,0)`);
 await db.query(`SELECT public.admin_set_original_access('${old}',true,1)`); // Idempotent decision.
 await assert.rejects(db.query(`SELECT public.admin_set_original_access('${old}',false,0)`),{code:'40001'});
 const granted=await scalar("SELECT public.admin_memberships('approved','existing@example',0) v");
 assert.equal(granted.items[0].original_access_enabled,true);
 assert.equal(granted.items[0].original_access_revision,1);
 await as('authenticated',old);
 assert.equal(await scalar('SELECT public.reader_original_access() v'),true);
 assert.equal(await scalar("SELECT public.reader_paper('12345')->'access'->'can_read' v"),true);
 await as('authenticated',admin);
 await db.query(`SELECT public.admin_set_original_access('${old}',false,1)`);
 await as('authenticated',old);
 assert.equal(await scalar('SELECT public.reader_original_access() v'),false);
 assert.equal(await scalar("SELECT public.reader_paper('12345')->'access'->'can_read' v"),false);
 await as('postgres');
 assert.equal(await scalar('SELECT count(*)::int v FROM app_private.original_access_reviews'),2);
 // Every exposed definer entry point belongs to an explicit authorization family.
 const unsecured=(await db.query(`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('authenticated',p.oid,'EXECUTE')
   AND p.prosrc NOT LIKE '%reader_access_allowed%' AND p.prosrc NOT LIKE '%require_admin%'
   AND p.proname NOT IN ('reader_access_allowed','delete_own_account',
    'claim_research_extractions','fail_research_extraction','finish_research_extraction','claim_review_analysis','finish_review_analysis',
    'confirm_local_fulltext_archive','institution_cloud_archive','institution_worker_status','publish_institution_summary','publish_knowledge',
    'publish_scientific_knowledge','register_institution_original','report_institution_catalog','sync_institution_catalog','sync_institution_events')`)).rows;
 assert.deepEqual(unsecured,[]);
 console.log('Membership approval: grandfathering, metadata spoofing, direct writes, RPC/RLS denial, admin decisions, revision conflicts and access verified.');
} finally {await db.close();}
