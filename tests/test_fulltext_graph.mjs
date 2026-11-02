import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { approvedReaderFixture } from './approved_reader_fixture.mjs';

const db = new PGlite();
const owner = '00000000-0000-0000-0000-000000000002';
const guest = '00000000-0000-0000-0000-000000000003';
const id = n => n.toString(16).padStart(24, '0');
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].v;
const graph = filters => scalar('SELECT public.knowledge_concept_map($1) v', [{ graph: true, ...filters }]);
const citations = filters => scalar('SELECT public.knowledge_network($1) v', [{ relation: 'citations', ...filters }]);
const login = async user => {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec('SET ROLE authenticated');
};

try {
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
    ${approvedReaderFixture}
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec((await readFile(new URL(file, migrations), 'utf8')).replace(/^\uFEFF/, ''));
  }
  await db.exec(`INSERT INTO auth.users VALUES
    ('${owner}','graph-owner@example.test',now(),'{}'),('${guest}','graph-guest@example.test',now(),'{}');
    INSERT INTO public.papers(id,pmid,title,journal,pub_date,study_type,mesh_terms)
    SELECT i,(910000+i)::text,'Graph paper '||i,'Graph fixture',
      CASE WHEN i=3 THEN DATE '2025-01-01' ELSE DATE '2026-01-01' END,'rct','["Prostatic Neoplasms"]'
      FROM generate_series(1,155) i;
    INSERT INTO app_private.knowledge_documents(paper_id,content_hash,revision,version)
      SELECT i,repeat('a',64),repeat('b',64),'corpus-v1' FROM generate_series(1,154) i;
    INSERT INTO app_private.knowledge_concepts(id,label,label_ko,kind)
      SELECT lpad(to_hex(i),24,'0'),'Actual concept '||i,'Actual concept '||i,'condition' FROM generate_series(1,152) i;
    INSERT INTO app_private.knowledge_term_resolutions(concept_id,entity_id,label,category,status,concept_ui,descriptor_ids,vocabulary_year,checksum,matched_label)
      SELECT id,CASE WHEN id='${id(152)}' THEN '${id(1)}' ELSE id END,
        CASE WHEN id='${id(152)}' THEN 'Actual concept 1' ELSE label END,
        'condition','exact','M'||right(id,6),'[]','2026',repeat('c',64),label FROM app_private.knowledge_concepts;
    INSERT INTO app_private.knowledge_memberships(concept_id,paper_id)
      SELECT lpad(to_hex(i),24,'0'),i FROM generate_series(1,150) i;
    INSERT INTO app_private.knowledge_memberships VALUES
      ('${id(1)}',3),('${id(2)}',1),('${id(152)}',1),('${id(151)}',152);
    INSERT INTO public.collections(id,user_id,name) VALUES(1,'${owner}','Owner graph'),(2,'${guest}','Private graph');
    INSERT INTO public.collection_papers(collection_id,paper_id) VALUES(1,1),(1,150),(1,155),(2,2);
    INSERT INTO public.reader_states(user_id,paper_id,saved,note)
      VALUES('${owner}',3,true,'longitudinal cohort'),('${guest}',2,true,'private note');
    INSERT INTO public.collection_members(collection_id,user_id,role,accepted) VALUES(1,'${guest}','reader',false);`);
  await login(owner);
  assert.equal(await scalar("SELECT has_function_privilege('authenticated','public.research_navigation_contract()','EXECUTE') v"),false);
  assert.equal(await scalar("SELECT has_function_privilege('anon','public.research_navigation_contract()','EXECUTE') v"),false);
  assert.equal(await scalar("SELECT has_function_privilege('service_role','public.research_navigation_contract()','EXECUTE') v"),true);
  await db.exec('RESET ROLE;SET ROLE service_role');
  assert.equal(await scalar('SELECT public.research_navigation_contract() v'),2,'Deployment rejects the older category-only RPC contract');
  await login(owner);
  const whole = await graph({});
  assert.equal(whole.indexed_documents,154);
  assert.equal(whole.nodes.length,151,'Every original-bound canonical entity is present, including rare isolated concepts');
  assert(whole.nodes.every(n => n.node_type === 'concept'));
  assert.equal(whole.map.grouping,'full_graph');
  assert.equal(whole.map.complete,true);
  assert.equal(whole.map.represented_concepts,151);
  assert.equal(whole.coverage.documents_without_concepts,3);
  assert.deepEqual(whole.nodes.find(n => n.id === id(1)).paper_ids,[1,3]);
  assert.deepEqual(whole.nodes.find(n => n.id === id(2)).paper_ids,[1,2]);
  assert.deepEqual(whole.nodes.find(n => n.id === id(151)).paper_ids,[152]);
  assert.equal(whole.nodes.find(n => n.id === id(1)).document_count,2,'Aliases do not count a paper twice');
  assert.equal(whole.edges.length,2);
  assert(whole.edges.every(e => e.weight === 1));
  assert.deepEqual((await graph({min_shared:20})).edges,whole.edges,'Rendering threshold does not change the clustering graph');

  const group = await graph({group_entities:[id(1),id(2),id(1)]});
  assert.equal(group.selected_documents,3,'Group paper count is a union, not the sum of member counts');
  assert.equal(group.years.reduce((sum,y) => sum+y.papers,0),3);
  assert.deepEqual(group.papers.map(p => p.pmid).sort(),['910001','910002','910003']);
  assert.deepEqual(group.nodes,whole.nodes,'Group selection does not perturb node memberships');
  assert.deepEqual(group.edges,whole.edges,'Group selection does not perturb clustering edges');
  const scopedCitations=await citations({scope_entities:[id(1),id(2)]});
  assert.equal(scopedCitations.matched_documents,3);
  assert.equal(scopedCitations.years.reduce((sum,y) => sum+y.papers,0),3);
  assert.deepEqual(scopedCitations.papers.map(p=>p.pmid).sort(),group.papers.map(p=>p.pmid).sort());
  assert.equal((await graph({group_entities:[]})).selected_documents,0);
  assert.equal((await graph({group_entities:[]})).nodes.length,151);
  assert.equal((await citations({scope_entities:[]})).matched_documents,0);
  assert.equal((await graph({group_entities:[id(9999)]})).selected_documents,0,'Unknown client IDs never introduce papers');
  assert.equal((await graph({group_entities:[id(1)],focus:id(2)})).selected_documents,1);
  assert.equal((await graph({from:2026,to:2026,group_entities:[id(1),id(2)]})).selected_documents,2);
  assert.equal((await graph({q:'910003',group_entities:[id(1)]})).selected_documents,1);
  assert.equal((await graph({q:'910155'})).indexed_documents,154);
  assert.equal((await graph({q:'910155'})).matched_documents,0,'Metadata-only catalog papers do not enter this map');

  const project=await graph({project:1,group_entities:[id(1),id(2)]});
  assert.equal(project.context.scope_papers,3);
  assert.equal(project.selected_documents,1);
  assert.deepEqual(project.nodes.find(n=>n.id===id(1)).paper_ids,[1]);
  assert.equal((await citations({project:1,scope_entities:[id(1),id(2)]})).matched_documents,1);
  const library=await graph({library:'notes',scope_q:'longitudinal',group_entities:[id(1),id(2)]});
  assert.equal(library.selected_documents,1);
  assert.deepEqual(library.nodes.find(n=>n.id===id(1)).paper_ids,[3]);
  await assert.rejects(()=>graph({project:2,group_entities:[id(2)]}),{code:'42501'});
  await assert.rejects(()=>citations({project:2,scope_entities:[id(2)]}),{code:'42501'});
  for(const bad of [null,{},'bad',[null],[1],['bad'],Array(50001).fill(id(1))]) {
    await assert.rejects(()=>graph({group_entities:bad}),{code:'22023'});
    await assert.rejects(()=>citations({scope_entities:bad}),{code:'22023'});
  }
  for(const bad of [null,'true',1,[]]) await assert.rejects(()=>graph({graph:bad}),{code:'22023'});
  await assert.rejects(()=>graph({category:'condition'}),{code:'22023'});
  await assert.rejects(()=>citations({scope_entities:[id(1)],scope_category:'condition'}),{code:'22023'});
  await assert.rejects(()=>scalar("SELECT app_private.knowledge_concept_map_core('{\"graph\":true}') v"),{code:'42501'});
  await login(guest);
  await assert.rejects(()=>graph({project:1}),{code:'42501'});
  await db.exec(`RESET ROLE;UPDATE public.collection_members SET accepted=true WHERE collection_id=1;SET ROLE authenticated;`);
  assert.equal((await graph({project:1,group_entities:[id(1)]})).selected_documents,1);
  await db.exec(`RESET ROLE;UPDATE public.profiles SET access_status='pending' WHERE id='${guest}';SET ROLE authenticated;`);
  await assert.rejects(()=>graph({}),{code:'42501'});
  await assert.rejects(()=>citations({scope_entities:[id(1)]}),{code:'42501'});
  await db.exec('SET ROLE anon');
  await assert.rejects(()=>graph({}),{code:'42501'});
  console.log('Full-text graph DB passed: complete nodes/edges, alias-safe group unions, stable graph, exact citation/timeline scopes, metadata exclusion and authorization.');
} finally {await db.close();}
