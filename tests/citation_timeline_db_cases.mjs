import assert from 'node:assert/strict';
export async function citationTimelineCases(db,{publish,scalar,source,worker,hash}) {
 const get=f=>scalar('SELECT public.knowledge_network($1) v',[{relation:'citations',...f}]);
 await db.exec(`RESET ROLE;
 INSERT INTO public.papers(id,pmid,title,authors,journal,pub_date,fulltext_available)
 SELECT 8000+i,(800000+i)::text,'Citation fixture '||i,'["Fixture Author"]'::jsonb,'Fixture journal','2024-01-01',true FROM generate_series(1,26) i;
 INSERT INTO app_private.local_fulltext_sources(paper_id,worker_id,title,content_hash,summary_source_hash,characters,section_count)
 SELECT id,'${worker}',title,'${hash}','${hash}',10000,3 FROM public.papers WHERE id BETWEEN 8001 AND 8026;
 SET ROLE authenticated;`);
 for(let i=1;i<=26;i++) {
  const pmid=String(800000+i),title=`Citation fixture ${i}`;
  await publish('source',{...source,pmid,title});
  await publish('bibliography',{version:'corpus-v1',pmid,title,content_hash:hash,source:'PubMed',fetched_at:new Date().toISOString(),
   references:i===26?[]:Array.from({length:25},(_,j)=>j+1).filter(j=>j!==i).map(j=>({source_id:`r${j}`,pmid:String(800000+j),doi:null}))});
 }
 let d=await get({limit:10,journal:'Fixture journal'});
 assert.equal(d.nodes.length,10);
 assert(d.nodes.every(n=>d.edges.some(e=>e.source===n.id||e.target===n.id)),'Every overview paper has a displayed partner');
 assert(d.nodes.every(n=>Number(n.incoming_citations)===24&&Number(n.identified_references)===24),'Scoped metrics do not shrink to displayed degree');
 assert.deepEqual(d.nodes[0].authors,['Fixture Author']);
 assert.equal(d.coverage.unlinked_papers,1);
 assert.equal(d.unlinked_papers[0].id,'800026');
 d=await get({limit:100,journal:'Fixture journal'});
 assert.equal(d.edges.length,500);
 assert.equal(d.nodes.length,25);
 assert(d.nodes.every(n=>d.edges.some(e=>e.source===n.id||e.target===n.id)),'Edge cap retains the edges that admitted endpoints');
 d=await get({limit:10,journal:'Fixture journal',focus:'800025'});
 assert(d.nodes.some(n=>n.id==='800025'));
 assert.equal(Number(d.citation_selection[0].incoming_citations),24);
 d=await get({limit:10,journal:'Fixture journal',focus:'800026'});
 assert(d.nodes.some(n=>n.id==='800026'),'An explicitly selected unlinked paper stays inspectable');
 assert.equal(d.citation_selection[0].identified_references,0);
 await db.exec('RESET ROLE;DELETE FROM public.papers WHERE id BETWEEN 8001 AND 8026;SET ROLE authenticated');
 console.log('Citation timeline DB passed: paired endpoints, scope-correct counts, bibliography, focused retention, unlinked list and edge cap.');
}
