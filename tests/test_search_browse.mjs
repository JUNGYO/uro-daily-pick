import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db = new PGlite(), uid='00000000-0000-0000-0000-000000000001';
const migrate=async name=>db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
const search=async args=>{const es=Object.entries(args);return (await db.query('SELECT public.search_papers_v2('+es.map(([k],i)=>`${k}=>$${i+1}`).join(',')+') r',es.map(([,v])=>v))).rows[0].r;};
const contracts=async()=> (await db.query("SELECT prosecdef,proacl::text FROM pg_proc WHERE oid='public.search_papers_v2(text,date,date,text,text,text,text,integer,boolean,text)'::regprocedure")).rows[0];
try {
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO anon,authenticated;`);
 const files=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
 for(const f of files.filter(f=>f<'042'))await migrate(f);
 await db.exec(`INSERT INTO auth.users VALUES('${uid}','reader@example.test',now(),'{}');
 INSERT INTO public.papers(id,pmid,title,abstract,journal,pub_date,doi,study_type,integrity_status,fulltext_available,summary_basis,summary_source_hash,summarized_at,summary_model,summary_ko)
 SELECT n,(10000+n)::text,CASE WHEN n%3=0 THEN 'AI-assisted prostate diagnosis' ELSE 'Veterans Affairs prostate cohort' END,
 'Prostate cohort abstract',CASE WHEN n%2=0 THEN 'Example Journal' ELSE 'Other Journal' END,
 DATE '2025-01-01'+(n/3),'10.1000/test'||n,CASE WHEN n%2=0 THEN 'rct' ELSE 'cohort' END,
 CASE WHEN n%5=0 THEN 'retracted' ELSE 'current' END,n%4=0,'fulltext','fixture',now(),'fixture',E'Line one\nLine two\nLine three'
 FROM generate_series(1,67) n;
 INSERT INTO public.reader_states(user_id,paper_id,saved) SELECT '${uid}',n,true FROM generate_series(1,67) n WHERE n%7=0;
 GRANT SELECT ON public.papers TO authenticated;`);
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[uid]);await db.exec('SET ROLE authenticated');
 const cases=[{}, {p_page:1},{p_page:2},{p_page:999},{p_sort:'oldest'},{p_sort:'relevance'},
 {p_query:'prostate',p_sort:'relevance'},{p_query:'AI'},{p_query:'10031'},{p_query:'https://doi.org/10.1000/test31'},
 {p_journal:'example journal'},{p_journal:'Other Journal',p_from:'2025-01-07',p_to:'2025-01-12'},
 {p_state:'ready'},{p_state:'pending'},{p_saved:true},{p_integrity:'all'},{p_integrity:'retracted'},
 {p_type:'cohort',p_query:'prostate',p_sort:'oldest'},{p_from:'2025-01-08',p_to:'2025-01-08'}];
 const before=[];for(const c of cases)before.push(await search(c));
 const access=await contracts(); await db.exec('RESET ROLE');
 for(const f of files.filter(f=>f>='042'))await migrate(f);
 assert.deepEqual(await contracts(),access,'Invoker security and execution grants must be unchanged');
 const config=(await db.query("SELECT proconfig FROM pg_proc WHERE oid='public.search_papers_v2(text,date,date,text,text,text,text,integer,boolean,text)'::regprocedure")).rows[0].proconfig;
 assert.ok(config.includes('plan_cache_mode=force_custom_plan'));
 assert.ok(config.includes('statement_timeout=8s'));
 assert.match((await db.query("SELECT pg_get_indexdef('public.papers_search_browse'::regclass) d")).rows[0].d,/pub_date DESC, id DESC\) INCLUDE \(integrity_status\)/);
 await db.exec('SET ROLE authenticated');
 for(let i=0;i<cases.length;i++)assert.deepEqual(await search(cases[i]),before[i],JSON.stringify(cases[i]));
 for(const c of [{p_page:-1},{p_from:'1999-01-01'},{p_sort:'invalid'},{p_saved:null}])await assert.rejects(search(c),{code:'22023'});
 await db.exec('RESET ROLE; SET ROLE anon');await assert.rejects(search({}),{code:'42501'});
 console.log('Indexed browsing: exact totals/order/pages, date/journal/keyword/summary/saved/integrity filters and existing access preserved.');
} finally { await db.close(); }
