import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
const admin='00000000-0000-0000-0000-000000000001',reader='00000000-0000-0000-0000-000000000002';
async function user(id){await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('SET ROLE authenticated');}
const call=async(status='all',page=0)=>(await db.query('SELECT public.admin_integrity_queue($1,$2) r',[status,page])).rows[0].r;
try{
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon;`);
 for(const f of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())
  await db.exec((await readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
 await db.exec(`INSERT INTO auth.users VALUES('${admin}','crazyslime@gmail.com',now(),'{}'),('${reader}','reader@example.test',now(),'{}');
 INSERT INTO public.papers(id,pmid,title,pub_date,integrity_status,summary_review_required)
 SELECT i,(10000+i)::text,'Fixture '||i,'2026-01-01',CASE WHEN i<=2 THEN 'retracted' WHEN i<=4 THEN 'concern' ELSE 'corrected' END,true FROM generate_series(1,123)s(i);
 INSERT INTO public.papers(id,pmid,title,pub_date,integrity_status,summary_review_required) VALUES
 (200,'10200','Reviewed correction','2026-01-01','corrected',false),(201,'10201','Unflagged current','2026-01-01','current',true);`);
 await user(reader);await assert.rejects(call(),{code:'42501'});
 await user('');await assert.rejects(call(),{code:'42501'});
 await db.exec('RESET ROLE;SET ROLE anon');await assert.rejects(call(),{code:'42501'});
 await user(admin);let r=await call();
 assert.deepEqual(r.counts,{total:123,corrected:119,concern:2,retracted:2});
 assert.equal(r.items.length,10);assert.equal(r.page_size,10);
 assert.deepEqual(r.items.slice(0,4).map(p=>p.integrity_status),['retracted','retracted','concern','concern']);
 const ids=[];for(let page=0;page<13;page++)ids.push(...(await call('all',page)).items.map(p=>p.id));
 assert.equal(ids.length,123);assert.equal(new Set(ids).size,123,'No truncation at the former 100-record limit');
 r=await call('corrected',999999);assert.equal(r.page,11);assert.equal(r.items.length,9);assert.equal(r.total,119);
 assert.ok(r.items.every(p=>p.integrity_status==='corrected'));assert.equal((await call('concern',-1)).page,0);
 await assert.rejects(call('invalid'),{code:'22023'});
 await db.exec('RESET ROLE;UPDATE auth.users SET email_confirmed_at=NULL WHERE id=\''+admin+'\'');
 await user(admin);await assert.rejects(call(),{code:'42501'});
 await db.exec('RESET ROLE;DELETE FROM public.papers;UPDATE auth.users SET email_confirmed_at=now();BEGIN READ ONLY');
 await user(admin);r=await call();assert.equal(r.total,0);assert.equal(r.page,0);assert.deepEqual(r.items,[]);
 await db.exec('COMMIT');
 console.log('Administrative integrity queue: authorization, complete counts, severity order, filtered pagination, empty state and read-only contract passed.');
}finally{await db.close();}
