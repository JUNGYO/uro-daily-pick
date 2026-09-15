import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import {createHash} from 'node:crypto';
const db=new PGlite();
const a='00000000-0000-0000-0000-000000000001',b='00000000-0000-0000-0000-000000000002',c='00000000-0000-0000-0000-000000000003';
async function user(id){await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('SET ROLE authenticated')}
try{
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()){
  await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
  console.log('applied '+file);
 }
 await db.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.collections,public.collection_papers,public.papers,public.profiles,public.feedbacks TO authenticated;
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
 INSERT INTO auth.users VALUES('${a}','crazyslime@gmail.com',now(),'{}'),('${b}','reader@example.test',now(),'{}'),('${c}','outsider@example.test',now(),'{}');
 INSERT INTO public.papers(id,pmid,title,doi,pub_date,abstract) VALUES(1,'10001','Prostate cancer follow up','10.1000/test','2026-01-01','Prospective cohort'),(2,'10002','Bladder cancer','10.1000/other','2025-01-01','Retrospective cohort');`);
 await user(a);
 const search=await db.query("SELECT public.search_papers('10001') result");assert.equal(search.rows[0].result.items.length,1);
 assert.equal((await db.query("SELECT public.search_papers('https://doi.org/10.1000/test') r")).rows[0].r.items[0].pmid,'10001');
 assert.equal((await db.query("SELECT public.reader_paper('10001') r")).rows[0].r.paper.title,'Prostate cancer follow up');
 await db.query("SELECT public.update_reader_state(1,'{\"saved\":true,\"note\":\"private\"}')");
 await db.query("SELECT public.update_reader_state(1,'{\"reading_state\":\"read\"}')");
 assert.equal((await db.query('SELECT note FROM public.reader_states')).rows[0].note,'private');
 await db.query("SELECT public.reader_opinion(1,'dislike')");assert.equal((await db.query('SELECT saved FROM public.reader_states')).rows[0].saved,true);
 await db.query("INSERT INTO public.collections(id,user_id,name,keywords) VALUES(10,$1,'Project',ARRAY['prostate'])",[a]);
 await db.query('INSERT INTO public.collection_papers VALUES(10,1,now())');
 await db.query("SELECT public.project_members(10,'reader@example.test','reader')");
 await user(b);assert.equal((await db.query('SELECT * FROM public.reader_states')).rows.length,0);
 assert.equal((await db.query('SELECT * FROM public.collections')).rows.length,0);
 assert.equal((await db.query('SELECT public.project_invitations() r')).rows[0].r.length,1);
 await db.query('SELECT public.project_invitations(10)');
 assert.equal((await db.query('SELECT public.project_papers(10) r')).rows[0].r.items.length,1);
 await assert.rejects(db.query('INSERT INTO public.collection_papers VALUES(10,2,now())'));
 await user(a);await db.query("SELECT public.project_members(10,'reader@example.test','editor')");
 await user(b);await db.query('INSERT INTO public.collection_papers VALUES(10,2,now())');
 await db.query("INSERT INTO public.project_notes(collection_id,paper_id,note,updated_by) VALUES(10,2,'Team note',$1)",[b]);
 await db.query('SELECT public.project_recommendations(10)');
 await assert.rejects(db.query("SELECT public.project_members(10,'outsider@example.test','editor')"));
 await user(c);assert.equal((await db.query('SELECT * FROM public.project_notes')).rows.length,0);await assert.rejects(db.query('SELECT public.project_papers(10)'));
 await user(a);await db.query('SELECT public.project_members(10,NULL,\'reader\',$1)',[b]);
 await user(b);assert.equal((await db.query('SELECT * FROM public.project_notes')).rows.length,0);
 await db.query("INSERT INTO public.summary_issues(user_id,paper_id,category,message) VALUES($1,1,'summary','Check value')",[b]);
 await assert.rejects(db.query('SELECT public.admin_summary_issues()'));
 await db.query("INSERT INTO public.saved_searches(user_id,name,query) VALUES($1,'Topic','prostate')",[b]);
 await db.query('SELECT public.search_notifications()');await db.query('SELECT public.reader_daily()');
 await user(a);assert.equal((await db.query('SELECT public.admin_summary_issues() r')).rows[0].r.length,1);
 await db.exec('RESET ROLE');
 const sha=x=>createHash('sha256').update(x).digest('hex'),token='synthetic-token-'.repeat(4),worker='00000000-0000-0000-0000-000000000009';
 await db.query('INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES($1,$2,$3)',[worker,'fixture',sha(token)]);
 const body='Synthetic source for validated summary publication. '.repeat(60),hash=sha('fulltext\nProstate cancer follow up\n'+body);
 const details=Object.fromEntries(['intervention','comparator','follow_up','outcome','limitations'].map(k=>[k,'Not reported']));
 const structured=Object.fromEntries(['study_design','sample_size','key_finding','population'].map(k=>[k,'Not reported']));
 const source={content_hash:sha(body),characters:body.length,section_count:2,source_url:'https://example.test/article'};
 const derived={summary_ko:'연구 설계를 확인했다.\n결과를 확인했다.\n해석에 한계가 있다.',structured_data:structured,qa_data:[{q:'한계는?',a:'Not reported'}],clinical_relevance:3,summary_model:'spark/fixture.evidence-v1',summary_source_hash:hash,research_details:details,
 evidence:{version:1,content_hash:sha(body),claims:{summary_1:['p-0000000'],summary_2:['p-0000000'],summary_3:['p-0000000'],...Object.fromEntries([...Object.keys(details),...Object.keys(structured),'qa_1'].map(k=>[k,[]]))}}};
 const publish=(summary=derived)=>db.query('SELECT public.publish_institution_summary($1,$2,$3,$4,$5,$6,$7)',[worker,token,'10001','10.1000/test','Prostate cancer follow up',JSON.stringify(source),JSON.stringify(summary)]);
 await db.exec('SET ROLE anon');await publish();
 await assert.rejects(publish({...derived,evidence:{...derived.evidence,claims:{summary_1:[body],summary_2:['p-0000000'],summary_3:['p-0000000']}}}));
 await assert.rejects(publish({...derived,content_text:body}));
 await db.exec('RESET ROLE');
 assert.deepEqual((await db.query('SELECT evidence FROM public.papers WHERE id=1')).rows[0].evidence,derived.evidence);
 await db.exec(`UPDATE public.papers SET integrity_status='corrected',related_notices='[{"pmid":"20001","relation":"ErratumIn"}]' WHERE id=1`);
 await publish();assert.equal((await db.query('SELECT summary_review_required FROM public.papers WHERE id=1')).rows[0].summary_review_required,true);
 await user(b);await assert.rejects(db.query('SELECT public.admin_integrity_review()'));
 await db.query(`UPDATE public.saved_searches SET filters='{"year":"invalid","until":"-12"}'`);await db.query('SELECT public.search_notifications()');
 await user(a);await assert.rejects(db.query('SELECT public.admin_integrity_review(1,$1,$2)',['stale','Reviewed updated original and notice.']));
 await db.query('SELECT public.admin_integrity_review(1,$1,$2)',[hash,'Reviewed updated original and linked notice.']);
 await db.exec('RESET ROLE');assert.equal((await db.query('SELECT summary_review_required FROM public.papers WHERE id=1')).rows[0].summary_review_required,false);
 await db.exec(`INSERT INTO public.papers(id,pmid,title,pub_date,abstract) VALUES(3,'10003','Veterans Affairs and repair','2026-01-01','Available trials'),(4,'10004','AI-assisted diagnosis','2026-01-01','Artificial intelligence');UPDATE public.papers SET integrity_status='retracted' WHERE id=1;`);
 await user(a);assert.equal((await db.query("SELECT public.search_papers('AI') r")).rows[0].r.items[0].pmid,'10004');assert.equal((await db.query("SELECT public.search_papers('AI') r")).rows[0].r.total,1);
 assert.equal((await db.query('SELECT public.reader_daily() r')).rows[0].r.length,0);
 await assert.rejects(db.query('SELECT public.admin_integrity_review(1,$1,$2)',[hash,'Retraction must remain excluded.']));
 await db.exec("RESET ROLE;UPDATE public.papers SET title='Changed title' WHERE id=1");
  assert.deepEqual((await db.query('SELECT evidence FROM public.papers WHERE id=1')).rows[0].evidence,{});
  // Exact date filtering must apply before totals and pagination, not to a page
  // selected with year-only filters. All fixtures remain in this isolated engine.
  await db.exec(`INSERT INTO public.papers(id,pmid,title,journal,pub_date,abstract)
    SELECT 100+n,(30000+n)::text,'Prostate date fixture '||n,'The Journal of Urology',date '2026-01-01'+(n-1),'Cohort results'
    FROM generate_series(1,25) n;
    INSERT INTO public.papers(id,pmid,title,journal,pub_date,abstract) VALUES
    (200,'30200','Prostate date after','The Journal of Urology','2026-02-01','Cohort'),
    (201,'30201','Prostate date before','The Journal of Urology','2025-12-31','Cohort'),
    (202,'30202','Prostate historical','The Journal of Urology','1999-12-31','Cohort'),
    (203,'30203','Prostate other journal','Other Journal','2026-01-10','Cohort'),
    (204,'30204','Historical-only journal','Historical Only','1999-12-31','Cohort');
    INSERT INTO public.papers(id,pmid,title,journal,pub_date)
    SELECT 300+n,(30300+n)::text,'Autocomplete fixture','Journal fixture '||n,'2026-01-01' FROM generate_series(1,35) n;`);
  await user(a);
  const rangeArgs={p_query:'prostate',p_from:'2026-01-03',p_to:'2026-01-24',p_journal:'the journal OF urology'};
  const searchV2=async(args={})=>{
    const entries=Object.entries(args);
    return (await db.query('SELECT public.search_papers_v2('+entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')+') r',entries.map(([,value])=>value))).rows[0].r;
  };
  const range=await searchV2(rangeArgs);
  assert.equal(range.total,22);assert.equal(range.items.length,20);
  assert.equal(range.items[0].pmid,'30024');
  const lastPage=await searchV2({...rangeArgs,p_page:1});
  assert.equal(lastPage.total,22);assert.deepEqual(lastPage.items.map(p=>p.pmid),['30004','30003']);
  assert.equal((await searchV2({...rangeArgs,p_page:2})).items.length,0);
  assert.deepEqual((await searchV2({...rangeArgs,p_from:'2026-01-10',p_to:'2026-01-10'})).items.map(p=>p.pmid),['30010']);
  assert.equal((await searchV2({...rangeArgs,p_sort:'oldest'})).items[0].pmid,'30003');
  assert.equal((await searchV2({...rangeArgs,p_journal:'Urology'})).total,0);
  assert.equal((await searchV2({...rangeArgs,p_state:'ready'})).total,0);
  assert.equal((await searchV2({...rangeArgs,p_state:'pending'})).total,22);
  assert.equal((await searchV2({p_query:'30202'})).total,0);
  assert.equal((await searchV2({p_query:'AI'})).total,1);
  assert.equal((await searchV2({p_query:'AI'})).items[0].pmid,'10004');
  assert.equal((await searchV2({p_query:'https://doi.org/10.1000/other'})).items[0].pmid,'10002');
  assert.equal((await searchV2({p_query:'10001'})).total,0);
  assert.equal((await searchV2({p_query:'10001',p_integrity:'all'})).total,1);
  for(const invalid of [{p_from:'1999-12-31'},{p_to:'3001-01-01'},{p_from:'2026-02-01',p_to:'2026-01-01'},
    {p_from:null},{p_page:-1},{p_state:'invalid'},{p_query:'x'.repeat(201)}])
    await assert.rejects(searchV2(invalid),{code:'22023'});
  const journals=(await db.query("SELECT public.search_journals('uRoLoGy') r")).rows[0].r;
  assert.deepEqual(journals,[{name:'The Journal of Urology'}]);
  assert.deepEqual((await db.query("SELECT public.search_journals('historical only') r")).rows[0].r,[]);
  assert.deepEqual((await db.query("SELECT public.search_journals('%') r")).rows[0].r,[]);
  const boundedJournals=(await db.query('SELECT public.search_journals() r')).rows[0].r;
  assert.equal(boundedJournals.length,30);
  assert.ok(boundedJournals.every(j=>j.name.trim() && Object.keys(j).join(',')==='name'));
  // Stored names can also differ in casing; all exact-name variants must match,
  // while the date boundary still excludes older rows with the same name.
  await db.exec(`RESET ROLE;INSERT INTO public.papers(id,pmid,title,journal,pub_date) VALUES
    (205,'30205','Journal casing fixture','THE JOURNAL OF UROLOGY','2026-01-10'),
    (206,'30206','Journal casing fixture','The Journal of Urology','2026-01-10'),
    (207,'30207','Journal casing fixture','THE JOURNAL OF UROLOGY','1999-12-31');`);
  await user(a);
  assert.deepEqual((await searchV2({p_query:'casing',p_from:'2026-01-10',p_to:'2026-01-10',p_journal:'the journal of urology'})).items.map(p=>p.pmid),['30206','30205']);
  assert.equal((await searchV2({p_query:'casing',p_journal:'journal of urology'})).total,0);
  assert.deepEqual(new Set((await db.query("SELECT public.search_journals('urology') r")).rows[0].r.map(j=>j.name)),new Set(['THE JOURNAL OF UROLOGY','The Journal of Urology']));
  await db.query("SELECT public.update_reader_state(110,'{\"saved\":true}')");
  assert.equal((await searchV2({...rangeArgs,p_saved:true})).total,1);
  await user(b);assert.equal((await searchV2({...rangeArgs,p_saved:true})).total,0);
  await user(a);
  const filters={from:'2026-01-03',to:'2026-01-24',journal:'THE JOURNAL OF UROLOGY'};
  const savedFilters=[['Exact range',filters],['Date overrides year',{...filters,year:2025,until:2025}],
    ['Legacy year',{year:2026,until:2026,journal:'The Journal of Urology'}],
    ['Invalid calendar',{...filters,from:'2026-02-30'}],['Reversed',{...filters,from:'2026-02-01'}],
    ['Historical',{...filters,from:'1999-01-01'}],['Malformed year',{year:'invalid',until:'-12'}],
    ['Invalid shape',{...filters,from:{year:2026}}],['Invalid state',{...filters,state:'nonsense'}]];
  for(const [name,filter] of savedFilters)await db.query(
    "INSERT INTO public.saved_searches(user_id,name,query,filters,last_seen_at) VALUES($1,$2,'prostate',$3,'2000-01-01')",[a,name,JSON.stringify(filter)]);
  const notifications=(await db.query('SELECT public.search_notifications() r')).rows[0].r;
  const counts=Object.fromEntries(notifications.map(s=>[s.name,s.new_count]));
  assert.equal(counts['Exact range'],22);assert.equal(counts['Date overrides year'],22);assert.equal(counts['Legacy year'],26);
  for(const [name] of savedFilters.slice(3))assert.equal(counts[name],0,name+' must fail safe');
  await db.query("UPDATE public.saved_searches SET enabled=false WHERE name='Exact range'");
  assert.equal((await db.query('SELECT public.search_notifications() r')).rows[0].r.find(s=>s.name==='Exact range').new_count,0);
  await user(b);assert.ok((await db.query('SELECT public.search_notifications() r')).rows[0].r.every(s=>!Object.hasOwn(counts,s.name)));
  await db.exec(`RESET ROLE;INSERT INTO public.papers(id,pmid,title,journal,pub_date,fetched_at,fulltext_available,summary_basis,summary_source_hash,summary_model,summarized_at,summary_ko)
    VALUES(500,'30500','New summary fixture','Summary Journal','2026-01-10','2000-01-01',true,'fulltext',repeat('a',64),'fixture',now(),E'First line\nSecond line\nThird line');`);
  await user(a);
  assert.equal((await searchV2({p_query:'30500',p_from:'2026-01-10',p_to:'2026-01-10',p_state:'ready'})).total,1);
  for(const state of ['all','ready','pending'])await db.query(
    "INSERT INTO public.saved_searches(user_id,name,query,filters,last_seen_at) VALUES($1,$2,'30500',$3,now()-interval '1 day')",
    [a,'Summary state '+state,JSON.stringify({from:'2026-01-10',to:'2026-01-10',state})]);
  const summaryCounts=Object.fromEntries((await db.query('SELECT public.search_notifications() r')).rows[0].r.map(s=>[s.name,s.new_count]));
  assert.equal(summaryCounts['Summary state ready'],1);assert.equal(summaryCounts['Summary state all'],0);assert.equal(summaryCounts['Summary state pending'],0);
  await db.exec("RESET ROLE;SET ROLE anon;SELECT set_config('request.jwt.claim.sub','',false)");
  await assert.rejects(db.query("SELECT public.search_papers('prostate')"));await db.query('SELECT public.preview_papers()');
  await assert.rejects(searchV2({p_query:'prostate'}),{code:'42501'});
  await assert.rejects(db.query('SELECT public.search_journals()'),{code:'42501'});
  await assert.rejects(db.query('SELECT public.search_notifications()'),{code:'42501'});
  await user('');await assert.rejects(searchV2(),{code:'42501'});await assert.rejects(db.query('SELECT public.search_journals()'),{code:'42501'});
  console.log('Reader searches, inclusive date boundaries, journal autocomplete, pagination, AI boundaries, identity isolation, reader/editor sharing, revocation, reports, notifications passed');
} catch(e){console.error(e.message,e.where||'',e.query||'');process.exitCode=1} finally {await db.close()}
