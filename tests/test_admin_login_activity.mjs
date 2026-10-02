// Isolated PostgreSQL only. No production users or authentication requests.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const ids=Array.from({length:5},(_,i)=>`00000000-0000-0000-0000-00000000000${i+1}`);
const scalar=async(sql,p=[]) => (await db.query(sql,p)).rows[0].value;
const call=()=>scalar('SELECT public.admin_user_engagement() AS value');
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
  const acl=await scalar("SELECT proacl::text AS value FROM pg_proc WHERE oid='public.admin_user_engagement()'::regprocedure");
  await db.exec(await readFile(new URL('043_admin_login_and_read_times.sql',root),'utf8'));
  assert.equal(await scalar("SELECT proacl::text AS value FROM pg_proc WHERE oid='public.admin_user_engagement()'::regprocedure"),acl);
  assert.deepEqual((await db.query("SELECT provolatile,prosecdef,proconfig FROM pg_proc WHERE oid='public.admin_user_engagement()'::regprocedure")).rows[0],
    {provolatile:'s',prosecdef:true,proconfig:['search_path=""']});
  await db.exec(`INSERT INTO auth.users VALUES
    ('${ids[0]}','crazyslime@gmail.com',now(),'{}','2026-10-01T00:00:00Z'),
    ('${ids[1]}','reader@example.test',now(),'{}','2026-10-02T00:25:00Z'),
    ('${ids[2]}','crazyslime@gmail.com',NULL,'{}',NULL),
    ('${ids[3]}','never@example.test',now(),'{}',NULL),
    ('${ids[4]}','legacy@example.test',now(),'{}',NULL);
    UPDATE public.profiles SET name='Fixture '||right(id::text,1);
    INSERT INTO public.papers(id,pmid,title) VALUES(1,'1','Fixture');
    INSERT INTO public.feedbacks(user_id,paper_id,action) VALUES('${ids[1]}',1,'like'),('${ids[0]}',1,'dislike');
    INSERT INTO public.read_history(user_id,paper_id,clicked_at) VALUES
      ('${ids[0]}',1,'2026-10-01T02:00:00Z'),
      ('${ids[1]}',1,'2026-04-26T12:00:00Z'),
      ('${ids[1]}',1,'2026-04-26T11:00:00Z'),
      ('${ids[4]}',1,'2026-09-01T00:00:00Z');`);
  const fingerprint=()=>scalar(`SELECT md5(concat(
    (SELECT json_agg(u ORDER BY id)::text FROM auth.users u),
    (SELECT json_agg(r ORDER BY id)::text FROM public.read_history r),
    (SELECT json_agg(f ORDER BY id)::text FROM public.feedbacks f))) AS value`);
  const before=await fingerprint();
  await db.exec('BEGIN READ ONLY');
  for(const [role,id] of [['anon',''],['authenticated',ids[1]],['authenticated',ids[2]],['authenticated','']]) {
    await asUser(role,id);
    await db.exec('SAVEPOINT denial');
    await assert.rejects(call,{code:'42501'});
    await db.exec('ROLLBACK TO SAVEPOINT denial;RELEASE SAVEPOINT denial');
  }
  await asUser('authenticated',ids[0]);
  const rows=await call();
  assert.equal(rows.length,5);
  assert.equal(rows[0].name,'Fixture 2','A recent login sorts first even with an old reading timestamp');
  assert.equal(Date.parse(rows[0].last_sign_in_at),Date.parse('2026-10-02T00:25:00Z'));
  assert.equal(Date.parse(rows[0].last_read_at),Date.parse('2026-04-26T12:00:00Z'));
  assert.equal(rows[0].last_active,rows[0].last_read_at,'Old clients retain the historical reading field');
  assert.deepEqual([rows[0].likes,rows[0].dislikes,rows[0].reads],[1,0,2]);
  assert.equal(rows.find(r=>r.name==='Fixture 4').last_sign_in_at,null);
  assert.equal(rows.find(r=>r.name==='Fixture 4').last_read_at,null);
  assert.equal(rows.find(r=>r.name==='Fixture 5').last_sign_in_at,null,'Reading must not manufacture a login');
  for(const row of rows) assert.deepEqual(Object.keys(row).sort(),['name','institution','likes','dislikes','reads','last_sign_in_at','last_read_at','last_active'].sort());
  await db.exec('RESET ROLE;COMMIT');
  assert.equal(await fingerprint(),before,'The read-only RPC never alters authentication or engagement history');
  await db.query('UPDATE auth.users SET last_sign_in_at=$1 WHERE id=$2',['2026-10-03T00:00:00Z',ids[3]]);
  await asUser('authenticated',ids[0]);
  const fresh=await call();
  assert.equal(fresh[0].name,'Fixture 4','New login appears without a reading event or backfill');
  assert.equal(fresh[0].reads,0);
  assert.equal(fresh[0].last_read_at,null);
  console.log('Admin login activity: distinct login/read timestamps, current auth values, exact counts, nulls, ordering, read-only execution and unchanged admin-only grants passed.');
} finally {await db.close();}
