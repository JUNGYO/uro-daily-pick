// Isolated PostgreSQL regression: no production requests, documents or user data.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';

const db=new PGlite();
const admin='00000000-0000-0000-0000-000000000001';
const reader='00000000-0000-0000-0000-000000000002';
const unconfirmed='00000000-0000-0000-0000-000000000003';
const functions=['admin_stats','admin_daily_activity','admin_journal_dist'];
const scalar=async(sql,params=[])=> (await db.query(sql,params)).rows[0].r;
const call=name=>scalar(`SELECT public.${name}() r`);
async function asUser(role,id='') {
  await db.exec(`RESET ROLE;SET ROLE ${role}`);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);
}
async function denied(operation) {
  await db.exec('SAVEPOINT expected_denial');
  await assert.rejects(operation,{code:'42501'});
  await db.exec('ROLLBACK TO SAVEPOINT expected_denial;RELEASE SAVEPOINT expected_denial');
}
try {
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())
    await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));

  // Keep now() fixed for exact seven-day comparisons and use a non-Korean session zone.
  await db.exec(`BEGIN;SET TIME ZONE 'America/New_York';
    INSERT INTO auth.users VALUES
      ('${admin}','crazyslime@gmail.com',now(),'{}'),
      ('${reader}','reader@example.test',now(),'{}'),
      ('${unconfirmed}','crazyslime@gmail.com',NULL,'{}');
    INSERT INTO public.papers(id,pmid,title,pub_date,journal,fetched_at) VALUES
      (1,'1','Start boundary','1999-12-31','Journal A',((now() AT TIME ZONE 'Asia/Seoul')::date-29)::timestamp AT TIME ZONE 'Asia/Seoul'),
      (2,'2','Before boundary',NULL,'Journal A',(((now() AT TIME ZONE 'Asia/Seoul')::date-29)::timestamp AT TIME ZONE 'Asia/Seoul')-interval '1 second'),
      (3,'3','End boundary','2026-01-01','Journal A',(((now() AT TIME ZONE 'Asia/Seoul')::date+1)::timestamp AT TIME ZONE 'Asia/Seoul')-interval '1 second'),
      (4,'4','After boundary','2026-01-01','Journal B',((now() AT TIME ZONE 'Asia/Seoul')::date+1)::timestamp AT TIME ZONE 'Asia/Seoul'),
      (5,'5','Exact week boundary','2000-01-01','Journal B',now()-interval '7 days'),
      (6,'6','Inside week boundary','2000-01-01',NULL,now()-interval '7 days'+interval '1 second'),
      (7,'7','Fetched today','2000-01-01','',now()),
      (8,'8','Unknown fetch time','2000-01-01','Journal A',NULL);
    INSERT INTO public.feedbacks(user_id,paper_id,action,created_at) VALUES
      ('${reader}',1,'like',(SELECT fetched_at FROM public.papers WHERE id=1)),
      ('${reader}',2,'like',(SELECT fetched_at FROM public.papers WHERE id=2)),
      ('${admin}',3,'dislike',(SELECT fetched_at FROM public.papers WHERE id=3)),
      ('${reader}',4,'save',(SELECT fetched_at FROM public.papers WHERE id=3)),
      ('${admin}',5,'like',(SELECT fetched_at FROM public.papers WHERE id=4));
    INSERT INTO public.read_history(user_id,paper_id,dwell_seconds,clicked_at) VALUES
      ('${reader}',1,10,(SELECT fetched_at FROM public.papers WHERE id=1)),
      ('${reader}',3,20,(SELECT fetched_at FROM public.papers WHERE id=3)),
      ('${admin}',3,0,(SELECT fetched_at FROM public.papers WHERE id=3)),
      ('${reader}',2,-1,(SELECT fetched_at FROM public.papers WHERE id=2)),
      ('${admin}',4,30,(SELECT fetched_at FROM public.papers WHERE id=4));`);
  assert.equal(await scalar('SELECT count(*)::int r FROM app_private.admin_catalog_metrics'),8,
    'The ledger includes undated and pre-2000 papers; these analytics preserve the original full-catalog semantics');
  for(const name of functions) {
    const definition=await scalar(`SELECT pg_get_functiondef('public.${name}()'::regprocedure) r`);
    assert.doesNotMatch(definition,/\bpublic\.papers\b/,'Admin analytics must not scan original paper payloads');
    const contract=(await db.query(`SELECT provolatile,prosecdef FROM pg_proc WHERE oid='public.${name}()'::regprocedure`)).rows[0];
    assert.deepEqual(contract,{provolatile:'s',prosecdef:true});
    assert.equal(await scalar(`SELECT has_function_privilege('anon','public.${name}()','EXECUTE') r`),false);
    assert.equal(await scalar(`SELECT has_function_privilege('authenticated','public.${name}()','EXECUTE') r`),true);
  }
  for(const [role,id] of [['anon',''],['authenticated',reader],['authenticated',unconfirmed],['authenticated','']]) {
    await asUser(role,id);
    for(const name of functions) await denied(()=>call(name));
    await denied(()=>db.query('SELECT * FROM app_private.admin_catalog_metrics'));
  }

  await db.exec('RESET ROLE;UPDATE app_private.admin_catalog_metrics_state SET complete=false WHERE singleton');
  await asUser('authenticated',admin);
  let stats=await call('admin_stats');
  assert.equal(stats.total_papers,null,'A partially initialized ledger cannot be presented as the total');
  assert.equal(stats.papers_7d,null);
  assert.equal(stats.total_users,3);
  assert.equal(stats.total_feedbacks,5,'Unrelated engagement metrics remain available during catalog initialization');
  let daily=await call('admin_daily_activity');
  assert.equal(daily.length,30);
  assert.ok(daily.every(day=>day.new_papers===null));
  assert.equal(daily[0].likes,1);
  assert.equal(daily[29].dislikes,1);
  assert.equal(await call('admin_journal_dist'),null,'An incomplete journal distribution is unavailable, not an empty or partial list');

  await db.exec('RESET ROLE;UPDATE app_private.admin_catalog_metrics_state SET complete=true WHERE singleton');
  await asUser('authenticated',admin);
  stats=await call('admin_stats');
  assert.deepEqual(stats,{
    total_users:3,active_users_7d:2,total_papers:8,papers_7d:4,
    total_feedbacks:5,total_likes:3,total_dislikes:1,total_reads:5,avg_dwell_seconds:20,
  },'Strict seven-day fetch filtering and all engagement fields retain their existing semantics');
  daily=await call('admin_daily_activity');
  const expectedDates=await scalar(`SELECT json_agg((date_trunc('day',now() AT TIME ZONE 'Asia/Seoul')::date-29+i)::text ORDER BY i) r FROM generate_series(0,29) days(i)`);
  assert.deepEqual(daily.map(day=>day.date),expectedDates);
  assert.equal(daily[0].new_papers,1,'The first Korean midnight is included');
  assert.equal(daily[29].new_papers,2,'The last Korean day is included, next midnight is excluded');
  assert.equal(daily.reduce((n,day)=>n+day.new_papers,0),5,'Out-of-window and NULL fetch timestamps are excluded');
  assert.equal(daily[0].active_users,1);
  assert.equal(daily[29].active_users,2,'Repeated activity counts distinct users per Korean day');
  assert.equal(daily.reduce((n,day)=>n+day.likes,0),1,'Before-window and future-window likes are excluded');
  assert.equal(daily.reduce((n,day)=>n+day.dislikes,0),1);
  assert.ok(daily.some(day=>day.active_users===0 && day.likes===0 && day.dislikes===0 && day.new_papers===0));
  const journals=await call('admin_journal_dist');
  assert.deepEqual(journals,[
    {journal:'Journal A',paper_count:4,recent_count:1},
    {journal:'Journal B',paper_count:2,recent_count:1},
    {journal:'',paper_count:1,recent_count:1},
  ],'Unknown journals are excluded, the legacy empty-string group is preserved, and counts use fetched_at');

  // A missing original table is an execution sentinel, stronger than text matching alone.
  // Any fallback to scanning public.papers now fails instead of silently passing small-fixture tests.
  await db.exec('RESET ROLE;ALTER TABLE public.papers RENAME TO fixture_papers_unavailable');
  await asUser('authenticated',admin);
  assert.deepEqual(await call('admin_stats'),stats);
  assert.deepEqual(await call('admin_daily_activity'),daily);
  assert.deepEqual(await call('admin_journal_dist'),journals);
  await db.exec('RESET ROLE;ALTER TABLE public.fixture_papers_unavailable RENAME TO papers');

  await db.exec(`INSERT INTO public.papers(id,pmid,title,journal,fetched_at)
    SELECT 1000+i,(1000+i)::text,'Journal limit fixture','Extra '||i,now() FROM generate_series(1,31) rows(i);`);
  await asUser('authenticated',admin);
  const limited=await call('admin_journal_dist');
  assert.equal(limited.length,30,'The established top-30 journal limit remains bounded');
  assert.equal(limited[0].journal,'Journal A');
  assert.equal(limited[1].journal,'Journal B');
  assert.ok(limited.every((row,i)=>i===0 || limited[i-1].paper_count>=row.paper_count));

  await db.exec('RESET ROLE;DELETE FROM public.papers;COMMIT;BEGIN READ ONLY');
  await asUser('authenticated',admin);
  stats=await call('admin_stats');
  assert.equal(stats.total_papers,0,'A complete but empty catalog is genuinely zero');
  assert.equal(stats.papers_7d,0);
  assert.equal(stats.total_reads,0);
  assert.equal(stats.avg_dwell_seconds,0);
  assert.equal(await call('admin_journal_dist'),null,'The complete empty-catalog result keeps the existing RPC contract');
  assert.ok((await call('admin_daily_activity')).every(day=>day.new_papers===0));
  await db.exec('COMMIT');
  console.log('Admin analytics metrics: administrator authorization, unavailable initialization, exact counts, KST boundaries, engagement preservation, ledger-only reads, journal limit and read-only execution passed.');
} finally {await db.close();}
