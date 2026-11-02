import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import {approvedReaderFixture} from './approved_reader_fixture.mjs';
const db=new PGlite();
const owner='00000000-0000-0000-0000-000000000002',guest='00000000-0000-0000-0000-000000000003';
const scalar=async(q,p=[]) => (await db.query(q,p)).rows[0].v;
const get=f=>scalar('SELECT public.knowledge_concept_map($1) v',[f]);
const citations=f=>scalar('SELECT public.knowledge_network($1) v',[{relation:'citations',...f}]);
const id=n=>n.toString(16).padStart(24,'0');
const login=async user=>{await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('SET ROLE authenticated');};
const started=performance.now();
const checkpoint=label=>console.log(`${label}: ${((performance.now()-started)/1000).toFixed(1)}s`);
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 ${approvedReaderFixture}
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 const migrations=new URL('../supabase/migrations/',import.meta.url);
 for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort()) await db.exec((await readFile(new URL(file,migrations),'utf8')).replace(/^\uFEFF/,''));
 await db.exec(`INSERT INTO auth.users VALUES('${owner}','map-owner@example.test',now(),'{}'),('${guest}','map-guest@example.test',now(),'{}');
 INSERT INTO public.papers(id,pmid,title,journal,pub_date,study_type)
 SELECT i,(900000+i)::text,'Map paper '||i,'Map fixture',CASE WHEN i<=80 THEN '2026-01-01'::date ELSE '2025-01-01'::date END,'RCT' FROM generate_series(1,127) i;
 INSERT INTO app_private.knowledge_documents(paper_id,content_hash,revision,version) SELECT i,repeat('a',64),repeat('b',64),'corpus-v1' FROM generate_series(1,126) i;
 INSERT INTO app_private.knowledge_concepts(id,label,label_ko,kind)
 SELECT lpad(to_hex(i),24,'0'),'Concept '||lpad(i::text,3,'0'),'Concept '||i,'condition' FROM generate_series(1,125) i;
 INSERT INTO app_private.knowledge_term_resolutions(concept_id,entity_id,label,category,status,concept_ui,descriptor_ids,vocabulary_year,checksum,matched_label)
 SELECT id,id,label,CASE WHEN id<='${id(110)}' THEN 'condition' ELSE 'technique' END,'exact','M'||right(id,6),'[]','2026',repeat('c',64),label FROM app_private.knowledge_concepts;
 INSERT INTO app_private.knowledge_memberships(concept_id,paper_id) SELECT lpad(to_hex(i),24,'0'),i FROM generate_series(1,125) i;
 INSERT INTO app_private.knowledge_memberships VALUES('${id(2)}',1),('${id(111)}',1),('${id(112)}',1),('${id(1)}',3);
 INSERT INTO app_private.knowledge_concepts VALUES('${id(126)}','Synonym for first concept','Alias','condition','[]',0);
 INSERT INTO app_private.knowledge_term_resolutions SELECT '${id(126)}','${id(1)}','Concept 001','condition','exact','M000001','[]','2026',repeat('c',64),'Synonym for first concept',now();
 INSERT INTO app_private.knowledge_memberships VALUES('${id(126)}',1);
 INSERT INTO public.collections(id,user_id,name) VALUES(1,'${owner}','Owner scope'),(2,'${guest}','Private scope');
 INSERT INTO public.collection_papers(collection_id,paper_id) VALUES(1,1),(1,127),(2,125);
 INSERT INTO public.reader_states(user_id,paper_id,saved,note) VALUES('${owner}',1,true,'cohort'),('${guest}',125,true,'other');
 INSERT INTO public.collection_members(collection_id,user_id,role,accepted) VALUES(1,'${guest}','reader',false);`);
 await login(owner);
 checkpoint('Concept map migrations and small fixture');
 let d=await get({});
 assert.equal(d.indexed_documents,126);assert.equal(d.matched_documents,126);
 assert.equal(d.map.complete,true);assert.equal(d.map.scope_concepts,125);assert.equal(d.map.represented_concepts,125);
 assert.equal(d.coverage.documents_without_concepts,1);
 assert.equal(d.nodes.length,2);assert(d.nodes.every(n=>n.node_type==='group'));
 assert.equal(d.nodes.reduce((s,n)=>s+n.concept_count,0),125,'No top100 selection: rare and isolated entities represented');
 assert.equal(d.nodes.find(n=>n.kind==='condition').document_count,110);
 assert.equal(d.nodes.find(n=>n.kind==='technique').document_count,16);
 assert.equal(d.edges.length,1);assert.equal(d.edges[0].weight,1,'One shared paper, regardless of aliases or multiple concepts per group');
 assert.equal(d.coverage.node_limit,null);assert.equal(d.coverage.edge_limit,null);
 const threshold=await get({min_shared:2});assert.equal(threshold.edges.length,0);assert.equal(threshold.map.represented_concepts,125);
 d=await get({category:'condition'});
 assert.equal(d.map.grouping,'alphabetical_range');assert.equal(d.map.branch_concepts,110);
 assert.equal(d.nodes.reduce((s,n)=>s+n.concept_count,0),110);assert.equal(d.selected_documents,110);
 assert.deepEqual(d.nodes.map(n=>n.drill.prefix).sort(),['0','1']);
 const branches=[];
 for(const node of d.nodes) {
  const branch=await get(node.drill);branches.push(...branch.nodes.map(n=>n.id));
  assert(branch.nodes.every(n=>n.node_type==='concept'));assert.equal(branch.map.grouping,'concepts');
  assert.equal(branch.map.breadcrumbs.length,2);
  assert.equal(branch.years.reduce((s,y)=>s+y.papers,0),branch.selected_documents);
  const c=await citations({scope_category:node.drill.category,scope_prefix:node.drill.prefix});
  assert.equal(c.matched_documents,branch.selected_documents,'Citation source scope is exactly the same range');
  assert.deepEqual(c.papers.map(p=>p.pmid),branch.papers.map(p=>p.pmid));
 }
 assert.equal(new Set(branches).size,110);
 const selectedRange=await get({category:'condition',prefix:'0',focus:id(1)});
 assert.equal(selectedRange.selected_documents,2,'Selecting a focus does not move alphabetical range boundaries');
 assert(selectedRange.nodes.some(n=>n.id===id(1)));
 assert.equal((await citations({scope_category:'condition',scope_prefix:'0',scope_concept:id(1)})).matched_documents,2);
 const rare=await get({category:'technique'});assert(rare.nodes.some(n=>n.id===id(125)));
 assert.equal(rare.nodes.find(n=>n.id===id(125)).document_count,1);
 d=await get({focus:id(1),peer:id(2)});
 assert.equal(d.selection.document_count,2);assert.equal(d.selection_peer.document_count,2);
 assert.equal(d.selection_documents,1);assert.equal(d.selected_documents,1);
 assert(d.nodes.some(n=>n.id===id(1)&&n.pinned));assert(d.nodes.some(n=>n.id===id(2)&&n.pinned));
 assert(d.nodes.every(n=>n.node_type==='concept'),'Small complete scopes show original concept nodes directly');
 d=await get({focus:id(1),peer:id(2),category:'technique'});
 assert.equal(d.selected_documents,1);assert.equal(d.selection_documents,1);
 assert.deepEqual(d.nodes.filter(n=>n.pinned).map(n=>n.id).sort(),[id(1),id(2)]);
 assert.equal(d.nodes.reduce((s,n)=>s+n.concept_count,0),4,'Pinned nodes do not double count group concepts');
 assert.equal((await citations({scope_concept:id(1),scope_peer:id(2),scope_category:'technique'})).matched_documents,1);
 assert.equal((await get({from:2026,to:2026})).selected_documents,80);
 assert.equal((await get({journal:'none'})).matched_documents,0);
 assert.equal((await get({design:'Meta-analysis'})).matched_documents,0);
 assert.equal((await get({q:'900125'})).nodes[0].id,id(125));
 assert.equal((await get({scope_concept:id(1),scope_peer:id(2)})).matched_documents,1);
 d=await get({project:1});assert.equal(d.context.scope_papers,2);assert.equal(d.matched_documents,1);
 assert.equal((await get({library:'saved'})).selected_documents,1);
 assert.equal((await get({library:'notes',scope_q:'cohort'})).selected_documents,1);
 assert.equal((await get({library:'notes',scope_q:'not mine'})).selected_documents,0);
 await assert.rejects(()=>get({project:2}),{code:'42501'});
 for(const filters of [{project:1,library:'all'},{category:'unknown'},{prefix:'1'},{category:'condition',prefix:'80'}, {page:-1},{unlinked_page:-1},{focus:'bad'},{peer:id(1)}, {limit:100},{q:'a'.repeat(201)},{foo:1},{from:2027,to:2026}]) await assert.rejects(()=>get(filters),{code:'22023'});
 await assert.rejects(()=>citations({scope_category:'unknown'}),{code:'22023'});
 await assert.rejects(()=>scalar("SELECT app_private.knowledge_concept_map_core('{}') v"),{code:'42501'});
 await login(guest);await assert.rejects(()=>get({project:1}),{code:'42501'});
 await db.exec(`RESET ROLE;UPDATE public.collection_members SET accepted=true WHERE collection_id=1;SET ROLE authenticated;`);
 assert.equal((await get({project:1})).selected_documents,1);
 assert.equal((await get({library:'saved'})).papers[0].pmid,'900125');
 await db.exec(`RESET ROLE;UPDATE public.profiles SET access_status='pending' WHERE id='${guest}';SET ROLE authenticated;`);
 await assert.rejects(()=>get({}),{code:'42501'});
 await db.exec('SET ROLE anon');await assert.rejects(()=>get({}),{code:'42501'});
 await login(owner);
 checkpoint('Concept map small scope, citation and ACL checks');
 // Deep range hierarchy stays bounded and keeps every entity, including rare isolated ones.
 await db.exec(`RESET ROLE;
 INSERT INTO public.papers(id,pmid,title,journal,pub_date)
 SELECT 10000+i,(990000+i)::text,'Large paper '||i,'Large fixture','2025-01-01' FROM generate_series(1,6501) i;
 INSERT INTO app_private.knowledge_documents(paper_id,content_hash,revision,version) SELECT 10000+i,repeat('a',64),repeat('b',64),'corpus-v1' FROM generate_series(1,6501) i;
 INSERT INTO app_private.knowledge_concepts(id,label,label_ko,kind) SELECT lpad(to_hex(10000+i),24,'0'),'Same label', 'Same label','condition' FROM generate_series(1,6501) i;
 INSERT INTO app_private.knowledge_document_terms(paper_id,concept_id,content_hash,entity_id,label,category,resolution,concept_ui,descriptor_ids,vocabulary_year,checksum)
 SELECT 10000+i,lpad(to_hex(10000+i),24,'0'),repeat('a',64),lpad(to_hex(10000+i),24,'0'),'Same label','unclassified','unresolved',null,'[]','2026',repeat('c',64) FROM generate_series(1,6501) i;
 INSERT INTO app_private.knowledge_memberships(concept_id,paper_id) SELECT lpad(to_hex(10000+i),24,'0'),10000+i FROM generate_series(1,6501) i;
 ANALYZE; SET ROLE authenticated;`);
 checkpoint('Concept map large fixture seeded');
 d=await get({journal:'Large fixture'});assert.equal(d.map.scope_concepts,6501);assert.equal(d.nodes[0].concept_count,6501);
 checkpoint('Concept map large overview');
 const large=await get({journal:'Large fixture',category:'unclassified'});
 checkpoint('Concept map large category');
 assert.equal(large.nodes.length,2);assert.equal(large.nodes.reduce((s,n)=>s+n.concept_count,0),6501);
 const nested=await get({journal:'Large fixture',...large.nodes.find(n=>n.concept_count===6400).drill});
 checkpoint('Concept map large nested range');
 assert.equal(nested.nodes.length,80);assert.equal(nested.nodes.reduce((s,n)=>s+n.concept_count,0),6400);
 const leaf=await get({journal:'Large fixture',...nested.nodes[0].drill});
 assert.equal(leaf.nodes.length,80);assert(leaf.nodes.every(n=>n.node_type==='concept'));assert.equal(leaf.map.breadcrumbs.length,3);
 assert.equal(leaf.coverage.links_at_threshold,0,'Isolated entities remain visible');
 // A small complete scope can legitimately have more than the old 500 links.
 await db.exec(`RESET ROLE;BEGIN;
 INSERT INTO app_private.knowledge_memberships(concept_id,paper_id)
 SELECT lpad(to_hex(10000+i),24,'0'),10001 FROM generate_series(2,80) i;
 INSERT INTO app_private.knowledge_document_terms(paper_id,concept_id,content_hash,entity_id,label,category,resolution,concept_ui,descriptor_ids,vocabulary_year,checksum)
 SELECT 10001,concept_id,content_hash,entity_id,label,category,resolution,concept_ui,descriptor_ids,vocabulary_year,checksum
 FROM app_private.knowledge_document_terms WHERE paper_id BETWEEN 10002 AND 10080;
 SET ROLE authenticated;`);
 const dense=await get({journal:'Large fixture',q:'990001'});
 assert.equal(dense.nodes.length,80);assert.equal(dense.edges.length,3160);
 assert.equal(dense.coverage.links_at_threshold,3160);
 assert(dense.edges.every(e=>e.weight===1),'Every distinct shared-paper pair survives without the old 500-edge cut');
 await db.exec('RESET ROLE;ROLLBACK;SET ROLE authenticated;');
 checkpoint('Concept map large hierarchy complete');
 console.log('Concept map DB passed: complete 125/6501 entities, deep alphabetical ranges, distinct-paper edges, aliases, rare/isolated concepts, pinned pair marginals, aligned citation/timeline scopes, project/library ACL and pending/anon denial.');
} finally {await db.close();}
