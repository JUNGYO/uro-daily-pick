import {test,expect} from '../../frontend/node_modules/@playwright/test/index.mjs';
import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve,sep} from 'node:path';
const base='/uro-daily-pick/';
let server;
test.beforeAll(async()=>{
  const root=pathToFileURL(resolve(__dirname,'../../frontend/dist')+sep),files=new Map();
  for(const name of ['index.html','sw.js',...(await readdir(new URL('assets/',root))).map(n=>'assets/'+n)]) files.set(base+name,await readFile(new URL(name,root)));
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    const name=files.has(path)?path:base+'index.html';
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
    res.end(files.get(name));
  });
  await new Promise(resolve=>server.listen(3102,'127.0.0.1',resolve));
});
test.afterAll(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}});
test('production shell restores only explicit device summaries and logout removes them',async({page,context})=>{
  await page.route(/https?:\/\//,route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto('http://127.0.0.1:3102'+base+'welcome');
  await page.evaluate(async()=>{await navigator.serviceWorker.ready});
  await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller)).toBe(true);
  await page.evaluate(()=>{
    const uid='00000000-0000-0000-0000-000000000001';
    localStorage.setItem('uro-offline-active',uid);
    localStorage.setItem('uro-profile:'+uid,JSON.stringify({id:uid,name:'Offline reader',onboarding_done:true}));
    localStorage.setItem('uro-offline:'+uid,JSON.stringify([{id:1,pmid:'12345670',title:'Offline source summary fixture',authors:['Lee J'],journal:'Synthetic journal',pub_date:'2026-01-01',fulltext_available:true,summary_basis:'fulltext',summary_model:'fixture',summary_source_hash:'a'.repeat(64),summarized_at:new Date().toISOString(),summary_ko:'첫 번째 시험 문장입니다.\n두 번째 시험 문장입니다.\n세 번째 시험 문장입니다.',cached_at:new Date().toISOString()}]));
  });
  await context.setOffline(true);
  await page.goto('http://127.0.0.1:3102'+base+'library?tab=offline');
  await page.getByRole('link',{name:'Offline source summary fixture'}).click();
  await expect(page.getByRole('region',{name:'본문 기반 세 줄 요약'}).locator('ol > li')).toHaveCount(3);
  await expect(page.getByRole('button',{name:'내 서재에 저장'})).toBeDisabled();
  const cacheKeys=await page.evaluate(async()=>{const keys=await caches.keys();return Promise.all(keys.map(async k=>(await (await caches.open(k)).keys()).map(r=>r.url)))});
  expect(cacheKeys.flat().every(url=>url.includes('/assets/')||url.endsWith('/index.html'))).toBe(true);
  await page.getByRole('button',{name:'Logout',exact:true}).click();
  await expect(page).toHaveURL(/login/);
  expect(await page.evaluate(()=>localStorage.getItem('uro-offline-active'))).toBeNull();
  expect(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('uro-offline:')))).toBe(false);
});
