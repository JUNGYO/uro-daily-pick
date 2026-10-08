import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const admin='00000000-0000-0000-0000-000000000001',reader='00000000-0000-0000-0000-000000000002',other='00000000-0000-0000-0000-000000000003';
const scalar=async(q,p=[]) => (await db.query(q,p)).rows[0].v;
const asUser=async(id)=>{await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('SET ROLE authenticated');};
const observe=(pmid,kind,s,seconds=0,sections=[])=>db.query('SELECT public.record_reader_content($1,$2,$3,$4,$5)',[pmid,kind,s,seconds,sections]);
const usage=(days=7)=>scalar('SELECT public.admin_reader_usage($1) v',[days]);
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 const root=new URL('../supabase/migrations/',import.meta.url);
 for(const f of (await readdir(root)).filter(x=>x.endsWith('.sql')).sort()) await db.exec((await readFile(new URL(f,root),'utf8')).replace(/^\uFEFF/,''));
 await db.exec(`INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data) VALUES
 ('${admin}','crazyslime@gmail.com',now(),'{}'),('${reader}','reader@example.test',now(),'{}'),('${other}','other@example.test',now(),'{}');
 UPDATE public.profiles SET name=CASE id WHEN '${reader}' THEN 'Reader' WHEN '${admin}' THEN 'Admin' ELSE 'Other' END;
 INSERT INTO public.papers(id,pmid,title,fulltext_available,summary_basis,summary_source_hash,summary_model,summarized_at,summary_ko)
 VALUES(1,'1234','One',true,'fulltext',repeat('a',64),'model',now(),E'one\\ntwo\\nthree'),(2,'5678','Two',true,'fulltext',repeat('b',64),'model',now(),E'one\\ntwo\\nthree');
 INSERT INTO public.papers(id,pmid,title) VALUES(3,'9999','Unavailable');
 INSERT INTO public.read_history(user_id,paper_id,dwell_seconds) VALUES('${reader}',1,120);
 GRANT SELECT ON public.papers,public.collections,public.collection_papers TO authenticated;
 GRANT INSERT ON public.collections,public.collection_papers TO authenticated; GRANT SELECT,INSERT,UPDATE,DELETE ON public.feedbacks TO authenticated; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
 UPDATE app_private.reader_usage_policy SET started_at=now()-interval '10 days';`);
 await asUser(admin);assert.equal((await usage()).viewing_users,0,'No invented views from historical dwell');
 await assert.rejects(()=>usage(5),{code:'22023'});
 await asUser(reader);await assert.rejects(usage,{code:'42501'});
 for(const [p,k,s,t,z] of [['9999','original',randomUUID(),0,[]],['1234','bad',randomUUID(),0,[]],['1234','summary',null,0,[]],['1234','summary',randomUUID(),-1,[]],['1234','summary',randomUUID(),0,[20]]])
  await assert.rejects(()=>observe(p,k,s,t,z),{code:'22023'});
 const s=randomUUID();await observe('1234','summary',s);
 await assert.rejects(()=>observe('5678','summary',s),{code:'22023'});
 await assert.rejects(()=>observe('1234','summary',s,600,[0]),{code:'22023'});
 await db.exec("RESET ROLE;UPDATE app_private.reader_content_sessions SET started_at=now()-interval '2 minutes'");
 await asUser(reader);await observe('1234','summary',s,30,[0,0,1]);await observe('1234','summary',s,15,[0]);
 await observe('1234','summary',randomUUID()); // Reload does not increase unique paper count.
 const orig=randomUUID();await observe('1234','original',orig);
 await db.exec("RESET ROLE;UPDATE app_private.reader_content_sessions SET started_at=now()-interval '2 minutes'");
 await asUser(reader);await observe('1234','original',orig,59,[5]);
 await db.query("SELECT public.update_reader_state(1,'{\"saved\":true,\"note\":\"private content not in analytics\"}')");
 await db.query("SELECT public.update_reader_state(1,'{\"saved\":true,\"position\":0.8}')"); // Same save + automatic position: no extra actions.
 await db.query("SELECT public.reader_opinion(1,'like')");await db.query("SELECT public.reader_opinion(1,'like')");
 await db.exec(`INSERT INTO public.collections(id,user_id,name) VALUES(10,'${reader}','Project');INSERT INTO public.collection_papers(collection_id,paper_id) VALUES(10,1)`);
 const report=await scalar('SELECT id v FROM public.review_reports WHERE project_id=10');
 const ref=await scalar('SELECT id v FROM public.research_reference_entries WHERE collection_id=10 AND paper_id=1');
 await db.query("SELECT public.save_research_reference($1,0,'{}','private project note','{}')",[ref]);
 await db.query("SELECT public.save_research_reference($1,1,'{\"design\":\"Cohort\"}','private project note','{}')",[ref]);
 await assert.rejects(()=>db.query("SELECT public.save_research_reference($1,0,'{}','rejected note','{}')",[ref]),{code:'40001'});
 const topic=await scalar("SELECT public.save_research_topic(10,NULL,0,'introduction','Background','Private draft',ARRAY[$1]::bigint[]) v",[ref]);
 await db.query("SELECT public.save_research_topic(10,$1,1,'introduction','Background','Private draft',ARRAY[$2]::bigint[])",[topic.id,ref]);
 // Automatic extraction is not a human edit, even when a caller is authenticated.
 await db.exec("RESET ROLE;UPDATE public.research_reference_entries SET auto_values='{\"design\":\"Automated\"}' WHERE collection_id=10");
 await asUser(reader);
 await db.query(`SELECT public.review_save_report(10,$1,1,'{"ta_decision":"exclude","ft_decision":"pending","acquisition":"unknown","exclusion_reason":"Wrong population","source":{},"note":""}')`,[report]);
 const exp=randomUUID();await db.query('SELECT public.record_reference_export($1,$2)',[[1],exp]);await db.query('SELECT public.record_reference_export($1,$2)',[[1],exp]);
 await assert.rejects(()=>db.query('SELECT * FROM app_private.reader_usage_actions'),{code:'42501'});
 await asUser(other);await assert.rejects(()=>db.query('SELECT public.record_reference_export($1,$2)',[[1],exp]),{code:'22023'});
 await observe('5678','original',randomUUID());
 await asUser(admin);let data=await usage();let row=data.users.find(x=>x.name==='Reader');
 assert.deepEqual([row.summary_papers,row.original_papers,row.engaged_papers,row.active_seconds],[1,1,1,89]);
 assert.deepEqual([row.saves,row.notes,row.likes,row.project_adds,row.screenings,row.exports,row.extractions,row.writing],[1,2,1,1,1,1,1,1]);
 assert.equal(row.used_after_view,1);assert.equal(data.viewing_users,2);assert.equal(data.usage_users,1);assert.equal(data.engaged_users,1);
 assert.equal(data.daily.length,7);assert.equal(JSON.stringify(data).includes('private content'),false);
 assert.equal((await usage(30)).daily.length,30);
 await db.exec("RESET ROLE;UPDATE app_private.reader_content_sessions SET started_at=now()-interval '8 days' WHERE user_id='"+other+"'");
 await asUser(admin);assert.equal((await usage()).viewing_users,1);assert.equal((await usage(30)).viewing_users,2);
 // A second distinct KST date establishes return use; a second same-day click does not.
 await db.exec(`RESET ROLE;INSERT INTO app_private.reader_usage_actions(user_id,paper_id,kind,created_at) VALUES('${reader}',1,'save',now()-interval '1 day')`);
 await asUser(admin);assert.equal((await usage()).returning_users,1);
 await db.exec('RESET ROLE');
 assert.equal(await scalar('SELECT count(*) v FROM public.read_history'),1);
 for(const name of ['reader_usage_policy','reader_content_sessions','reader_usage_actions']) {
  assert.equal(await scalar(`SELECT relrowsecurity v FROM pg_class WHERE oid='app_private.${name}'::regclass`),true);
  assert.equal(await scalar(`SELECT has_table_privilege('authenticated','app_private.${name}','SELECT') v`),false);
 }
 for(const fn of ['record_reader_content(text,text,uuid,integer,integer[])','record_reference_export(bigint[],uuid)','admin_reader_usage(integer)'])
  assert.equal(await scalar(`SELECT has_function_privilege('anon','public.${fn}','EXECUTE') v`),false);
 assert.equal(await scalar("SELECT has_function_privilege('authenticated','app_private.capture_reader_usage()','EXECUTE') v"),false);
 await db.exec("SELECT set_config('request.jwt.claim.sub','',false);SET ROLE anon");
 await assert.rejects(()=>observe('1234','summary',randomUUID()),{code:'42501'});
 console.log('Usage metrics passed: complete migrations, guarded observations, elapsed bound, idempotency, real saved-action triggers, privacy, KST periods, repeat use and legacy preservation.');
} catch(error) {console.error(error.message, error.code, error.where || error.stack);process.exitCode=1;} finally {await db.close();}
