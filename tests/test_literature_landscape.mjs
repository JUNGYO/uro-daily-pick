import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import {approvedReaderFixture} from './approved_reader_fixture.mjs';
const db=new PGlite();
const reader='00000000-0000-0000-0000-000000000002';
const scalar=async(q,p=[]) => (await db.query(q,p)).rows[0].v;
const landscape=(f={})=>scalar('SELECT public.knowledge_landscape($1) v',[f]);
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 ${approvedReaderFixture}
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 const root=new URL('../supabase/migrations/',import.meta.url);
 const migration='20261013000215_literature_landscape.sql';
 for(const f of (await readdir(root)).filter(x=>x.endsWith('.sql')&&x!==migration).sort()) await db.exec((await readFile(new URL(f,root),'utf8')).replace(/^\uFEFF/,''));
 await db.exec(`INSERT INTO auth.users VALUES('${reader}','reader@example.test',now(),'{}');
 INSERT INTO public.papers(id,pmid,title,pub_date,journal,mesh_terms,doi)
 SELECT i,(100000+i)::text,'Paper '||i,make_date(2020+i%4,1,1),'Urology',
 CASE WHEN i<=120 THEN '["Humans","Prostatic Neoplasms","prostatic neoplasms"]'::jsonb
 ELSE jsonb_build_array('Topic '||i) END,'10.test/'||i FROM generate_series(1,160)i;
 INSERT INTO public.papers(id,pmid,title,pub_date,mesh_terms) VALUES(161,'100161','Missing metadata',NULL,'["Humans","Male"]');`);
 await db.exec(await readFile(new URL(migration,root),'utf8'));
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[reader]);
 await db.exec('SET ROLE authenticated');assert.deepEqual(await landscape(),{ready:false});
 await assert.rejects(()=>scalar('SELECT app_private.backfill_literature_metadata() v'),{code:'42501'});
 await assert.rejects(()=>scalar('SELECT count(*) v FROM app_private.literature_metadata'),{code:'42501'});
 await db.exec('RESET ROLE');
 let batch=await scalar('SELECT app_private.backfill_literature_metadata(60) v');assert.equal(batch.processed,60);assert.equal(batch.ready,false);
 // An update to an unvisited row, a deletion, and an insertion during initialization.
 await db.exec(`UPDATE public.papers SET journal='Other' WHERE id=160;
 DELETE FROM public.papers WHERE id=159;
 INSERT INTO public.papers(id,pmid,title,pub_date,mesh_terms) VALUES(162,'100162','Inserted during backfill','1998-01-01','["Historical topic"]');`);
 while(!batch.ready) batch=await scalar('SELECT app_private.backfill_literature_metadata(60) v');
 assert.equal((await scalar('SELECT app_private.backfill_literature_metadata(60) v')).processed,0);
 await db.exec('SET ROLE authenticated');
 let result=await landscape();
 assert.equal(result.coverage.catalog_papers,161);assert.equal(result.coverage.matching_papers,161);
 assert.equal(result.coverage.subject_papers,160);assert.equal(result.coverage.unknown_year,1);
 assert.equal(result.subjects.find(t=>t.topic==='prostatic neoplasms').papers,120,'all papers, not 60 graph nodes');
 assert.deepEqual(result.subjects.find(t=>t.topic==='prostatic neoplasms').years.map(y=>y.papers),[30,30,30,30]);
 assert.equal(result.subjects.length,20);assert.equal(result.subject_count,42);
 const page2=await landscape({subject_page:1});assert.deepEqual(page2.coverage,result.coverage);assert.deepEqual(page2.years,result.years);
 assert.equal(new Set([...result.subjects,...page2.subjects].map(t=>t.topic)).size,40);
 let selected=await landscape({subject:'prostatic neoplasms'});assert.equal(selected.paper_count,120);assert.equal(selected.papers.length,20);
 const ids=new Set(selected.papers.map(p=>p.id));while(selected.next_after){selected=await landscape({subject:'prostatic neoplasms',after:selected.next_after});selected.papers.forEach(p=>{assert.ok(!ids.has(p.id));ids.add(p.id)});}assert.equal(ids.size,120);
 assert.equal((await landscape({from:2021,to:2021,subject:'prostatic neoplasms'})).paper_count,30);
 assert.equal((await landscape({subject:'__unassigned__',paper_year:0})).paper_count,1);
 assert.equal((await landscape({subject_q:'no-such-topic'})).subject_count,0);
 assert.equal((await landscape({journal:'Other'})).coverage.matching_papers,1);
 // Directed references: PMID/DOI duplicate, self-link, outside-catalog target and old target.
 await db.exec(`RESET ROLE;
 INSERT INTO app_private.knowledge_documents(paper_id,content_hash,revision,version) VALUES(1,repeat('a',64),repeat('b',64),'corpus-v1'),(2,repeat('a',64),repeat('b',64),'corpus-v1');
 INSERT INTO app_private.knowledge_bibliographies VALUES(1,repeat('a',64),now(),'[{"pmid":"100002"},{"doi":"10.test/2"},{"pmid":"100001"},{"pmid":"999999"},{"pmid":"100162"}]'),(2,repeat('c',64),now(),'[{"pmid":"100003"}]');
 SET ROLE authenticated;`);
 result=await landscape({mode:'citations',subject:'prostatic neoplasms'});
 assert.equal(result.coverage.indexed_papers,2);assert.equal(result.coverage.reference_metadata_papers,1,'stale hash excluded');
 assert.equal(result.coverage.citation_links,3);assert.equal(result.coverage.unknown_target_year_links,1);
 assert.equal(result.flows.reduce((n,f)=>n+f.links,0),3);
 assert.equal(result.citation_papers.filter(e=>e.target_pmid==='100002').length,1);
 const unknown=await landscape({mode:'citations',citing_year:2021,target_year:0});assert.equal(unknown.edge_count,1);assert.equal(unknown.citation_papers[0].target_title,null);
 const old=await landscape({mode:'citations',from:2020,target_year:1998});assert.equal(old.edge_count,1,'references outside year filter retained');
 await db.exec(`RESET ROLE;UPDATE public.papers SET mesh_terms='["Updated topic"]',pub_date='2025-01-01',fulltext_available=true WHERE id=1;SET ROLE authenticated;`);
 result=await landscape({subject:'updated topic'});assert.equal(result.paper_count,1);assert.equal(result.coverage.fulltext_papers,1);assert.equal(result.papers[0].pub_date,'2025-01-01');
 await db.exec(`RESET ROLE;UPDATE public.papers SET integrity_status='retracted' WHERE id=1;DELETE FROM public.papers WHERE id=2;SET ROLE authenticated;`);
 assert.equal((await landscape()).coverage.catalog_papers,159);assert.equal((await landscape({mode:'citations'})).coverage.citation_links,0);
 for(const f of [{from:2025,to:2020},{subject_page:-1},{limit:60},{mode:'guess'},{from:10}]) await assert.rejects(()=>landscape(f),{code:'22023'});
 await db.exec(`RESET ROLE;UPDATE public.profiles SET access_status='pending' WHERE id='${reader}';SET ROLE authenticated;`);
 await assert.rejects(()=>landscape(),{code:'42501'});
 await db.exec('SET ROLE anon');await assert.rejects(()=>landscape(),{code:'42501'});
 await assert.rejects(()=>scalar('SELECT public.literature_landscape_ready() v'),{code:'42501'});
 await db.exec('SET ROLE service_role');assert.equal(await scalar('SELECT public.literature_landscape_ready() v'),true);
 console.log('Literature landscape: full-catalog counting, resumable projection, pagination, provenance and access checks passed.');
} finally {await db.close();}
