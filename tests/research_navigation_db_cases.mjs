import assert from 'node:assert/strict';
export async function researchNavigationCases(db, {publish, scalar, source, hash}) {
 const owner='00000000-0000-0000-0000-000000000002', guest='00000000-0000-0000-0000-000000008888';
 const rejects=async(fn,expected)=>{await db.exec('SAVEPOINT rejected_call');await assert.rejects(fn,expected);await db.exec('ROLLBACK TO SAVEPOINT rejected_call;RELEASE SAVEPOINT rejected_call');};
 const get=f=>scalar('SELECT public.knowledge_network($1) v',[f]);
 const login=async id=>{await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('SET ROLE authenticated');};
 await db.exec(`RESET ROLE;BEGIN;
 INSERT INTO auth.users VALUES('${guest}','scope-fixture@example.test',now(),'{}');
 INSERT INTO public.papers(id,pmid,title,pub_date) VALUES(8888,'888888','Not indexed yet','2025-01-01');
 INSERT INTO public.collections(id,user_id,name) VALUES(8000,'${owner}','Scoped research'),(8001,'${guest}','Private research');
 INSERT INTO public.collection_papers(collection_id,paper_id) VALUES(8000,8001),(8000,8888),(8001,8003);
 INSERT INTO public.review_reports(id,project_id,paper_id,bibliography,identity_key,updated_by) VALUES
 ('30000000-0000-0000-0000-000000000001',8000,8002,'{}','linked','${owner}'),
 ('30000000-0000-0000-0000-000000000002',8000,null,'{}','unlinked','${owner}');
 INSERT INTO public.reader_states(user_id,paper_id,saved,note) VALUES('${owner}',8001,true,'priority cohort'),('${guest}',8003,true,'priority cohort');
 INSERT INTO public.feedbacks(user_id,paper_id,action) VALUES('${owner}',8002,'like');
 INSERT INTO public.collection_members(collection_id,user_id,role,accepted) VALUES(8000,'${guest}','reader',false);
 SET ROLE authenticated;`);
 let d=await get({project:8000});
 assert.equal(d.context.project_name,'Scoped research');assert.equal(d.context.scope_papers,3);
 assert.equal(d.context.unlinked_project_records,1);assert.equal(d.matched_documents,2);
 assert.deepEqual(d.papers.map(p=>p.pmid).sort(),['800001','800002']);
 assert.equal((await get({library:'saved'})).matched_documents,1);
 assert.equal((await get({library:'liked'})).papers[0].pmid,'800002');
 assert.equal((await get({library:'all'})).matched_documents,2);
 assert.equal((await get({library:'notes',scope_q:'PRIORITY'})).papers[0].pmid,'800001');
 assert.equal((await get({library:'notes',scope_q:'no match'})).matched_documents,0);
 await rejects(()=>get({project:8001}),{code:'42501'});
 await rejects(()=>get({project:8000,library:'all'}),{code:'22023'});
 await rejects(()=>get({library:'all',user_id:guest}),{code:'22023'});
 await login(guest);await rejects(()=>get({project:8000}),{code:'42501'});
 assert.equal((await get({library:'saved'})).papers[0].pmid,'800003');
 await db.exec(`RESET ROLE;UPDATE public.collection_members SET accepted=true WHERE collection_id=8000;SET ROLE authenticated;`);
 assert.equal((await get({project:8000})).matched_documents,2);
 await db.exec(`RESET ROLE;UPDATE public.profiles SET access_status='pending' WHERE id='${guest}';SET ROLE authenticated;`);
 await rejects(()=>get({project:8000}),{code:'42501'});await rejects(()=>get({}),{code:'42501'});
 await login(owner);
 // Topic and pair scopes use actual per-paper memberships; years follow selection.
 const unique='f'.repeat(24);
 await publish('source',{...source,pmid:'800002',title:'Citation fixture 2',concepts:[...source.concepts,{id:unique,label:'Unique research topic',label_ko:'Unique research topic',kind:'condition',aliases:[]}]},'9'.repeat(64));
 d=await get({project:8000,focus:unique});assert.equal(d.selected_documents,1);assert.equal(d.years.reduce((s,y)=>s+Number(y.papers),0),1);
 const pair=await get({project:8000,relation:'citations',scope_concept:source.concepts[0].id,scope_peer:unique});
 assert.equal(pair.matched_documents,1);assert.equal(pair.context.topic_peer_label,'Unique research topic');
 assert.equal(pair.papers[0].pmid,'800002');
 // 75 identifiers exceed a map budget. Every one remains reachable and selectable.
 await publish('bibliography',{version:'corpus-v1',pmid:'800001',title:'Citation fixture 1',content_hash:hash,source:'PubMed',fetched_at:new Date().toISOString(),references:Array.from({length:75},(_,i)=>({source_id:'r'+i,pmid:String(910000+i),doi:null}))},'8'.repeat(64));
 const scope={relation:'citations',project:8000,focus:'800001',direction:'references',limit:10};
 d=await get(scope);assert.equal(d.citation_paper_count,75);assert(d.nodes.length<=10);
 const ids=[];for(let page=0;page<4;page++) { const result=await get({...scope,citation_page:page});ids.push(...result.citation_papers.map(p=>p.id));assert.deepEqual(result.nodes,d.nodes); }
 assert.equal(new Set(ids).size,75);assert.equal((await get({...scope,direction:'cited-by'})).citation_paper_count,1);
 const offMap=ids.find(id=>!d.nodes.some(n=>n.id===id));assert(offMap);
 assert((await get({...scope,focus:offMap})).nodes.some(n=>n.id===offMap));
 const seed=await get({relation:'citations',project:8000,focus:'888888'});
 assert.equal(seed.citation_selection[0].label,'Not indexed yet');assert.equal(seed.citation_selection[0].indexed,false);
 assert.equal(seed.citation_paper_count,0);assert.equal(seed.selected_documents,0);
 assert.equal(await scalar("SELECT has_function_privilege('authenticated','public.research_navigation_contract()','EXECUTE') v"),false);
 await db.exec('SET ROLE anon');await rejects(()=>get({}),{code:'42501'});
 await db.exec('RESET ROLE;ROLLBACK;SET ROLE authenticated');
 console.log('Research navigation DB passed: project ACL, private library, topic pairs, selected years, unindexed seed and complete paginated connections.');
}
