import {test,expect} from '../../frontend/node_modules/@playwright/test/index.mjs';
import AxeBuilder from '../../frontend/node_modules/@axe-core/playwright/dist/index.mjs';
test.beforeEach(async({page})=>{await page.route(/https?:\/\//,r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());});
for(const width of [1440,320]) test(`research selection survives citations, reading, notes and return at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:1000});
 await page.goto('/uro-daily-pick/insights?scenario=integration-navigation&project=1&returnTo=%2Fprojects%3Fproject%3D1');
 await expect(page.getByLabel('Research context')).toContainText('Journal club');
 await page.getByRole('button',{name:'prostate cancer, 2 papers, Disease',exact:true}).click();
 await expect(page.getByRole('complementary',{name:'Selected research'})).toContainText('2 distinct papers');
 await page.getByRole('button',{name:'Citations',exact:true}).click();
 expect(new URL(page.url()).searchParams.get('scopeConcept')).toBe('a'.repeat(24));
 await expect(page.getByLabel('Research context')).toContainText('prostate cancer');
 await page.getByRole('button',{name:'Explore citations',exact:true}).first().click();
 await page.getByRole('button',{name:'Publication timeline',exact:true}).click();
 await page.getByRole('button',{name:'References',exact:true}).click();
 await expect(page.locator('.citation-list-count')).toContainText('1–20 of 25');
 await page.getByRole('button',{name:'More connections'}).click();
 await expect(page.locator('.citation-list-count')).toContainText('21–25 of 25');
 const map=page.url();
 await page.locator('.citation-selection').getByRole('link',{name:'Save, annotate or add to a project'}).click();
 await page.getByLabel('개인 메모').fill('Compare the outcome definition before including this study.');
 await page.getByRole('button',{name:'메모 저장',exact:true}).click();
 await expect(page.getByText('저장했습니다.',{exact:true})).toBeVisible();
 await page.getByLabel('프로젝트에 추가').selectOption('1');
 await expect(page.getByText('프로젝트 문헌 목록과 선별 대기에 추가했습니다.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'요약',exact:true}).click();
 await page.getByRole('link',{name:'← 목록으로',exact:true}).click();
 expect(page.url()).toBe(map);
 await expect(page.getByRole('button',{name:'Publication timeline',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('.citation-list-count')).toContainText('21–25 of 25');
 await page.getByRole('button',{name:'Concepts',exact:true}).click();
 expect(new URL(page.url()).searchParams.get('concept')).toBe('a'.repeat(24));
 await expect(page.getByRole('group',{name:'Concept map from full texts'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const audit=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa']).analyze();expect(audit.violations).toEqual([]);
 await page.screenshot({path:info.outputPath(`integrated-atlas-${width}.png`)});
});
test('unscoped citation view requires a research starting point',async({page})=>{
 await page.goto('/uro-daily-pick/insights?relation=citations');
 await expect(page.getByRole('heading',{name:'Choose a starting point for citations'})).toBeVisible();
 await expect(page.locator('.citation-node')).toHaveCount(0);
 await page.getByRole('button',{name:'Explore citations',exact:true}).first().click();
 expect(new URL(page.url()).searchParams.get('concept')).toBe('12345670');
});
test('library and project entries keep their scope and return destination',async({page})=>{
 await page.goto('/uro-daily-pick/library?scenario=integration-navigation&tab=notes&q=cohort');
 await page.getByRole('link',{name:'이 서재의 연구 지도',exact:true}).click();
 expect(new URL(page.url()).searchParams.get('library')).toBe('notes');
 expect(new URL(page.url()).searchParams.get('scope_q')).toBe('cohort');
 await expect(page.getByLabel('Research context')).toContainText('Library search: cohort');
 await page.getByRole('link',{name:'Back to reading workspace',exact:false}).click();
 await expect(page).toHaveURL(/library.*tab=notes.*q=cohort/);
 await page.goto('/uro-daily-pick/projects?scenario=integration-navigation&project=1');
 await page.getByRole('link',{name:'프로젝트 연구 지도',exact:true}).click();
 expect(new URL(page.url()).searchParams.get('project')).toBe('1');
 await expect(page.getByLabel('Research context')).toContainText('Journal club');
});
test('collection selection survives its research map round trip',async({page})=>{
 await page.goto('/uro-daily-pick/collections?scenario=integration-navigation&collection=1');
 await page.getByRole('link',{name:'Explore this collection in the research atlas',exact:true}).click();
 expect(new URL(page.url()).searchParams.get('project')).toBe('1');
 await page.getByRole('link',{name:'Back to reading workspace',exact:false}).click();
 await expect(page.getByRole('link',{name:'Explore this collection in the research atlas',exact:true})).toBeVisible();
});

test('daily recommendation and knowledge narrative return to their source',async({page})=>{
 await page.goto('/uro-daily-pick/?scenario=integration-navigation');
 await page.getByRole('link',{name:'인용 지도에서 관련 연구 탐색',exact:true}).first().click();
 expect(new URL(page.url()).searchParams.get('concept')).toBe('12345670');
 await page.getByRole('link',{name:'Back to reading workspace',exact:false}).click();
 await expect(page.getByRole('link',{name:'인용 지도에서 관련 연구 탐색',exact:true}).first()).toBeVisible();
 await page.goto('/uro-daily-pick/insights?scenario=integration-navigation&project=1&concept='+'a'.repeat(24));
 // A corpus narrative is reachable from the original concept panel without losing the map.
 await page.goto('/uro-daily-pick/insights?project=1&concept='+'a'.repeat(24));
 const map=page.url();
 await page.getByRole('link',{name:'Open full knowledge page',exact:false}).click();
 await page.getByRole('link',{name:'Back to research',exact:true}).click();
 expect(page.url()).toBe(map);
});

test('original evidence keeps a durable research return even after reload',async({page})=>{
 await page.goto('/uro-daily-pick/insights?project=1&concept='+'a'.repeat(24));
 const map=page.url();
 await page.getByRole('link',{name:'Read full text ↗',exact:true}).first().click();
 expect(new URL(page.url()).searchParams.get('returnTo')).toContain('/insights?project=1');
 await page.reload();
 await page.locator('main').getByRole('link',{name:/돌아가기|목록으로/}).first().click();
 expect(page.url()).toBe(map);
});
