// Isolated SQL regression; instrumented built-ins exist only in this test DB.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const worker='00000000-0000-0000-0000-000000000009',token='load-fixture-token-'.repeat(3);
const budget=1048576;
const scalar=async(sql,params=[])=> (await db.query(sql,params)).rows[0].r;
const paper=(pmid,extra={})=>({pmid,title:'Kidney treatment '+pmid,abstract:'Clinical outcome study',pub_date:'2026-01-01',...extra});
const sync=(papers,credential=token)=>scalar('SELECT public.sync_institution_catalog($1,$2,$3) r',[worker,credential,JSON.stringify(papers)]);
const sizeCalls=()=>scalar('SELECT calls r FROM public.fixture_capacity');
const searchCalls=()=>scalar('SELECT calls r FROM public.fixture_search');
const resetSearch=()=>db.exec('UPDATE public.fixture_search SET calls=0');
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 await db.query('INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES($1,$2,$3)',
  [worker,'Fixture',createHash('sha256').update(token).digest('hex')]);
 await db.query('UPDATE app_private.catalog_capacity SET budget_bytes=$1',[budget]);
 await db.exec(`CREATE TABLE public.fixture_capacity(bytes bigint,calls integer);
 INSERT INTO public.fixture_capacity VALUES(1048576,0);
 ALTER FUNCTION pg_catalog.pg_database_size(name) RENAME TO fixture_original_database_size;
 CREATE FUNCTION pg_catalog.pg_database_size(name) RETURNS bigint LANGUAGE plpgsql AS $$
 DECLARE result bigint; BEGIN UPDATE public.fixture_capacity SET calls=calls+1 RETURNING bytes INTO result; RETURN result; END $$;
 CREATE FUNCTION public.fixture_record_growth() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN UPDATE public.fixture_capacity SET bytes=bytes+1; RETURN NEW; END $$;
 CREATE TRIGGER fixture_record_growth AFTER INSERT ON public.papers FOR EACH ROW EXECUTE FUNCTION public.fixture_record_growth();
 CREATE TABLE public.fixture_search(calls integer); INSERT INTO public.fixture_search VALUES(0);
 ALTER FUNCTION pg_catalog.to_tsvector(regconfig,text) RENAME TO fixture_original_to_tsvector;
 CREATE FUNCTION pg_catalog.to_tsvector(regconfig,text) RETURNS tsvector LANGUAGE plpgsql AS $$
 BEGIN UPDATE public.fixture_search SET calls=calls+1;
 RETURN pg_catalog.fixture_original_to_tsvector($1,$2); END $$;`);

 const blocked=Array.from({length:50},(_,i)=>paper(String(1000+i)));
 assert.deepEqual(await sync(blocked),{accepted:[],capacity_blocked:true});
 assert.equal(await sizeCalls(),1,'An already-full batch checks size once, not once per skipped row');
 assert.equal(await scalar('SELECT count(*)::int r FROM public.papers'),0);
 assert.equal(await searchCalls(),0,'Skipped new rows do not execute INSERT/search work');

 await db.query('UPDATE public.fixture_capacity SET bytes=$1,calls=0',[budget-1]);
 let result=await sync(blocked);
 assert.equal(result.accepted.length,1);assert.equal(result.accepted[0].pmid,'1000');
 assert.equal(result.capacity_blocked,true);
 assert.equal(await sizeCalls(),2,'The next new row rechecks after an admitted row reaches the guard, then caches only blocking');
 assert.equal(await scalar('SELECT count(*)::int r FROM public.papers'),1,'Near-boundary admission does not become a whole-batch overshoot');
 assert.equal(await scalar('SELECT budget_bytes::int r FROM app_private.catalog_capacity'),budget);

 await db.exec('UPDATE public.fixture_capacity SET calls=0');
 result=await sync([...blocked.slice(1),paper('1000',{journal:'Updated journal'})]);
 assert.equal(result.accepted.length,1);assert.equal(result.accepted[0].pmid,'1000');
 assert.equal(result.capacity_blocked,true);assert.equal(await sizeCalls(),1);
 assert.equal(await scalar("SELECT journal r FROM public.papers WHERE pmid='1000'"),'Updated journal','Existing updates still work after the batch blocks new records');
 await db.exec('UPDATE public.fixture_capacity SET calls=0');
 await sync([paper('1000',{journal:'Another journal'})]);
 assert.equal(await sizeCalls(),0,'Existing-only revisions need no new-record capacity check');
 await sync([]);assert.equal(await sizeCalls(),0);

 await db.exec('SET ROLE anon');
 for(const credential of [null,'wrong']) await assert.rejects(sync([paper('2000')],credential),{code:'42501'});
 await assert.rejects(sync([paper('2000',{content_text:'Original body forbidden'})]),/Invalid metadata fields/);
 await assert.rejects(sync(Array.from({length:51},(_,i)=>paper(String(2000+i)))),/Invalid metadata batch/);
 await assert.rejects(db.query('SELECT * FROM app_private.catalog_capacity'),{code:'42501'});
 result=await sync([paper('2000'),paper('1000',{journal:'Token-authorized update'})]);
 assert.equal(result.capacity_blocked,true);assert.equal(result.accepted.length,1,'Existing token-bound execution grants are preserved');
 await db.exec('RESET ROLE');

 const id=await scalar("SELECT id r FROM public.papers WHERE pmid='1000'");
 const vector=()=>scalar('SELECT search_vector::text r FROM public.papers WHERE id=$1',[id]);
 const originalVector=await vector();
 await resetSearch();
 await db.query("UPDATE public.papers SET journal='Metadata only',fetched_at=now(),search_vector='injected'::tsvector WHERE id=$1",[id]);
 assert.equal(await searchCalls(),0,'Unchanged title/abstract skip tokenization');
 assert.equal(await vector(),originalVector,'Metadata-only updates preserve the trusted old vector, ignoring direct replacement');
 await db.query('UPDATE public.papers SET title=title,abstract=abstract WHERE id=$1',[id]);
 assert.equal(await searchCalls(),0,'Explicit unchanged text assignments also skip tokenization');

 await db.query("UPDATE public.papers SET title='Bladder diagnosis' WHERE id=$1",[id]);
 assert.equal(await searchCalls(),2,'Real title change recomputes title and abstract');
 assert.equal(await scalar("SELECT search_vector @@ plainto_tsquery('english','bladder diagnosis') r FROM public.papers WHERE id=$1",[id]),true);
 assert.equal(await scalar("SELECT search_vector @@ plainto_tsquery('english','kidney') r FROM public.papers WHERE id=$1",[id]),false);
 await resetSearch();
 await db.query("UPDATE public.papers SET abstract='Prostate radiotherapy' WHERE id=$1",[id]);
 assert.equal(await searchCalls(),2,'Real abstract change also recomputes');
 assert.equal(await scalar("SELECT search_vector @@ plainto_tsquery('english','radiotherapy') r FROM public.papers WHERE id=$1",[id]),true);
 await resetSearch();
 await db.query('UPDATE public.papers SET abstract=NULL WHERE id=$1',[id]);
 assert.equal(await searchCalls(),2);await resetSearch();
 await db.query('UPDATE public.papers SET abstract=NULL WHERE id=$1',[id]);
 assert.equal(await searchCalls(),0,'NULL equality is handled correctly');

 await resetSearch();
 await sync([paper('1000',{title:'Bladder diagnosis',abstract:null,journal:'Metadata replay'})]);
 assert.equal(await searchCalls(),2,'ON CONFLICT still computes the INSERT vector, while unchanged UPDATE avoids the second computation');
 await resetSearch();
 await sync([paper('1000',{title:'Novel kidney analysis',abstract:'Changed source text'})]);
 assert.equal(await searchCalls(),4,'ON CONFLICT changed source text takes both required trigger paths');
 assert.equal(await scalar("SELECT search_vector @@ plainto_tsquery('english','novel kidney') r FROM public.papers WHERE id=$1",[id]),true);

 console.log('Catalog sync load: blocked-batch size caching, strict per-insert boundary, token/payload/grant preservation and measured search-trigger behavior passed.');
} finally {await db.close();}
