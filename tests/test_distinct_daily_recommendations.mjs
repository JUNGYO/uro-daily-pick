import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const owner='00000000-0000-0000-0000-000000000001', peer='00000000-0000-0000-0000-000000000002';
const worker='00000000-0000-0000-0000-000000000009';
const scalar=async(sql,params=[]) => (await db.query(sql,params)).rows[0]?.r;
const ids=async()=> (await scalar('SELECT public.reader_daily() r')).map(p=>p.id).sort((a,b)=>a-b);
const publish=async(picks)=>db.query(`SELECT public.replace_daily_recommendations($1,CURRENT_DATE,$2)`,[owner,JSON.stringify(picks.map(id=>({paper_id:id,score:10,reasons:{personalization_enabled:false}})))]);
const asUser=async(id)=>{await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('SET ROLE authenticated');};
try {
 await db.exec(`SET TIME ZONE 'Asia/Seoul';
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 await db.exec(`INSERT INTO auth.users VALUES('${owner}','reader@example.test',now(),'{}'),('${peer}','peer@example.test',now(),'{}');
 UPDATE public.profiles SET keywords=ARRAY['prostate'],preferred_journals=ARRAY['Urology'];
 INSERT INTO public.papers(id,pmid,title,journal,pub_date) SELECT n,n::text,'Prostate study '||n,'Urology',CURRENT_DATE-20 FROM generate_series(1,14) n;
 INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES('${worker}','Fixture',repeat('b',64));
 INSERT INTO app_private.local_fulltext_sources(paper_id,worker_id,title,content_hash,summary_source_hash,characters,section_count)
 SELECT id,'${worker}',title,repeat('a',64),repeat('a',64),3000,3 FROM public.papers;
 UPDATE public.papers SET fulltext_available=true,fulltext_storage='z8',summary_basis='fulltext',summary_source_hash=repeat('a',64),summary_model='fixture',summarized_at=now(),summary_ko=E'one\ntwo\nthree';
 INSERT INTO public.recommendations(user_id,paper_id,score,rec_date,reasons) VALUES
 ('${owner}',1,9,CURRENT_DATE-1,'{}'),('${owner}',2,9,CURRENT_DATE-100,'{}'),('${peer}',3,9,CURRENT_DATE-1,'{}');`);

 // Unread history counts; another reader's recommendation does not exclude a paper.
 await publish([1,2,3]);
 assert.deepEqual((await db.query(`SELECT paper_id FROM public.recommendations WHERE user_id=$1 AND rec_date=CURRENT_DATE`,[owner])).rows.map(r=>r.paper_id),[3]);
 await db.exec(`UPDATE public.recommendations SET is_read=true WHERE user_id='${owner}' AND rec_date=CURRENT_DATE`);
 await publish([4,5,6,7,8]);
 const published=await scalar(`SELECT jsonb_agg(paper_id ORDER BY paper_id) r FROM public.recommendations WHERE user_id=$1 AND rec_date=CURRENT_DATE`,[owner]);
 assert.deepEqual(published,[3,4,5,6,7]);
 assert.equal(await scalar(`SELECT is_read r FROM public.recommendations WHERE user_id=$1 AND paper_id=3 AND rec_date=CURRENT_DATE`,[owner]),true);
 await publish([9,10,11,12,13]);
 assert.deepEqual(await scalar(`SELECT jsonb_agg(paper_id ORDER BY paper_id) r FROM public.recommendations WHERE user_id=$1 AND rec_date=CURRENT_DATE`,[owner]),published,'Same-day refresh cannot erase already displayed picks');
 await asUser(owner);
 assert.deepEqual(await ids(),published);
 assert.equal((await scalar('SELECT public.reader_daily(CURRENT_DATE-1) r'))[0].id,1,'Previous-day archive remains readable');
 await assert.rejects(publish([10]),{code:'42501'});
 await db.exec('RESET ROLE');

 // A stale generator's duplicate cache is hidden by the reader as well.
 await db.exec(`DELETE FROM public.recommendations WHERE user_id='${owner}' AND rec_date=CURRENT_DATE;
 INSERT INTO public.recommendations(user_id,paper_id,score,rec_date,reasons) VALUES('${owner}',1,99,CURRENT_DATE,'{}');`);
 await asUser(owner);
 const fallback=await ids();
 assert.equal(fallback.length,5);assert.ok(!fallback.includes(1)&&!fallback.includes(2));
 await db.exec('RESET ROLE');
 const recorded=await scalar(`SELECT jsonb_agg(paper_id ORDER BY paper_id) r FROM public.recommendations WHERE user_id=$1 AND rec_date=CURRENT_DATE AND paper_id<>1`,[owner]);
 assert.deepEqual(recorded,fallback,'Every on-screen fallback is durably recorded before response');
 const beforeArchive=await scalar('SELECT count(*)::int r FROM public.recommendations');
 await asUser(owner);await scalar('SELECT public.reader_daily(CURRENT_DATE-1) r');await db.exec('RESET ROLE');
 assert.equal(await scalar('SELECT count(*)::int r FROM public.recommendations'),beforeArchive,'Historical browsing is read-only');

 // Move the simulated displayed day into history; unread cards cannot fill the next day.
 await db.exec(`DELETE FROM public.recommendations WHERE user_id='${owner}' AND rec_date=CURRENT_DATE AND paper_id=1;
 UPDATE public.recommendations SET rec_date=CURRENT_DATE-1 WHERE user_id='${owner}' AND rec_date=CURRENT_DATE;
 UPDATE public.profiles SET personalization_enabled=false WHERE id='${owner}';`);
 await asUser(owner);
 const next=await ids();
 assert.equal(next.length,5);assert.ok(next.every(id=>!fallback.includes(id)&&![1,2].includes(id)),'Opt-out does not disable repetition prevention');
 await db.exec('RESET ROLE');
 await db.exec(`UPDATE public.recommendations SET rec_date=CURRENT_DATE-1 WHERE user_id='${owner}' AND rec_date=CURRENT_DATE;`);
 await asUser(owner);
 const remaining=await ids();
 assert.equal(remaining.length,2,'Exhaustion returns fewer fresh papers instead of recycling old picks');
 assert.ok(remaining.every(id=>!fallback.includes(id)&&!next.includes(id)&&![1,2].includes(id)));
 await assert.rejects(db.query('SELECT public.reader_daily(CURRENT_DATE+1)'),{code:'22023'});
 await db.exec('RESET ROLE');
 await db.exec('SET ROLE anon');
 await assert.rejects(db.query('SELECT public.reader_daily()'),{code:'42501'});
 console.log('Distinct daily recommendations: unread history, opt-out, per-reader isolation, persistent fallback, same-day replay, archive preservation and exhaustion passed.');
} finally {await db.close();}
