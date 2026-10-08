import {test,expect} from '../../frontend/node_modules/@playwright/test/index.mjs';
import AxeBuilder from '../../frontend/node_modules/@axe-core/playwright/dist/index.mjs';
test.beforeEach(async({page})=>{
 await page.route(/https?:\/\//,r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
});
for(const width of [1440,390,320]) test(`reading and successful use remain distinct at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:900});await page.clock.install();
 await page.goto('/uro-daily-pick/?scenario=admin-reader-opens');await page.bringToFront();
 const sessions=()=>page.evaluate(()=>globalThis.__uroFixtureSnapshot().content_sessions);
 await expect(page.getByRole('button',{name:/Personalized treatment strategies/})).toBeVisible();
 await page.clock.runFor(10000);expect(await sessions()).toEqual([]);
 await page.getByRole('button',{name:/Personalized treatment strategies/}).click();
 await page.locator('.reader-summary').scrollIntoViewIfNeeded();await page.clock.runFor(34000);
 await expect.poll(async()=>Math.max(0,...(await sessions()).filter(s=>s.kind==='summary').map(s=>s.seconds))).toBeGreaterThanOrEqual(30);
 await page.route('https://articles.example.test/v1/fulltext/*',r=>r.fulfill({json:{pmid:'12345670',title:'Usage original fixture',content_text:'This is synthetic original reading content. '.repeat(150),content_hash:'a'.repeat(64),figures:[]}}));
 await page.locator('a.today-original[href*="/fulltext/"]').click();
 await expect(page.getByRole('article')).toBeVisible();await page.clock.runFor(64000);
 await expect.poll(async()=>Math.max(0,...(await sessions()).filter(s=>s.kind==='original').map(s=>s.seconds))).toBeGreaterThanOrEqual(60);
 await page.getByRole('link',{name:'논문 상세로 돌아가기',exact:true}).click();
 // The explicit route is retained in fixture state; use the existing detail path for a real save.
 await page.getByRole('link',{name:/Personalized treatment strategies/}).filter({visible:true}).first().click();
 await page.getByRole('button',{name:'내 서재에 저장',exact:true}).click();
 await page.getByRole('link',{name:'관리자',exact:true}).filter({visible:true}).click();
 const panel=page.getByRole('region',{name:'열람·활용',exact:true});await panel.scrollIntoViewIfNeeded();
 await expect(panel.getByRole('columnheader',{name:'요약 열람'})).toBeVisible();
 await expect(panel.getByText('Usage fixture',{exact:true})).toBeVisible();
 await expect(panel.getByRole('img',{name:'날짜별 열람과 활용 사용자 수'})).toBeVisible();
 await page.getByRole('button',{name:'최근 30일',exact:true}).click();
 await expect(panel.locator('[role="img"] > div')).toHaveCount(30);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const audit=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations).toEqual([]);
 await panel.getByRole("img").scrollIntoViewIfNeeded();
 await page.screenshot({path:info.outputPath(`usage-${width}.png`)});
});
test('failed full text never becomes a successful original view',async({page})=>{
 await page.clock.install();await page.route('https://articles.example.test/v1/fulltext/*',r=>r.fulfill({status:503,json:{error:'Unavailable'}}));
 await page.goto('/uro-daily-pick/fulltext/12345670?scenario=admin-reader-opens');
 await expect(page.getByRole('alert')).toBeVisible();await page.clock.runFor(65000);
 expect(await page.evaluate(()=>globalThis.__uroFixtureSnapshot().content_sessions)).toEqual([]);
});
