// Isolated PostgreSQL regression; no network or production credentials.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const worker='00000000-0000-0000-0000-000000000009',other='00000000-0000-0000-0000-000000000010';
const owner='00000000-0000-0000-0000-000000000001',token='catalog-fixture-token-'.repeat(3);
const sha=s=>createHash('sha256').update(s).digest('hex');
const paper=(pmid,extra={})=>({pmid,title:'Catalog fixture '+pmid,pub_date:'2026-01-01',...extra});
const sync=(papers,credential=token,id=worker)=>db.query('SELECT public.sync_institution_catalog($1,$2,$3) r',[id,credential,JSON.stringify(papers)]).then(r=>r.rows[0].r);
const report=(status,credential=token,id=worker)=>db.query('SELECT public.report_institution_catalog($1,$2,$3)',[id,credential,JSON.stringify(status)]);
const scalar=async(sql,params=[])=> (await db.query(sql,params)).rows[0].r;
const snapshot=()=>scalar('SELECT public.catalog_backfill_status() r');
const status={local_papers:100,synced_papers:80,citation_pending:20,local_originals:30,
 local_summaries:10,pending_originals:3,pending_summaries:2,sync_state:'capacity_blocked',
 last_sync_at:null,registry_version:'2026-09-17.urology-centered-65.v1'};
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 await db.query('INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES($1,$2,$3),($4,$5,$3)',[worker,'Fixture',sha(token),other,'Second']);
 await db.query("INSERT INTO auth.users VALUES($1,'crazyslime@gmail.com',now(),'{}')",[owner]);
 await db.exec('UPDATE app_private.catalog_capacity SET budget_bytes=1073741824;SET ROLE anon;');
 for(const credential of [null,'bad','a'.repeat(60)]) {
  await assert.rejects(sync([paper('101')],credential),{code:'42501'});
  await assert.rejects(report(status,credential),{code:'42501'});
 }
 await assert.rejects(db.query('SELECT * FROM app_private.institution_catalog_reports'),{code:'42501'});
 await assert.rejects(db.query('SELECT public.catalog_backfill_status_v26()'),{code:'42501'});
 let result=await sync([paper('101',{abstract:'PubMed abstract',authors:['Author A'],doi:'10.1000/test',
  journal:'Test journal',mesh_terms:['Urology'],keywords:['Cohort'],paper_type:'article',pub_types:['Journal Article'],
  study_type:'cohort',volume:'20',issue:'1',pages:'1-4',publication_types:['Journal Article'],
  integrity_status:'current',related_notices:[],integrity_checked_at:new Date().toISOString()})]);
 assert.equal(result.capacity_blocked,false);assert.equal(result.accepted.length,1);
 const id=result.accepted[0].id;
 assert.deepEqual(await sync([paper('101')]),result,'Retries keep one PMID and return its existing identity');
 await db.exec('RESET ROLE');
 assert.equal(await scalar("SELECT count(*)::int r FROM public.papers WHERE pmid='101'"),1);
 assert.equal(await scalar("SELECT abstract r FROM public.papers WHERE pmid='101'"),'PubMed abstract','Omitted metadata does not erase existing values');
 await db.query(`INSERT INTO app_private.local_fulltext_sources(paper_id,worker_id,title,content_hash,summary_source_hash,characters,section_count)
 VALUES($1,$2,'Catalog fixture 101',repeat('b',64),repeat('a',64),3000,3)`,[id,worker]);
 await db.query(`UPDATE public.papers SET summary_ko=E'First\nSecond\nThird',summary_basis='fulltext',fulltext_available=true,fulltext_storage='z8',
 summary_model='fixture',summary_source_hash=repeat('a',64),summarized_at=now(),structured_data='{"n":20}',
 evidence='{"claims":[]}',research_details='{"population":"Fixture"}' WHERE id=$1`,[id]);
 await db.query(`INSERT INTO public.reader_states(user_id,paper_id,note,saved) VALUES($1,$2,'Keep reader note',true)`,[owner,id]);
 const protectedFields=await scalar(`SELECT jsonb_build_object('summary',summary_ko,'basis',summary_basis,'model',summary_model,
 'hash',summary_source_hash,'time',summarized_at,'structured',structured_data,'evidence',evidence,'details',research_details) r FROM public.papers WHERE id=$1`,[id]);
 await db.exec('SET ROLE anon');
 for(const invalid of [null,{},Array.from({length:51},()=>paper('102')),
  [paper('102',{body:'Forbidden original'})],[paper('102',{summary_ko:'Injected'})],[paper('102',{id:123})],
  [paper('102',{abstract:'a'.repeat(100001)})],[paper('102',{pub_date:'1999-12-31'})],
  [paper('102',{pub_date:'2026-02-30'})],[paper('102',{pub_date:'3001-01-01'})],
  [paper('102',{pub_date:null})],[paper('102',{title:''})],[paper('102',{pmid:'1;delete'})],
  [paper('102',{authors:['valid',{body:'not metadata'}]})],
  [paper('102',{related_notices:[{pmid:'5',relation:'RetractionIn',body:'Forbidden'}]})],
  [paper('102',{integrity_checked_at:'infinity'})],[paper('102',{integrity_status:'invented'})]])
  await assert.rejects(sync(invalid),/Invalid|scope/);
 await assert.rejects(sync([paper('102'),paper('103',{original:'no'})]),/Invalid/);
 await assert.rejects(sync([paper('102'),paper('102')]),/Duplicate PMID/);
 await db.exec('RESET ROLE');
 assert.equal(await scalar("SELECT count(*)::int r FROM public.papers WHERE pmid='102'"),0,'Invalid batch rolls back previously inserted rows');
 await db.exec("UPDATE public.papers SET fetched_at='2020-01-01' WHERE pmid='101'");
 await db.exec('UPDATE app_private.catalog_capacity SET budget_bytes=1048576;SET ROLE anon;');
 result=await sync([paper('102'),paper('101',{journal:'Updated journal',abstract:null,keywords:null})]);
 assert.deepEqual(result,{accepted:[{pmid:'101',id}],capacity_blocked:true},'At capacity, existing metadata updates still commit after skipped new rows');
 await db.exec('RESET ROLE');
 assert.equal(await scalar("SELECT count(*)::int r FROM public.papers WHERE pmid='102'"),0);
 assert.equal(await scalar('SELECT journal r FROM public.papers WHERE id=$1',[id]),'Updated journal');
 assert.equal(await scalar('SELECT abstract r FROM public.papers WHERE id=$1',[id]),'PubMed abstract','Null optional metadata is treated as absent');
 assert.ok(Date.now()-Date.parse(await scalar('SELECT fetched_at r FROM public.papers WHERE id=$1',[id]))<60000,'Valid metadata refresh advances service freshness');
 assert.deepEqual(await scalar(`SELECT jsonb_build_object('summary',summary_ko,'basis',summary_basis,'model',summary_model,
 'hash',summary_source_hash,'time',summarized_at,'structured',structured_data,'evidence',evidence,'details',research_details) r FROM public.papers WHERE id=$1`,[id]),protectedFields);
 assert.equal(await scalar('SELECT note r FROM public.reader_states WHERE paper_id=$1',[id]),'Keep reader note');
 await db.exec('SET ROLE anon');await sync([paper('101',{title:'Corrected title'})]);await db.exec('RESET ROLE');
 const corrected=await scalar('SELECT to_jsonb(p) r FROM public.papers p WHERE id=$1',[id]);
 assert.equal(corrected.title,'Corrected title');assert.equal(corrected.summary_source_hash,null);
 assert.equal(corrected.summarized_at,null,'A real title correction retains existing source invalidation behavior');
 assert.equal(corrected.summary_ko,protectedFields.summary,'Existing summary text is retained for regeneration');
 assert.equal(await scalar('SELECT note r FROM public.reader_states WHERE paper_id=$1',[id]),'Keep reader note');
 let cloud=await snapshot();assert.equal(cloud.local_catalog.available,false);
 await db.exec('SET ROLE anon');await report(status);
 for(const invalid of [null,{}, {...status,body:'no'}, {...status,local_papers:-1},{...status,local_papers:1.2},
  {...status,local_papers:'100'},{...status,local_papers:null},{...status,local_papers:1e10},
  {...status,synced_papers:101},{...status,citation_pending:19},{...status,pending_originals:31},{...status,pending_summaries:101},
  {...status,sync_state:'running'},{...status,registry_version:''},{...status,last_sync_at:'infinity'},
  {...status,last_sync_at:100},{...status,last_sync_at:'2099-01-01'}])
  await assert.rejects(report(invalid),/Invalid|Inconsistent/);
 await db.exec('RESET ROLE');
 let next=await snapshot();
 assert.equal(next.catalog_papers,cloud.catalog_papers,'Local totals never inflate cloud registration counts');
 assert.equal(next.originals_acquired,cloud.originals_acquired);assert.equal(next.summaries_ready,cloud.summaries_ready);
 assert.equal(next.local_catalog.local_papers,100);assert.equal(next.local_catalog.available,true);assert.equal(next.local_catalog.stale,false);
 await db.exec("UPDATE app_private.institution_catalog_reports SET reported_at=now()-interval '3 hours'");
 assert.equal((await snapshot()).local_catalog.stale,true);
 await db.exec('SET ROLE anon');await report({...status,local_papers:200,citation_pending:120,last_sync_at:new Date().toISOString()},token,other);
 await db.exec('RESET ROLE');assert.equal((await snapshot()).local_catalog.local_papers,200,'Most recent enabled worker supplies local status');
 await db.query('UPDATE app_private.institution_workers SET enabled=false WHERE id=$1',[other]);
 assert.equal((await snapshot()).local_catalog.local_papers,100);
 await db.exec('SET ROLE anon');await assert.rejects(report(status,token,other),{code:'42501'});
 await assert.rejects(sync([],token,other),{code:'42501'});
 await db.exec('RESET ROLE;SET ROLE authenticated;');
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[owner]);
 assert.equal((await scalar('SELECT public.admin_catalog_status() r')).local_catalog.local_papers,100);
 await assert.rejects(db.query('SELECT * FROM app_private.institution_catalog_reports'),{code:'42501'});
 await assert.rejects(db.query('SELECT public.catalog_backfill_status()'),{code:'42501'});
 console.log('Local catalog sync: authentication, bounded metadata-only writes, capacity admission, transactional replay, summary/history preservation and private fresh/stale reports passed.');
} finally {await db.close();}
