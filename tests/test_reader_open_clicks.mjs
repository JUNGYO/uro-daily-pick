// Isolated PostgreSQL; no live accounts or fabricated production reading history.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const ids=Array.from({length:4},(_,i)=>`00000000-0000-0000-0000-00000000000${i+1}`);
const event=i=>`10000000-0000-0000-0000-${String(i).padStart(12,'0')}`;
const scalar=async(sql,p=[]) => (await db.query(sql,p)).rows[0].value;
const engagement=()=>scalar('SELECT public.admin_user_engagement() AS value');
const open=(pmid,kind,id)=>db.query('SELECT public.record_reader_open($1,$2,$3)',[pmid,kind,id]);
async function asUser(role,id='') {
  await db.exec(`RESET ROLE;SET ROLE ${role}`);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);
}
try {
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb,last_sign_in_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated;`);
  const root=new URL('../supabase/migrations/',import.meta.url);
  for(const file of (await readdir(root)).filter(f=>f.endsWith('.sql') && Number(f.slice(0,3))<=6).sort())
    await db.exec((await readFile(new URL(file,root),'utf8')).replace(/^\uFEFF/,''));
  await db.exec(await readFile(new URL('043_admin_login_and_read_times.sql',root),'utf8'));
  await db.exec(await readFile(new URL('20261003055033_reader_visit_metrics.sql',root),'utf8'));
  await db.exec(`INSERT INTO auth.users VALUES
    ('${ids[0]}','crazyslime@gmail.com',now(),'{}',now()),
    ('${ids[1]}','reader@example.test',now(),'{}',NULL),
    ('${ids[2]}','other@example.test',now(),'{}',NULL),
    ('${ids[3]}','crazyslime@gmail.com',NULL,'{}',NULL);
    UPDATE public.profiles SET name='Fixture '||right(id::text,1);
    INSERT INTO public.papers(id,pmid,title) VALUES(1,'1234','One'),(2,'5678','Two');
    INSERT INTO public.read_history(user_id,paper_id,dwell_seconds) VALUES('${ids[1]}',1,20),('${ids[1]}',1,30);
    INSERT INTO public.feedbacks(user_id,paper_id,action) VALUES('${ids[1]}',1,'like');`);
  const fingerprint=()=>scalar(`SELECT md5(concat(
    (SELECT json_agg(u ORDER BY id)::text FROM auth.users u),
    (SELECT json_agg(r ORDER BY id)::text FROM public.read_history r),
    (SELECT json_agg(f ORDER BY id)::text FROM public.feedbacks f))) AS value`);
  const before=await fingerprint();
  const acl=await scalar("SELECT proacl::text AS value FROM pg_proc WHERE oid='public.admin_user_engagement()'::regprocedure");
  await db.exec(await readFile(new URL('20261007085538_reader_open_clicks.sql',root),'utf8'));
  assert.equal(await fingerprint(),before);
  assert.equal(await scalar("SELECT proacl::text AS value FROM pg_proc WHERE oid='public.admin_user_engagement()'::regprocedure"),acl);
  await asUser('authenticated',ids[0]);
  const old=(await engagement()).find(x=>x.name==='Fixture 2');
  assert.equal(old.reads,2);assert.equal(old.read_papers,1);
  assert.equal(old.open_clicks,0);assert.equal(old.opened_papers,0);assert.equal(old.last_opened_at,null);
  for(const [role,id] of [['anon',''],['authenticated',''],['authenticated',event(999)]]) {
    await asUser(role,id);
    await assert.rejects(()=>open('1234','detail',event(1)),{code:'42501'});
  }
  await asUser('authenticated',ids[1]);
  for(const input of [['invalid','detail',event(1)],['9999','detail',event(1)],['1234','bad',event(1)],
    ['1234',null,event(1)],['1234','detail',null]]) await assert.rejects(()=>open(...input),{code:'22023'});
  await assert.rejects(()=>db.query('SELECT * FROM app_private.reader_open_events'),{code:'42501'});
  await assert.rejects(()=>db.query('INSERT INTO app_private.reader_open_events DEFAULT VALUES'),{code:'42501'});
  await open('1234','detail',event(1));
  await open('1234','detail',event(1)); // An identical retry is one action.
  await assert.rejects(()=>open('5678','detail',event(1)),{code:'22023'});
  await assert.rejects(()=>open('1234','original',event(1)),{code:'22023'});
  await open('1234','detail',event(2)); // A deliberate repeat is another action.
  await open('1234','original',event(3));
  await open('5678','publisher',event(4));
  await assert.rejects(engagement,{code:'42501'});
  await asUser('authenticated',ids[2]);
  await open('1234','detail',event(1)); // IDs are scoped to the authenticated caller.
  await asUser('authenticated',ids[3]);await assert.rejects(engagement,{code:'42501'});
  await asUser('authenticated',ids[0]);
  await db.exec('BEGIN READ ONLY');
  const rows=await engagement(),reader=rows.find(x=>x.name==='Fixture 2'),other=rows.find(x=>x.name==='Fixture 3');
  assert.deepEqual([reader.open_clicks,reader.opened_papers,reader.detail_clicks,reader.original_clicks,reader.publisher_clicks],[4,2,2,1,1]);
  assert.deepEqual([other.open_clicks,other.opened_papers],[1,1]);
  assert.deepEqual([reader.reads,reader.read_papers,reader.likes],[2,1,1]);
  assert.equal(reader.last_read_at,old.last_read_at);assert.equal(reader.last_sign_in_at,null);
  assert.equal(reader.last_seen_at,null);assert.ok(reader.last_opened_at);
  await db.exec('COMMIT;RESET ROLE');
  assert.equal(await fingerprint(),before,'Clicks do not alter dwell history, feedback or authentication');
  assert.equal(await scalar('SELECT count(*)::int AS value FROM app_private.reader_open_events'),5);
  assert.equal(await scalar("SELECT relrowsecurity AS value FROM pg_class WHERE oid='app_private.reader_open_events'::regclass"),true);
  const proc=(await db.query("SELECT proconfig,prosecdef FROM pg_proc WHERE oid='public.record_reader_open(text,text,uuid)'::regprocedure")).rows[0];
  assert.deepEqual(proc,{proconfig:['search_path=""'],prosecdef:true});
  assert.equal(await scalar("SELECT has_function_privilege('anon','public.record_reader_open(text,text,uuid)','EXECUTE') AS value"),false);
  assert.equal(await scalar("SELECT has_function_privilege('authenticated','public.record_reader_open(text,text,uuid)','EXECUTE') AS value"),true);
  console.log('Reader opening clicks: explicit source counts, distinct papers, replay identity, caller isolation, validation, admin grants and unchanged historical data passed.');
} finally {await db.close();}
