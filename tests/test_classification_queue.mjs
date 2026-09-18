// Isolated PostgreSQL contracts; no production requests or original bodies.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const scalar=async(sql,params=[])=> (await db.query(sql,params)).rows[0].r;
const candidates=(after=0,limit=100,all=false)=>scalar('SELECT public.classification_candidates($1,$2,$3) r',[after,limit,all]);
const apply=rows=>scalar('SELECT public.apply_paper_classifications($1) r',[JSON.stringify(rows)]);
const result=(paper,type='other')=>({id:paper.id,source_hash:paper.classification_source_hash,study_type:type});
const state=id=>scalar('SELECT jsonb_build_object(\'version\',classification_version,\'hash\',classification_source_hash,\'at\',classified_at,\'type\',study_type) r FROM public.papers WHERE id=$1',[id]);
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 const migrations=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
 for(const file of migrations) {
  if(file.startsWith('030_')) await db.exec(`INSERT INTO public.papers(id,pmid,title,pub_date,study_type,pub_types)
   VALUES(1,'1','Unmatched clinical article','2000-01-01','other','["Journal Article"]'),
    (2,'2','Historic article','1999-12-31','other','[]'),
    (3,'3','No publication date',NULL,'other','[]'),
    (4,'4','Kidney clinical research','2026-01-01','retrospective','[]'),
    (5,'5','Imaging investigation','2026-02-01','other','[]'),
    (6,'6','Clinical outcome','2026-02-01','other','[]');`);
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 }
 const index=await scalar("SELECT pg_get_indexdef(indexrelid) r FROM pg_index WHERE indexrelid='public.idx_papers_classification_pending'::regclass");
 assert.match(index,/classification_version < 1/);assert.match(index,/2000-01-01/);
 assert.equal(await scalar("SELECT provolatile r FROM pg_proc WHERE oid='public.classification_candidates(bigint,integer,boolean)'::regprocedure"),'s','PostgREST GET requires a stable read-only function');
 await db.exec('SET ROLE service_role');
 let page=await candidates(0,2);
 assert.deepEqual(page.map(p=>p.id),[1,4],'Keyset page excludes pre-2000 and unknown dates');
 assert.deepEqual(Object.keys(page[0]).sort(),['id','pmid','title','abstract','mesh_terms','pub_types','study_type','classification_source_hash'].sort());
 assert.deepEqual(page[0].pub_types,['Journal Article'],'An empty publication_types field falls back to the stored pub_types');
 assert.match(page[0].classification_source_hash,/^[0-9a-f]{64}$/);
 assert.deepEqual((await candidates(4,2)).map(p=>p.id),[5,6]);
 assert.deepEqual(await candidates(6,2),[]);
 assert.deepEqual(await apply([result(page[0]),result(page[1],'surgical')]),{updated:2,stale:0});
 assert.deepEqual((await candidates()).map(p=>p.id),[5,6],'A legitimate other result finishes once and cannot starve later IDs');
 assert.deepEqual((await candidates(0,200,true)).map(p=>p.id),[1,4,5,6],'Explicit reclassification includes completed rows');
 await db.exec('RESET ROLE');
 let completed=await state(4);
 assert.equal(completed.version,1);assert.equal(completed.type,'surgical');assert.ok(completed.at);assert.match(completed.hash,/^[a-f0-9]{64}$/);
 await db.exec("UPDATE public.papers SET journal='Metadata update',study_type='other' WHERE id=4");
 assert.deepEqual(await state(4),completed,'A stale local classification fallback cannot replace completed unchanged source metadata');
 await db.exec("UPDATE public.papers SET abstract='New retrospective source material' WHERE id=4");
 assert.deepEqual(await state(4),{version:0,hash:null,at:null,type:'surgical'},'Changed source invalidates completion, preserving a fallback until classified');
 await db.exec('SET ROLE service_role');
 assert.deepEqual(await apply([result(page[1],'rct')]),{updated:0,stale:1},'An obsolete snapshot cannot overwrite a changed source');
 const changed=(await candidates()).find(p=>p.id===4);
 assert.notEqual(changed.classification_source_hash,page[1].classification_source_hash);
 assert.deepEqual(await apply([result(changed,'retrospective')]),{updated:1,stale:0});
 await db.exec('RESET ROLE');
 assert.equal((await state(4)).type,'retrospective');

 for(const [column,value] of [['title','Updated title'],['abstract','Updated abstract'],['mesh_terms',['Artificial Intelligence']],['pub_types',['Review']],['publication_types',['Case Reports']]]) {
  await db.query(`UPDATE public.papers SET ${column}=$1 WHERE id=4`,[Array.isArray(value)?JSON.stringify(value):value]);
  assert.equal((await state(4)).version,0,`${column} source changes requeue the paper`);
  const next=(await candidates()).find(p=>p.id===4);
  await apply([result(next)]);
  assert.equal((await state(4)).version,1);
 }
 completed=await state(4);
 await db.exec("UPDATE public.papers SET pub_types='[\"Journal Article\"]',study_type='rct' WHERE id=4");
 assert.deepEqual(await state(4),completed,'An unused legacy publication-type field does not invalidate the selected source');
 assert.deepEqual((await candidates(0,100,true)).find(p=>p.id===4).pub_types,['Case Reports']);

 await db.exec('SET ROLE service_role');
 page=await candidates();
 const first=page[0];
 for(const invalid of [
  {...result(first),study_type:'invented'},
  {...result(first),source_hash:'bad'},
  {...result(first),id:String(first.id)},
  {...result(first),id:null},
  {...result(first),content_text:'Raw body forbidden'},
  {id:first.id,study_type:'other'},
 ]) await assert.rejects(apply([result(first),invalid]),{code:'22023'});
 await assert.rejects(apply([result(first),result(first)]),/Duplicate classification result/);
 await assert.rejects(apply(Array.from({length:201},(_,i)=>({...result(first),id:1000+i}))),/Invalid classification batch/);
 await assert.rejects(scalar('SELECT public.apply_paper_classifications(NULL) r'),/Invalid classification batch/);
 await assert.rejects(scalar('SELECT public.apply_paper_classifications(\'{}\') r'),/Invalid classification batch/);
 assert.deepEqual((await candidates()).map(p=>p.id),[5,6],'Invalid batches leave all earlier valid items pending');
 assert.deepEqual(await apply([]),{updated:0,stale:0});
 assert.deepEqual(await apply([result(first),{...result(first),id:999},{...result(first),id:2},{...result(first),id:3}]),{updated:1,stale:3});
 const last=(await candidates())[0];
 assert.deepEqual(await apply([result(last)]),{updated:1,stale:0});
 assert.deepEqual(await candidates(),[]);
 await db.exec(`RESET ROLE;
 CREATE TABLE public.fixture_classification_writes(count integer);INSERT INTO public.fixture_classification_writes VALUES(0);
 CREATE FUNCTION public.fixture_classification_write() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN UPDATE public.fixture_classification_writes SET count=count+1;RETURN NEW;END $$;
 CREATE TRIGGER fixture_classification_write AFTER UPDATE ON public.papers FOR EACH ROW EXECUTE FUNCTION public.fixture_classification_write();
 SET ROLE service_role;`);
 assert.deepEqual(await apply([result(last)]),{updated:1,stale:0},'An acknowledged result can be safely replayed after uncertain transport');
 await db.exec('RESET ROLE');
 assert.equal(await scalar('SELECT count r FROM public.fixture_classification_writes'),0,'An identical completed replay does not rewrite the paper');
 await db.exec('SET ROLE service_role');
 for(const values of [[-1,10,false],[0,0,false],[0,201,false],[null,10,false],[0,10,null]])
  await assert.rejects(candidates(...values),{code:'22023'});

 for(const role of ['anon','authenticated']) {
  await db.exec(`RESET ROLE;SET ROLE ${role}`);
  await assert.rejects(candidates(),{code:'42501'});
  await assert.rejects(apply([]),{code:'42501'});
  await assert.rejects(db.query("SELECT app_private.classification_fingerprint('x','','[]','[]')"),{code:'42501'});
 }
 await db.exec('RESET ROLE');
 assert.equal(await scalar("SELECT has_function_privilege('service_role','public.classification_candidates(bigint,integer,boolean)','EXECUTE') r"),true);
 assert.equal(await scalar("SELECT has_function_privilege('anon','public.apply_paper_classifications(jsonb)','EXECUTE') r"),false);
 console.log('Classification queue: bounded keyset pages, other completion, source-change invalidation, stale-source protection, atomic validation, replay and service-only RPCs passed.');
} finally {await db.close();}
