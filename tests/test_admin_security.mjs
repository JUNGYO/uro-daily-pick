import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { approvedReaderFixture } from './approved_reader_fixture.mjs';
const db = new PGlite();
const owner = '00000000-0000-0000-0000-000000000001', reader = '00000000-0000-0000-0000-000000000002';
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.v;
const login = async (id, claims) => {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [id, JSON.stringify(claims)]);
  await db.exec('SET ROLE authenticated');
};
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
    ${approvedReaderFixture}
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
  let previous;
  const root = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) {
    if (file.endsWith('_admin_mfa_readiness_security.sql'))
      previous = (await db.query(`SELECT p.oid::regprocedure::text signature,p.prosrc,p.proconfig,p.proacl::text acl
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','app_private') AND p.prosrc LIKE '%public.paper_ready(%'`)).rows;
    await db.exec(await readFile(new URL(file, root), 'utf8'));
  }
  assert.ok(previous.length >= 9);
  for (const before of previous) {
    const after = (await db.query('SELECT prosrc,proconfig,proacl::text acl FROM pg_proc WHERE oid=$1::regprocedure', [before.signature])).rows[0];
    assert.deepEqual(after.proconfig, before.proconfig, before.signature);
    assert.equal(after.acl, before.acl, before.signature);
    assert.ok(!after.prosrc.includes('public.paper_ready('));
  }
  assert.deepEqual(await scalar("SELECT proconfig v FROM pg_proc WHERE oid='public.paper_ready(public.papers)'::regprocedure"), ['search_path=""']);
  await db.exec(`INSERT INTO auth.users VALUES('${owner}','crazyslime@gmail.com',now(),'{}'),
    ('${reader}','reader@example.test',now(),'{"aal":"aal2","role":"admin"}');
    INSERT INTO public.papers(id,pmid,title,pub_date) SELECT n,n::text,'Synthetic study '||n,CURRENT_DATE FROM generate_series(1,1000) n;
    INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES('00000000-0000-0000-0000-000000000009','Fixture',repeat('b',64));
    INSERT INTO app_private.local_fulltext_sources(paper_id,worker_id,title,content_hash,summary_source_hash,characters,section_count)
      SELECT id,'00000000-0000-0000-0000-000000000009',title,repeat('a',64),repeat('a',64),3000,3 FROM public.papers WHERE id<=10;
    UPDATE public.papers SET fulltext_available=true,fulltext_storage='z8',summary_basis='fulltext',summary_source_hash=repeat('a',64),summary_model='fixture',summarized_at=now(),summary_ko=E'one\ntwo\nthree' WHERE id<=10;
    ANALYZE public.papers;`);
  // The fixed helper and expanded card predicate agree for true, false and NULL.
  for (const patch of ["summary_ko=E'one\ntwo\nthree'", "summary_ko=NULL", "summary_ko=''", "summary_ko=E'one\ntwo'", "summary_ko=E' one\ntwo\nthree '", "summary_model=''", "summary_model=NULL", "fulltext_available=false"]) {
    await db.exec('BEGIN');
    await db.exec(`UPDATE public.papers SET ${patch} WHERE id=1`);
    const result = (await db.query(`SELECT public.paper_ready(p) expected,public.reader_card(p)->'summary_ready' actual FROM public.papers p WHERE id=1`)).rows[0];
    assert.equal(result.actual, result.expected, patch);
    await db.exec('ROLLBACK');
  }
  // The expanded expression remains eligible for the pre-existing partial index.
  await db.exec('SET enable_seqscan=off');
  const plan = JSON.stringify((await db.query(`EXPLAIN (FORMAT JSON) SELECT p.id FROM public.papers p
    WHERE p.pub_date>='2000-01-01' AND p.fulltext_available AND p.summary_basis='fulltext'
    AND p.summary_source_hash IS NOT NULL AND p.summarized_at IS NOT NULL AND coalesce(p.summary_model,'')<>''
    AND pg_catalog.array_length(pg_catalog.string_to_array(pg_catalog.btrim(p.summary_ko),pg_catalog.chr(10)),1)=3
    AND NOT p.summary_review_required AND p.integrity_status<>'retracted' AND p.paper_type NOT IN ('letter','editorial','comment','erratum')
    ORDER BY p.pub_date DESC,p.id DESC LIMIT 5`)).rows);
  assert.match(plan, /papers_daily_ready_candidates/);
  await db.exec('RESET enable_seqscan');
  for (const claims of [{}, {aal:'aal1'}, {aal:'aal1',user_metadata:{aal:'aal2',role:'admin'}}]) {
    await login(owner, claims);
    for (const sql of ['SELECT public.admin_security_status()', 'SELECT public.admin_memberships()',
      `SELECT public.admin_set_original_access('${reader}',true,0)`, `SELECT public.admin_review_membership('${reader}','approved',0)`])
      await assert.rejects(db.query(sql), {code:'42501'});
    await db.query('SELECT public.reader_daily()');
  }
  await login(owner, {aal:'aal2'});
  assert.deepEqual(await scalar('SELECT public.admin_security_status() v'), {verified:true});
  await db.query('SELECT public.admin_memberships()');
  await assert.rejects(db.query('SELECT app_private.require_admin()'), {code:'42501'});
  await login(reader, {aal:'aal2'});
  await assert.rejects(db.query('SELECT public.admin_security_status()'), {code:'42501'});
  await db.exec('RESET ROLE');
  await db.exec(`UPDATE auth.mfa_factors SET status='unverified' WHERE user_id='${owner}'`);
  await login(owner, {aal:'aal2'});
  await assert.rejects(db.query('SELECT public.admin_security_status()'), {code:'42501'});
  await db.exec('RESET ROLE; SET ROLE anon');
  await assert.rejects(db.query('SELECT public.admin_security_status()'), {code:'42501'});
  console.log('Admin security: server MFA, metadata spoofing, stale assurance, role denial, reader continuity, readiness parity and index eligibility passed.');
} finally { await db.close(); }
