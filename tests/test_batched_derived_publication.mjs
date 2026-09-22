import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const worker='00000000-0000-0000-0000-000000000003', token='fixture-secret-only-'.repeat(3);
const call=(events,key=token)=>db.query('SELECT public.sync_institution_events($1,$2,$3) r',[worker,key,JSON.stringify(events)]).then(r=>r.rows[0].r);
const original=(pmid='1')=>({pmid,kind:'original',version:1,payload:{p_pmid:pmid,p_title:'Fixture '+pmid,p_doi:'10.1000/'+pmid,
 p_source:{content_hash:'a'.repeat(64),summary_source_hash:'b'.repeat(64),characters:3000,section_count:3,source_url:'https://example.org/article'}}});
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 await db.query('INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES($1,$2,$3)',[worker,'Fixture',createHash('sha256').update(token).digest('hex')]);
 await db.exec(`INSERT INTO public.papers(id,pmid,title,pub_date,doi) SELECT n,n::text,'Fixture '||n,'2026-01-01'::date,'10.1000/'||n FROM generate_series(1,30) n;SET ROLE anon;`);
 await assert.rejects(()=>call([original()],'bad-token'),{code:'42501'});
 await assert.rejects(()=>call([]),{code:'22023'});
 await assert.rejects(()=>call(Array.from({length:26},(_,n)=>original(String(n+1)))),{code:'22023'});
 await assert.rejects(()=>call([original(),original()]),{code:'22023'});
 const bad=original('2');bad.payload.p_title='Wrong title';
 const raw=original('3');raw.payload.html='Forbidden source bytes';
 let result=await call([original(),bad,raw,original('4')]);
 assert.deepEqual(result.map(r=>r.status),['accepted','rejected','rejected','accepted']);
 assert.deepEqual(await call([original(),original('4')]),[result[0],result[3]],'Replay remains idempotent');
 const sum=original('1');sum.kind='summary';delete sum.payload.p_source.summary_source_hash;
 sum.payload.p_summary={summary_ko:'First result\nSecond result\nThird result',structured_data:{study_design:'Cohort',sample_size:'42',population:'Adults',key_finding:'Synthetic finding'},qa_data:[{q:'What?',a:'Fixture.'}],clinical_relevance:3,summary_model:'spark/fixture',summary_source_hash:'b'.repeat(64)};
 assert.equal((await call([sum]))[0].status,'accepted');
 await db.exec("RESET ROLE;UPDATE public.papers SET doi='' WHERE pmid='1';SET ROLE anon;");
 sum.payload.p_doi=null;
 assert.equal((await call([sum]))[0].status,'accepted','Missing DOI normalizes identically for citations, originals and summaries');
 await db.exec('RESET ROLE');
 assert.equal((await db.query('SELECT count(*) n FROM app_private.local_fulltext_sources')).rows[0].n,2);
 assert.equal((await db.query('SELECT count(*) n FROM public.paper_fulltexts')).rows[0].n,0,'Original bytes never enter cloud storage');
 assert.equal((await db.query("SELECT count(*) n FROM app_private.admin_catalog_metrics WHERE original_acquired")).rows[0].n,2,'Counts change in the same transaction');
 // Unexpected database failures roll back the complete request, not false ACKs.
 await db.exec(`CREATE FUNCTION public.fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.paper_id=6 THEN RAISE EXCEPTION 'transient' USING ERRCODE='40001';END IF;RETURN NEW;END$$;
 CREATE TRIGGER fixture_fail BEFORE INSERT ON app_private.local_fulltext_sources FOR EACH ROW EXECUTE FUNCTION public.fixture_fail();SET ROLE anon;`);
 await assert.rejects(()=>call([original('5'),original('6')]),{code:'40001'});
 await db.exec('RESET ROLE');
 assert.equal((await db.query('SELECT count(*) n FROM app_private.local_fulltext_sources WHERE paper_id=5')).rows[0].n,0);
 console.log('Derived publication: authenticated worker, bounded batches, exact receipts, validation isolation, replay, transactional metrics, summary publication and rollback passed.');
} finally {await db.close();}
