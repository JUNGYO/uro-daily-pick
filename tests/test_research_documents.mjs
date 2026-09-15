import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';

// All fixtures, roles, queues and original receipts stay in this isolated engine.
const db=new PGlite();
const a='00000000-0000-0000-0000-000000000001';
const b='00000000-0000-0000-0000-000000000002';
const c='00000000-0000-0000-0000-000000000003';
const worker='00000000-0000-0000-0000-000000000009';
const otherWorker='00000000-0000-0000-0000-000000000008';
const token='synthetic-research-token-'.repeat(3);
const sha=s=>createHash('sha256').update(s).digest('hex');
async function user(id){await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('SET ROLE authenticated');}
async function anon(){await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub','',false)");await db.exec('SET ROLE anon');}
async function rpc(name,args={}){
 const entries=Object.entries(args);
 return (await db.query(`SELECT public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) r`,entries.map(([,v])=>Array.isArray(v)||v&&typeof v==='object'?JSON.stringify(v):v))).rows[0].r;
}
// PG array arguments deliberately use explicit SQL; JSON RPC arguments use rpc.
async function saveRef(ref,values,note='',tags=[]){return (await db.query('SELECT public.save_research_reference($1,$2,$3,$4,$5::text[]) r',[ref.id,ref.revision,JSON.stringify(values),note,tags])).rows[0].r;}
async function saveTopic({id=null,revision=0,section='introduction',title='Research rationale',body='User-written synthesis',refs=[],cells=[]}={}){
 return (await db.query('SELECT public.save_research_topic(10,$1,$2,$3,$4,$5,$6::bigint[],$7) r',[id,revision,section,title,body,refs,JSON.stringify(cells)])).rows[0].r;
}
const claim=()=>rpc('claim_research_extractions',{p_worker_id:worker,p_token:token});
const finish=(job,result,request=job.request)=>rpc('finish_research_extraction',{p_worker_id:worker,p_token:token,p_job_id:job.id,p_lease_token:job.lease_token,p_request:request,p_result:result});
const fail=(job,code)=>rpc('fail_research_extraction',{p_worker_id:worker,p_token:token,p_job_id:job.id,p_lease_token:job.lease_token,p_error_code:code});
const columns=[{id:'population',label:'Population',instruction:'Describe eligible patients'},{id:'outcome',label:'Outcome',instruction:'Describe the outcome'}];
try{
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 const files=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
 for(const file of files.filter(f=>f<'023'))await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 await db.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.collections,public.collection_papers,public.papers,public.profiles,public.feedbacks TO authenticated;
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
 INSERT INTO auth.users VALUES('${a}','owner@example.test',now(),'{}'),('${b}','editor@example.test',now(),'{}'),('${c}','outsider@example.test',now(),'{}');
 INSERT INTO public.papers(id,pmid,title,journal,pub_date,doi,authors)
 SELECT n,(10000+n)::text,'Study fixture '||n,'Journal',date '2026-01-01'+n,'10.1000/'||n,'["Author A"]' FROM generate_series(1,30) n;
 INSERT INTO public.collections(id,user_id,name) VALUES(10,'${a}','Research project'),(11,'${c}','Private other project');
 INSERT INTO public.collection_papers(collection_id,paper_id,added_at) SELECT 10,n,now()+n*interval '1 minute' FROM generate_series(1,30) n;
 INSERT INTO public.project_notes(collection_id,paper_id,note,tags,updated_by) VALUES(10,1,'Rare project memo',ARRAY['cohort-tag'],'${a}');
 INSERT INTO public.collection_members(collection_id,user_id,role,accepted) VALUES(10,'${b}','reader',true);
 INSERT INTO public.reader_states(user_id,paper_id,saved,note,tags,reading_state,updated_at)
 SELECT '${a}',n,n>1,CASE WHEN n=1 THEN 'Rare unsaved memo' ELSE '' END,CASE WHEN n=2 THEN ARRAY['OnlyTag'] ELSE '{}'::text[] END,
 CASE WHEN n=3 THEN 'read' WHEN n=4 THEN 'reading' ELSE 'unread' END,now()+n*interval '1 minute' FROM generate_series(1,30) n;
 INSERT INTO public.reader_states(user_id,paper_id,note) VALUES('${c}',2,'Outsider secret');
 INSERT INTO public.feedbacks(user_id,paper_id,action) VALUES('${a}',5,'like');`);
 await db.exec((await readFile(new URL('../supabase/migrations/023_research_documents.sql',import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 console.log('applied migration 023 against an existing project with notes');

 await user(a);
 const library=await rpc('search_library');assert.equal(library.total,30);assert.equal(library.items.length,20);assert.equal(library.items[0].id,30);
 assert.equal((await rpc('search_library',{p_page:1})).items.length,10);
 const memo=await rpc('search_library',{p_query:'UNSAVED MEMO'});assert.equal(memo.total,1);assert.equal(memo.items[0].saved,false);assert.equal(memo.items[0].id,1);
 assert.equal((await rpc('search_library',{p_query:'unsaved memo',p_tab:'saved'})).total,0);
 assert.equal((await rpc('search_library',{p_query:'onlytag'})).items[0].id,2);
 assert.equal((await rpc('search_library',{p_tab:'notes'})).total,2);
 assert.deepEqual((await rpc('search_library',{p_tab:'read'})).items.map(x=>x.id),[3]);
 assert.deepEqual((await rpc('search_library',{p_tab:'reading'})).items.map(x=>x.id),[4]);
 assert.deepEqual((await rpc('search_library',{p_tab:'liked'})).items.map(x=>x.id),[5]);
 assert.equal((await rpc('search_library',{p_query:'Outsider secret'})).total,0);
 assert.equal((await rpc('search_library',{p_query:'%'})).total,0);
 const projectMemo=await rpc('project_papers_v2',{p_id:10,p_query:'rare project'});assert.equal(projectMemo.total,1);assert.equal(projectMemo.items[0].id,1);
 assert.equal((await rpc('project_papers_v2',{p_id:10,p_query:'COHORT-TAG'})).items[0].id,1);
 assert.equal((await rpc('project_papers_v2',{p_id:10,p_page:1})).items.length,10);
 let refs=await rpc('research_references',{p_id:10});assert.equal(refs.total,30);assert.equal(refs.items.length,20);
 let ref=(await rpc('research_references',{p_id:10,p_query:'Rare project memo'})).items[0];assert.equal(ref.paper_id,1);assert.equal(ref.note,'Rare project memo');assert.equal(ref.bibliography.title,'Study fixture 1');
 let w=(await rpc('research_workspace',{p_id:10})).workspace;assert.equal(w.revision,0);
 w=await rpc('save_research_workspace',{p_id:10,p_expected_revision:0,p_question:'Which outcome informs our next study?',p_template:'pico',p_columns:columns});assert.equal(w.revision,1);
 await assert.rejects(rpc('save_research_workspace',{p_id:10,p_expected_revision:0,p_question:'Lost update',p_template:'general',p_columns:columns}),{code:'40001'});
 for(const bad of [[],[columns[0],columns[0]],[{...columns[0],content_text:'forbidden'}],[{id:'Bad id',label:'x',instruction:''}]])
  await assert.rejects(rpc('save_research_workspace',{p_id:10,p_expected_revision:1,p_question:'Q',p_template:'general',p_columns:bad}),{code:'22023'});
 assert.equal((await rpc('research_workspace',{p_id:10})).workspace.revision,1);
 await assert.rejects(db.query("UPDATE public.research_reference_entries SET auto_values='{}' WHERE id=$1",[ref.id]),{code:'42501'});
 await assert.rejects(db.query("INSERT INTO public.research_workspaces(collection_id) VALUES(11)"),{code:'42501'});
 let edited=await saveRef(ref,{population:'Manual population'},'Design choice',['design']);assert.equal(edited.revision,ref.revision+1);
 await assert.rejects(saveRef(ref,{population:'Stale overwrite'}),{code:'40001'});
 assert.equal((await rpc('project_papers_v2',{p_id:10,p_query:'Design choice'})).total,1);
 let topic=await saveTopic({refs:[ref.id],cells:[{reference_id:ref.id,column_id:'population'}]});assert.equal(topic.revision,1);
 const topics=await rpc('research_topics',{p_id:10});assert.equal(topics.items[0].references[0].bibliography.title,'Study fixture 1');
 await assert.rejects(saveTopic({refs:[],cells:[{reference_id:ref.id,column_id:'population'}]}),{code:'22023'});
 await assert.rejects(saveTopic({id:topic.id,revision:0,refs:[ref.id]}),{code:'40001'});

 await user(b);
 assert.equal((await rpc('research_workspace',{p_id:10})).can_edit,false);
 assert.equal((await rpc('research_references',{p_id:10})).total,30);
 await assert.rejects(saveRef(edited,{population:'Reader override'}),{code:'42501'});
 await assert.rejects(rpc('request_research_extraction',{p_id:ref.id}),{code:'42501'});
 await user(c);
 assert.equal((await db.query('SELECT * FROM public.research_reference_entries')).rows.length,0);
 for(const [name,args] of [['research_workspace',{p_id:10}],['research_references',{p_id:10}],['project_papers_v2',{p_id:10}],['research_topics',{p_id:10}],['research_export_snapshot',{p_id:10}]])
  await assert.rejects(rpc(name,args),{code:'42501'});
 assert.equal((await rpc('search_library',{p_query:'Rare unsaved memo'})).total,0);
 await user(a);await rpc('project_members',{p_id:10,p_email:'editor@example.test',p_role:'editor'});
 await user(b);edited=await saveRef(edited,{population:'Collaborator population'},'Collaborative decision',['team']);
 topic=await saveTopic({id:topic.id,revision:topic.revision,section:'discussion',title:'Compare findings',refs:[ref.id],cells:[{reference_id:ref.id,column_id:'population'}]});
 assert.equal(topic.revision,2);
 await user(a);await assert.rejects(saveRef({...edited,revision:edited.revision-1},{population:'Lost owner edit'}),{code:'40001'});
 await assert.rejects(rpc('delete_research_topic',{p_id:topic.id,p_expected_revision:1}),{code:'40001'});
 const snapshot=await rpc('research_export_snapshot',{p_id:10});assert.equal(snapshot.references.length,30);assert.equal(snapshot.topics.length,1);assert.equal(snapshot.workspace.revision,1);
 assert.equal(snapshot.references.find(x=>x.id===ref.id).user_values.population,'Collaborator population');
 assert.match(snapshot.export_fingerprint,/^[0-9a-f]{64}$/);assert.equal(snapshot.revision_manifest.references.length,30);
 assert.equal((await rpc('research_export_snapshot',{p_id:10})).export_fingerprint,snapshot.export_fingerprint);
 const exportArgs={p_id:10,p_export_id:'00000000-0000-0000-0000-000000000101',p_format:'docx',p_workspace_revision:snapshot.workspace.revision,
  p_fingerprint:snapshot.export_fingerprint,p_manifest:snapshot.revision_manifest};
 const exported=await rpc('record_research_export',exportArgs);assert.equal(exported.reference_count,30);assert.equal(exported.topic_count,1);assert.ok(exported.created_at);
 assert.deepEqual(await rpc('record_research_export',exportArgs),exported);
 await assert.rejects(rpc('record_research_export',{...exportArgs,p_format:'csv'}),{code:'23505'});
 await assert.rejects(db.query("UPDATE public.research_document_exports SET fingerprint='x'"),{code:'42501'});
 for(const invalid of [{p_fingerprint:'invalid'},{p_workspace_revision:99},{p_manifest:{...snapshot.revision_manifest,content_text:'No originals in history'}},
  {p_manifest:{references:[{id:ref.id,revision:999}],topics:[]}},{p_manifest:{references:[{id:ref.id,revision:1,note:'No note bodies in manifest'}],topics:[]}},
  {p_manifest:{references:Array(10001).fill({id:ref.id,revision:0}),topics:[]}},
  {p_format:'google_docs',p_url:null},{p_format:'google_docs',p_url:'https://docs.google.com.evil.test/document/d/abcdefghij/edit'},
  {p_format:'google_docs',p_url:'https://docs.google.com/document/d/abcdefghij/edit?secret=true'},{p_url:'https://example.test/doc'}])
  await assert.rejects(rpc('record_research_export',{...exportArgs,...invalid}),{code:'22023'});
 await user(b);assert.equal((await rpc('research_document_exports',{p_id:10})).total,0);assert.equal((await db.query('SELECT * FROM public.research_document_exports')).rows.length,0);
 await assert.rejects(rpc('record_research_export',exportArgs),{code:'23505'});
 await rpc('record_research_export',{...exportArgs,p_export_id:'00000000-0000-0000-0000-000000000102',p_format:'google_docs',p_url:'https://docs.google.com/document/d/abcdefghij/edit'});
 assert.equal((await rpc('research_document_exports',{p_id:10})).total,1);
 await user(c);await assert.rejects(rpc('research_document_exports',{p_id:10}),{code:'42501'});await assert.rejects(rpc('record_research_export',exportArgs),{code:'42501'});
 await user(a);assert.equal((await rpc('research_document_exports',{p_id:10})).total,1);
 for(let i=0;i<20;i++)await rpc('record_research_export',{...exportArgs,p_export_id:'00000000-0000-0000-0000-'+String(200+i).padStart(12,'0'),p_format:'csv'});
 assert.equal((await rpc('research_document_exports',{p_id:10})).items.length,20);assert.equal((await rpc('research_document_exports',{p_id:10,p_page:1})).items.length,1);

 // Collection removal, catalog deletion, and lost collaborator access must not
 // cascade into the durable reference snapshots or linked user prose.
 await db.query('DELETE FROM public.collection_papers WHERE collection_id=10 AND paper_id=1');
 assert.equal((await rpc('research_references',{p_id:10,p_query:'Collaborative decision'})).items[0].id,ref.id);
 await db.exec('RESET ROLE;DELETE FROM public.papers WHERE id=1');
 await user(a);const preserved=(await rpc('research_references',{p_id:10,p_query:'Collaborative decision'})).items[0];
 assert.equal(preserved.paper_id,null);assert.equal(preserved.bibliography.pmid,'10001');assert.equal(preserved.user_values.population,'Collaborator population');
 assert.deepEqual((await rpc('research_topics',{p_id:10})).items[0].cell_links,[{reference_id:ref.id,column_id:'population'}]);
 assert.equal((await rpc('request_research_extraction',{p_id:ref.id})).status,'waiting_source');
 const ref2=await rpc('add_research_reference',{p_id:10,p_paper_id:2});
 assert.equal((await rpc('request_research_extraction',{p_id:ref2.id})).status,'waiting_source');
 await db.exec('RESET ROLE');
 await db.query('INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES($1,$2,$3),($4,$5,$3)',[worker,'Fixture worker',sha(token),otherWorker,'Other fixture']);
 await anon();assert.deepEqual(await claim(),[]);
 await assert.rejects(rpc('claim_research_extractions',{p_worker_id:worker,p_token:'invalid'}),{code:'42501'});
 await assert.rejects(db.query('SELECT * FROM app_private.research_extraction_jobs'),{code:'42501'});
 await assert.rejects(db.query('SELECT * FROM app_private.institution_workers'),{code:'42501'});
 await assert.rejects(rpc('research_export_snapshot',{p_id:10}),{code:'42501'});
 const source={content_hash:sha('fixture body'),summary_source_hash:sha('fixture summary source'),characters:3000,section_count:3,source_url:'https://example.test/article'};
 await rpc('register_institution_original',{p_worker_id:worker,p_token:token,p_pmid:'10002',p_doi:'10.1000/2',p_title:'Study fixture 2',p_source:source});
 assert.deepEqual(await rpc('claim_research_extractions',{p_worker_id:otherWorker,p_token:token}),[]);
 let job=(await claim())[0];assert.equal(job.request.source.content_hash,source.content_hash);assert.equal(job.request.version,1);assert.equal(job.request.reference_id,ref2.id);assert.deepEqual(job.request.columns,columns);
 assert.deepEqual(await claim(),[]);assert.ok(job.lease_token);
 const result={version:1,values:{population:'Adult cohort',outcome:'Not reported'},evidence:{population:['p-0000001'],outcome:[]},model:'fixture.evidence-v1'};
 for(const invalid of [{...result,content_text:'Raw original forbidden'},{...result,version:2},{...result,values:{population:'x'}},
  {...result,evidence:{population:['Body text forbidden'],outcome:[]}},{...result,evidence:{population:['p-0000001'],outcome:[],unknown:[]}},
  {...result,values:{...result.values,population:'x'.repeat(1501)}},{...result,model:''}])
  await assert.rejects(finish(job,invalid),{code:'22023'});
 await assert.rejects(finish(job,result,{...job.request,question:'Changed request'}),{code:'40001'});
 await assert.rejects(rpc('finish_research_extraction',{p_worker_id:otherWorker,p_token:token,p_job_id:job.id,p_lease_token:job.lease_token,p_request:job.request,p_result:result}),{code:'42501'});
 await assert.rejects(rpc('finish_research_extraction',{p_worker_id:worker,p_token:token,p_job_id:job.id,p_lease_token:worker,p_request:job.request,p_result:result}),{code:'42501'});
 await user(a);const manual=await saveRef(ref2,{population:'Human correction',outcome:''},'Research note',['human']);
 await anon();assert.equal(await finish(job,result),true);await assert.rejects(finish(job,result),{code:'42501'});
 await user(a);let completed=(await rpc('research_references',{p_id:10,p_query:'Research note'})).items[0];
 assert.deepEqual(completed.user_values,{population:'Human correction',outcome:''});assert.deepEqual(completed.auto_values,result.values);assert.equal(completed.revision,manual.revision);assert.equal(completed.extraction_status,'complete');
 await db.exec('RESET ROLE');assert.equal((await db.query('SELECT summarized_at FROM public.papers WHERE id=2')).rows[0].summarized_at,null);
 assert.equal((await db.query('SELECT count(*)::int n FROM public.paper_fulltexts')).rows[0].n,0);

 // New configurations invalidate pending extraction leases and auto values are
 // labelled stale; both server and worker enforce the captured request version.
 await user(a);await rpc('request_research_extraction',{p_id:ref2.id});await anon();job=(await claim())[0];
 await user(a);w=await rpc('save_research_workspace',{p_id:10,p_expected_revision:1,p_question:'Revised question',p_template:'pico',p_columns:columns});
 await anon();await assert.rejects(finish(job,result),{code:'42501'});assert.deepEqual(await claim(),[]);
 await user(a);await rpc('request_research_extraction',{p_id:ref2.id});await anon();job=(await claim())[0];
 await rpc('register_institution_original',{p_worker_id:worker,p_token:token,p_pmid:'10002',p_doi:'10.1000/2',p_title:'Study fixture 2',p_source:{...source,content_hash:sha('new body'),summary_source_hash:sha('new summary source')}});
 await assert.rejects(finish(job,result),{code:'42501'});
 job=(await claim())[0];assert.equal(job.request.source.content_hash,sha('new body'));
 await fail(job,'budget_yield');
 await db.exec('RESET ROLE');assert.deepEqual((await db.query('SELECT status,attempts FROM app_private.research_extraction_jobs WHERE id=$1',[job.id])).rows[0],{status:'retry',attempts:0});
 await db.exec("UPDATE app_private.research_extraction_jobs SET retry_at=now()-interval '1 second' WHERE id="+job.id);
 await anon();job=(await claim())[0];
 await fail(job,'retryable_error');
 await db.exec("RESET ROLE;UPDATE app_private.research_extraction_jobs SET retry_at=now()-interval '1 second' WHERE reference_id="+ref2.id);
 await anon();job=(await claim())[0];assert.equal(job.request.source.content_hash,sha('new body'));await fail(job,'source_unavailable');
 await db.exec('RESET ROLE');assert.equal((await db.query('SELECT status,attempts FROM app_private.research_extraction_jobs WHERE id=$1',[job.id])).rows[0].status,'waiting_source');
 await db.exec("UPDATE app_private.research_extraction_jobs SET retry_at=now()-interval '1 second' WHERE id="+job.id);
 await anon();job=(await claim())[0];await fail(job,'invalid_output');
 await db.exec("RESET ROLE;UPDATE app_private.research_extraction_jobs SET retry_at=now()-interval '1 second' WHERE id="+job.id);
 await anon();job=(await claim())[0];await fail(job,'inference_error');
 await db.exec('RESET ROLE');assert.deepEqual((await db.query('SELECT status,attempts FROM app_private.research_extraction_jobs WHERE id=$1',[job.id])).rows[0],{status:'failed',attempts:3});
 await anon();assert.deepEqual(await claim(),[]);
 await user(a);await rpc('request_research_extraction',{p_id:ref2.id});await anon();job=(await claim())[0];
 await db.exec("RESET ROLE;UPDATE app_private.research_extraction_jobs SET lease_until=now()-interval '1 second' WHERE id="+job.id);
 await anon();await assert.rejects(finish(job,result),{code:'42501'});const reclaimed=(await claim())[0];assert.notEqual(reclaimed.lease_token,job.lease_token);await assert.rejects(fail(job,'invalid_output'),{code:'42501'});assert.equal(await finish(reclaimed,result),true);
 await user(a);await rpc('project_members',{p_id:10,p_remove:b});await user(b);assert.equal((await db.query('SELECT * FROM public.research_topic_entries')).rows.length,0);await assert.rejects(rpc('research_export_snapshot',{p_id:10}),{code:'42501'});
 assert.equal((await db.query('SELECT * FROM public.research_document_exports')).rows.length,0);await assert.rejects(rpc('research_document_exports',{p_id:10}),{code:'42501'});
 for(const invalid of [{p_page:-1},{p_page:null},{p_tab:'invalid'},{p_query:'x'.repeat(201)}])await assert.rejects(rpc('search_library',invalid),{code:'22023'});
 console.log('Research documents: full-library/project search, durable refs, collaborative CAS/RLS, snapshot exports, source-bound worker queue, leases/retries, schema guards and preserved human edits passed.');
} finally {await db.close();}
