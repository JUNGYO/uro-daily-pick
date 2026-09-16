import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';

const db=new PGlite();
const owner='00000000-0000-0000-0000-000000000001', reader='00000000-0000-0000-0000-000000000002';
async function asUser(id){await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('SET ROLE authenticated');}
async function scalar(sql,params=[]){return (await db.query(sql,params)).rows[0].r;}
try {
 await db.exec(`SET TIME ZONE 'Asia/Seoul';
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 const migrations=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
 for(const file of migrations.filter(f=>!f.startsWith('025_')))
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 await db.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.profiles,public.papers,public.collections,public.collection_papers,public.feedbacks,public.recommendations TO authenticated;
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
 INSERT INTO auth.users VALUES('${owner}','owner@example.test',now(),'{}'),('${reader}','reader@example.test',now(),'{}');
 INSERT INTO public.papers(id,pmid,title,pub_date,keywords,mesh_terms,study_type,structured_data,publication_types)
 SELECT n,(10000+n)::text,'Project paper '||n,'2026-01-01','["prostate cancer"]','["Prostatic Neoplasms"]','imaging','{"study_design":"Retrospective cohort"}','["Journal Article"]' FROM generate_series(1,61) n;
 INSERT INTO public.reader_states(user_id,paper_id,saved,reading_state,updated_at) VALUES('${owner}',1,true,'read','2020-01-01');
 INSERT INTO public.collections(id,user_id,name) VALUES(10,'${owner}','My project'),(20,'${reader}','Private project');
 INSERT INTO public.collection_papers(collection_id,paper_id) SELECT 10,n FROM generate_series(1,60) n;
 INSERT INTO public.collection_papers(collection_id,paper_id) VALUES(20,61);
 UPDATE public.research_reference_entries SET note='another readers secret note' WHERE collection_id=20;
 INSERT INTO public.recommendations(user_id,paper_id,score,rec_date,reasons) VALUES('${owner}',1,1,CURRENT_DATE,'{}'),('${reader}',2,1,CURRENT_DATE,'{}');`);
 await db.exec(await readFile(new URL('../supabase/migrations/025_reading_network.sql',import.meta.url),'utf8'));
 await asUser(owner);
 let state=await scalar('SELECT to_jsonb(s) r FROM public.reader_states s WHERE paper_id=1');
 assert.equal(state.read_at,null);assert.equal(state.saved_at,null,'Historical action times must remain unknown');
 state=await scalar(`SELECT public.update_reader_state(1,'{"note":"An edit today","position":0.8}') r`);
 assert.equal(state.read_at,null);assert.equal(state.saved_at,null,'Note/scroll updates do not invent old dates');
 await db.query(`SELECT public.update_reader_state(1,'{"reading_state":"unread","saved":false}')`);
 state=await scalar(`SELECT public.update_reader_state(1,'{"reading_state":"read","saved":true}') r`);
 assert.ok(Date.now()-Date.parse(state.read_at)<60000);assert.ok(state.saved_at);
 const stamp=state.read_at,saved=state.saved_at;
 await db.query(`UPDATE public.reader_states SET read_at='1900-01-01',saved_at='1900-01-01',note='More notes' WHERE paper_id=1`);
 state=await scalar('SELECT to_jsonb(s) r FROM public.reader_states s WHERE paper_id=1');
 assert.equal(state.read_at,stamp);assert.equal(state.saved_at,saved,'Client dates cannot rewrite server action times');
 state=await scalar(`SELECT public.update_reader_state(1,'{"reading_state":"reading","saved":false}') r`);
 assert.equal(state.read_at,null);assert.equal(state.saved_at,null);
 await db.query(`SELECT public.update_reader_state(2,'{"reading_state":"read","saved":true}')`);
 assert.ok(await scalar('SELECT read_at IS NOT NULL AND saved_at IS NOT NULL r FROM public.reader_states WHERE paper_id=2'));

 await db.exec('RESET ROLE');
 await db.query(`INSERT INTO public.recommendations(user_id,paper_id,score,rec_date,reasons) VALUES($1,1,1,CURRENT_DATE-2,'{}')`,[owner]);
 await asUser(owner);
 await db.query('UPDATE public.profiles SET personalization_enabled=false WHERE id=$1',[owner]);
 assert.equal(await scalar('SELECT count(*)::int r FROM public.recommendations WHERE rec_date>=CURRENT_DATE'),0,'Own current cache invalidated immediately');
 assert.equal(await scalar('SELECT count(*)::int r FROM public.recommendations WHERE rec_date<CURRENT_DATE'),1,'Historical recommendation archive is preserved');
 await db.exec('RESET ROLE');
 assert.equal(await scalar('SELECT count(*)::int r FROM public.recommendations WHERE user_id=$1',[reader]),1,'Other cache is preserved');
 await db.exec(`INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES('00000000-0000-0000-0000-000000000009','Fixture',repeat('b',64));
 INSERT INTO app_private.local_fulltext_sources(paper_id,worker_id,title,content_hash,summary_source_hash,characters,section_count)
 VALUES(3,'00000000-0000-0000-0000-000000000009','Project paper 3',repeat('c',64),repeat('a',64),3000,3);
 UPDATE public.papers SET fulltext_available=true,fulltext_storage='z8',summary_basis='fulltext',summary_source_hash=repeat('a',64),summary_model='fixture',summarized_at=now(),summary_ko=E'one\ntwo\nthree' WHERE id=3;
 INSERT INTO public.recommendations(user_id,paper_id,score,rec_date,reasons) VALUES('${owner}',3,1,CURRENT_DATE,'{"personalization_enabled":true}');`);
 await asUser(owner);
 assert.equal((await scalar('SELECT public.reader_daily(CURRENT_DATE) r')).length,0,'Late stale personalized cache is ignored');
 await db.exec('RESET ROLE');await db.exec(`UPDATE public.recommendations SET reasons='{"personalization_enabled":false}' WHERE user_id='${owner}'`);
 await asUser(owner);assert.equal((await scalar('SELECT public.reader_daily(CURRENT_DATE) r')).length,1);
 await db.exec('RESET ROLE');
 await db.query(`SELECT public.replace_daily_recommendations($1,CURRENT_DATE,'[{"paper_id":3,"score":9,"reasons":{"personalization_enabled":true}}]')`,[owner]);
 assert.equal(await scalar('SELECT score r FROM public.recommendations WHERE user_id=$1 AND rec_date=CURRENT_DATE',[owner]),1,'Stale personalized publication cannot overwrite a valid opt-out result');
 await db.query(`SELECT public.replace_daily_recommendations($1,CURRENT_DATE,'[{"paper_id":3,"score":2,"reasons":{"personalization_enabled":false}}]')`,[owner]);
 assert.equal(await scalar('SELECT score r FROM public.recommendations WHERE user_id=$1 AND rec_date=CURRENT_DATE',[owner]),2,'Explicit content-only publication succeeds');
 await db.query(`INSERT INTO public.recommendations(user_id,paper_id,score,rec_date,reasons) VALUES($1,3,1,CURRENT_DATE-2,'{"personalization_enabled":true}')`,[owner]);
 await asUser(owner);
 assert.equal((await scalar('SELECT public.reader_daily(CURRENT_DATE-2) r')).length,1,'Existing historical picks remain readable after opt-out');
 await assert.rejects(db.query(`SELECT public.replace_daily_recommendations($1,CURRENT_DATE,'[]')`,[owner]),/permission denied/);

 const ref=await scalar('SELECT id r FROM public.research_reference_entries WHERE collection_id=10 AND paper_id=1');
 await db.query(`SELECT public.save_research_topic(10,NULL,0,'introduction','Population question','User authored topic',ARRAY[$1]::bigint[],'[]')`,[ref]);
 const graph=await scalar('SELECT public.research_graph(10) r');
 assert.equal(graph.total,60);assert.equal(graph.references.length,50);assert.equal(graph.truncated,true);
 assert.equal(graph.references[0].id,ref,'A linked older reference must not disappear behind newer papers');
 assert.equal(graph.topics.length,1);assert.deepEqual(graph.topics[0].reference_ids,[ref]);
 assert.equal(graph.references[0].paper.study_type,'imaging');
 assert.equal(graph.references[0].paper.study_design,'Retrospective cohort');
 assert.equal(graph.references[0].paper.fulltext_available,false);
 assert.equal('abstract' in graph.references[0].paper,false,'Graph does not ship abstracts or body text');
 assert.equal(JSON.stringify(graph).includes('another readers secret note'),false);
 const filtered=await scalar(`SELECT public.research_graph(10,'10001',5) r`);
 assert.equal(filtered.total,1);assert.equal(filtered.references[0].paper.pmid,'10001');
 const table=await scalar(`SELECT public.research_references(10,'10001',0) r`);
 assert.equal(table.items[0].id,filtered.references[0].id);assert.deepEqual(table.items[0].paper.keywords,['prostate cancer']);
 await assert.rejects(db.query(`SELECT public.research_graph(10,'',51)`),/Invalid graph scope/);
 await assert.rejects(db.query(`SELECT public.research_graph(20)`),/Project access required/);
 await asUser(reader);await assert.rejects(db.query(`SELECT public.research_graph(10)`),/Project access required/);
 assert.equal(await scalar('SELECT count(*)::int r FROM public.reader_states'),0,'Reader action times remain private');
 await asUser(owner);await db.query(`SELECT public.project_members(10,'reader@example.test','reader')`);
 await asUser(reader);await assert.rejects(db.query('SELECT public.research_graph(10)'),/Project access required/);
 await db.query('SELECT public.project_invitations(10)');
 assert.equal((await scalar('SELECT public.research_graph(10) r')).references.length,50,'Accepted shared reader may view graph');
 await assert.rejects(db.query(`SELECT public.save_research_topic(10,NULL,0,'discussion','Forbidden','',ARRAY[]::bigint[],'[]')`),/editor/i);
 await db.exec('RESET ROLE;SET ROLE anon');await assert.rejects(db.query('SELECT public.research_graph(10)'),/permission denied/);
 console.log('PASS: reading transition timestamps, opt-out cache races, bounded graph metadata, project sharing and account isolation');
} finally {await db.close();}
