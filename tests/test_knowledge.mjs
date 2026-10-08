import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const reader='00000000-0000-0000-0000-000000000002',worker='10000000-0000-0000-0000-000000000001',token='x'.repeat(48);
const cid='a'.repeat(24),cid2='b'.repeat(24),hash='a'.repeat(64),revision='b'.repeat(64);
const scalar=async(q,p=[]) => (await db.query(q,p)).rows[0].v;
const publish=(kind,payload,rev=revision)=>scalar('SELECT public.publish_knowledge($1,$2,$3,$4,$5) v',[worker,token,kind,rev,payload]);
const concept={id:cid,label:'prostate cancer',label_ko:'전립선암',kind:'condition',aliases:[]};
const source={pmid:'12345',title:'Original',content_hash:hash,version:'corpus-v1',concepts:[concept,{...concept,id:cid2,label:'active surveillance',label_ko:'적극적 감시',kind:'intervention'}]};
const page={id:cid,version:'corpus-v1',paragraphs:[{text:'가상 검증용 지식 문장입니다.',sources:[{pmid:'12345',content_hash:hash,locations:['p-0000000']}]}]};
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 const root=new URL('../supabase/migrations/',import.meta.url);
 for(const f of (await readdir(root)).filter(x=>x.endsWith('.sql')).sort()) await db.exec((await readFile(new URL(f,root),'utf8')).replace(/^\uFEFF/,''));
 await db.exec(`INSERT INTO auth.users VALUES('${reader}','reader@example.test',now(),'{}');
 INSERT INTO public.papers(id,pmid,title,pub_date,fulltext_available) VALUES(1,'12345','Original','2024-01-01',true);
 INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES('${worker}','Fixture',encode(sha256(convert_to('${token}','UTF8')),'hex'));
 INSERT INTO app_private.local_fulltext_sources(paper_id,worker_id,title,content_hash,summary_source_hash,characters,section_count)
 VALUES(1,'${worker}','Original','${hash}','${hash}',10000,3);`);
 await assert.rejects(()=>db.query('SELECT public.publish_knowledge($1,$2,$3,$4,$5)',[worker,'bad','source',revision,source]),{code:'42501'});
 await db.exec('SET ROLE anon');
 await assert.rejects(()=>scalar('SELECT public.knowledge_search() v'),{code:'42501'});
 await assert.rejects(()=>publish('source',{...source,content_text:'raw original'}));
 assert.deepEqual(await publish('source',source),{id:'12345',revision});
 await publish('source',source);await publish('page',page);
 await publish('network',{version:'corpus-v1',scope_concepts:2,source_documents:1,groups:[{id:cid,label:'전립선암',concepts:[cid,cid2]}]});
 await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[reader]);await db.exec('SET ROLE authenticated');
 const search=await scalar('SELECT public.knowledge_search() v');assert.equal(search.indexed_documents,1);assert.equal(search.items[0].document_count,1);
 assert.equal((await scalar('SELECT public.knowledge_search($1) v',['전립선'])).items.length,1);
 const detail=await scalar('SELECT public.knowledge_page($1) v',[cid]);assert.equal(detail.wiki.status,'ready');assert.equal(detail.papers.length,1);assert.equal(detail.neighbors[0].shared_papers,1);
 assert.equal((await scalar('SELECT public.knowledge_graph() v')).edges[0].weight,1);
 assert.equal((await scalar('SELECT public.knowledge_graph() v')).groups[0].concepts.length,2);
 await assert.rejects(()=>db.query('SELECT * FROM app_private.knowledge_documents'),{code:'42501'});
 await assert.rejects(()=>publish('page',{...page,paragraphs:[{...page.paragraphs[0],sources:[{pmid:'12345',content_hash:'f'.repeat(64),locations:['p-0000000']}]}]}));
 await assert.rejects(()=>publish('page',{...page,paragraphs:[{...page.paragraphs[0],sources:[{pmid:'12345',content_hash:hash,locations:['p-9999999']}]}]}));
 await db.exec("RESET ROLE;UPDATE public.papers SET integrity_status='retracted' WHERE id=1;SET ROLE authenticated");
 assert.equal((await scalar('SELECT public.knowledge_search() v')).items.length,0);
 assert.equal(await scalar('SELECT public.knowledge_page($1) v',[cid]),null);
 await assert.rejects(()=>publish('source',source));
 await db.exec("RESET ROLE;UPDATE public.papers SET integrity_status='current' WHERE id=1;SET ROLE authenticated");
 await publish('source',source);
 assert.equal((await scalar('SELECT public.knowledge_page($1) v',[cid])).wiki.status,'updating');
 assert.deepEqual((await scalar('SELECT public.knowledge_page($1) v',[cid])).wiki.paragraphs,[]);
 await publish('page',page);
 await db.exec("RESET ROLE;UPDATE app_private.local_fulltext_sources SET content_hash=repeat('c',64) WHERE paper_id=1;SET ROLE authenticated");
 assert.equal((await scalar('SELECT public.knowledge_search() v')).indexed_documents,0);
 await assert.rejects(()=>publish('page',page));
 await db.exec('RESET ROLE');
 for(const table of ['knowledge_documents','knowledge_concepts','knowledge_memberships','knowledge_pages','knowledge_dependencies']) {
  assert.equal(await scalar(`SELECT relrowsecurity v FROM pg_class WHERE oid='app_private.${table}'::regclass`),true);
  assert.equal(await scalar(`SELECT has_table_privilege('authenticated','app_private.${table}','SELECT') v`),false);
 }
 console.log('Knowledge DB passed: publication authentication, metadata-only schema, source identity, idempotency, search/graph, RLS, retractions and source invalidation.');
} catch(error) {console.error(error.message,error.code,error.where||error.stack);process.exitCode=1;} finally {await db.close();}
