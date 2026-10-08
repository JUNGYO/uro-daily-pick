import {test,expect} from '../../frontend/node_modules/@playwright/test/index.mjs';
import AxeBuilder from '../../frontend/node_modules/@axe-core/playwright/dist/index.mjs';
test.beforeEach(async({page})=>{await page.route(/https?:\/\//,r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());});
const english = async(page) => {
 const area=page.locator('main [lang="en"]').first();
 await expect(area).toBeVisible();
 expect(await area.innerText()).not.toMatch(/[가-힣]/);
};
for(const width of [1440,390,320]) test(`knowledge search, original-bound wiki and map at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:900});
 await page.goto('/uro-daily-pick/discover');
 await page.getByRole('link',{name:'Knowledge Explorer',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Knowledge Explorer',exact:true})).toBeVisible();
 await page.getByLabel('Search concepts, conditions and treatments').fill('prostate');await page.getByRole('button',{name:'Search',exact:true}).click();
 await expect(page.locator('.knowledge-card')).toHaveCount(1);await english(page);
 await page.getByRole('link',{name:'prostate cancer',exact:true}).click();
 await expect(page.getByRole('article',{name:'Source-based knowledge'})).toBeVisible();
 await expect(page.getByRole('link',{name:'Source · PMID 12345670'})).toHaveAttribute('href',/source=a{64}#p-0000000/);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await english(page);await page.screenshot({path:info.outputPath(`wiki-${width}.png`)});
 await page.getByRole('link',{name:'Literature Map',exact:true}).click();
 await expect(page.getByRole('group',{name:'Concept map from full texts'})).toBeVisible();
 await page.getByRole('button',{name:'prostate cancer, 28 papers, Disease',exact:true}).focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('link',{name:'Open full knowledge page'})).toBeVisible();
 await expect(page.getByRole('article',{name:'Source-based knowledge'})).toBeVisible();
 await page.getByRole('button',{name:'Show accessible concept list'}).click();
 await expect(page.locator('.atlas-node-list li')).toHaveCount(3);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const audit=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations).toEqual([]);
 await english(page);await page.screenshot({path:info.outputPath(`map-${width}.png`)});
});
test('stale knowledge hides prose while retaining current paper navigation',async({page})=>{
 await page.goto('/uro-daily-pick/knowledge/'+'a'.repeat(24)+'?scenario=knowledge-stale');
 await expect(page.getByText(/This knowledge page is being updated/)).toBeVisible();
 await expect(page.getByRole('article',{name:'Source-based knowledge'})).toHaveCount(0);
 await expect(page.getByRole('link',{name:/Read full text/})).toHaveCount(3);await english(page);
});
test('empty and failed knowledge have honest independent states',async({page})=>{
 await page.goto('/uro-daily-pick/knowledge?scenario=knowledge-empty');
 await expect(page.getByText(/Indexed full texts: 0/)).toBeVisible();
 await expect(page.locator('.knowledge-card')).toHaveCount(0);
 await page.goto('/uro-daily-pick/knowledge?scenario=knowledge-error');
 await expect(page.getByRole('alert')).toContainText('Unable to load knowledge. Please try again.');await expect(page.getByRole('button',{name:'Try again'})).toBeVisible();await english(page);
 await expect(page.getByRole('link',{name:'Discover',exact:true}).last()).toBeVisible();
});

test('indexed concepts without findings offer originals without promising a pending page',async({page})=>{
 await page.goto('/uro-daily-pick/knowledge/'+'a'.repeat(24)+'?scenario=knowledge-indexed');
 await expect(page.getByRole('status')).toContainText('not yet enough verified findings for a narrative page');
 await expect(page.getByRole('article',{name:'Source-based knowledge'})).toHaveCount(0);
 await expect(page.getByRole('link',{name:/Read full text/})).toHaveCount(3);await english(page);
});

for(const width of [1440,830,390,320]) test(`atlas opens with visible graph and connected scientific records at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:1000});await page.goto('/uro-daily-pick/insights');
 await expect(page.getByRole('heading',{name:'Research atlas',exact:true})).toBeVisible();
 await expect(page.getByRole('group',{name:'Concept map from full texts'})).toBeVisible();
 await expect(page.getByRole('link',{name:'My activity',exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath(`atlas-initial-${width}.png`)});
 await page.getByRole('button',{name:'prostate cancer, 28 papers, Disease',exact:true}).click();
 await expect(page.getByRole('complementary',{name:'Selected research'}).getByRole('heading',{name:'prostate cancer'})).toBeVisible();
 await expect(page.getByRole('article',{name:'Source-based knowledge'})).toBeVisible();
 await page.getByRole('button',{name:'Filters',exact:true}).click();
 await page.getByRole('combobox',{name:'Journal',exact:true}).selectOption('European urology');
 await page.getByLabel('From year').selectOption('2024');await page.getByLabel('To year').selectOption('2024');
 await expect(page.locator('.atlas-status')).toContainText('1 matching papers');
 await page.getByRole('button',{name:'Research record',exact:true}).first().click();
 await expect(page.getByRole('region',{name:'Reported results'})).toContainText('0.70');
 await expect(page.getByRole('region',{name:'Bibliographic record'})).toContainText('year precision');
 await expect(page.getByRole('region',{name:'Study context'})).toContainText('Not extracted');
 await page.getByText('Sources and extraction record',{exact:true}).click();
 await expect(page.getByText(/Not human reviewed/)).toBeVisible();
 await expect(page.getByText(/Candidate links only/)).toBeVisible();
 await expect(page.locator('.atlas-science').getByRole('link',{name:'View source'}).first()).toHaveAttribute('href',/source=a{64}#p-0000000/);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath(`atlas-record-${width}.png`)});
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();
 await page.getByRole('button',{name:'Citations',exact:true}).click();
 await expect(page.locator('.atlas-graph-note')).toContainText('Arrows follow');
 await page.getByRole('button',{name:'Zoom in'}).click();await page.getByRole('button',{name:'Reset graph view'}).click();
 const audit=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations).toEqual([]);
 await english(page);
 await page.getByRole('link',{name:'My activity',exact:true}).click();await expect(page.getByRole('heading',{name:'Research Insights'})).toBeVisible();
});

test('atlas filters survive reload, empty results and failures remain actionable',async({page})=>{
 await page.goto('/uro-daily-pick/insights?from=2024&to=2024&journal=European%20urology');
 await expect(page.locator('.atlas-status')).toContainText('1 matching papers');await page.reload();await expect(page.locator('.atlas-status')).toContainText('1 matching papers');
 await page.getByLabel('Search concepts, papers or identifiers').fill('no-such-concept');await page.getByRole('button',{name:'Search',exact:true}).click();
 await expect(page.getByText('No indexed papers match these filters.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Clear filters',exact:true}).first().click();await expect(page.getByRole('group',{name:'Concept map from full texts'})).toBeVisible();
 await page.goto('/uro-daily-pick/insights?scenario=knowledge-error');await expect(page.getByRole('alert')).toContainText('Unable to load research');
});

test('dense atlas keeps labels separate on desktop and exposes all concepts on mobile',async({page},info)=>{
 await page.setViewportSize({width:1440,height:1000});await page.goto('/uro-daily-pick/insights?scenario=atlas-dense');
 await expect(page.locator('.atlas-node')).toHaveCount(24);
 await page.locator('.atlas-graph').scrollIntoViewIfNeeded();
 const bounds=await page.locator('.atlas-node text').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};}));
 for(let i=0;i<bounds.length;i++)for(let j=i+1;j<bounds.length;j++){const a=bounds[i],b=bounds[j];expect(a.right<=b.x||b.right<=a.x||a.bottom<=b.y||b.bottom<=a.y).toBe(true);}
 await page.screenshot({path:info.outputPath('atlas-dense-desktop.png')});
 await page.setViewportSize({width:390,height:1000});await expect(page.locator('.atlas-node')).toHaveCount(24);
 await page.locator('.network-canvas-scroll').scrollIntoViewIfNeeded();
 await page.screenshot({path:info.outputPath('atlas-dense-mobile.png')});
 await page.getByRole('button',{name:'Show accessible concept list'}).click();await expect(page.locator('.atlas-node-list li')).toHaveCount(24);
});

test('connection selection shows its papers and exports reproducible data',async({page})=>{
 await page.goto('/uro-daily-pick/insights');
 const link=page.getByRole('button',{name:'prostate cancer and active surveillance: 12 shared papers',exact:true});
 await link.focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('complementary',{name:'Selected research'})).toContainText('Jaccard overlap');
 await expect(page.getByRole('complementary',{name:'Selected research'})).toContainText('0.375');
 await expect(page.getByRole('heading',{name:'Papers behind this connection'})).toBeVisible();
 await expect(page).toHaveURL(/with=/);
 await page.getByLabel('Minimum shared papers').selectOption('3');await page.reload();
 await expect(page.getByLabel('Minimum shared papers')).toHaveValue('3');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export data'}).click();
 const file=await download;expect(file.suggestedFilename()).toBe('research-network.json');
 const stream=await file.createReadStream();const chunks=[];for await (const part of stream)chunks.push(part);
 const result=JSON.parse(Buffer.concat(chunks).toString());expect(result.filters.min_shared).toBe(3);expect(result.nodes).toHaveLength(3);expect(result.edges[0].weight).toBe(12);
});

test('atlas reflects new indexed papers without losing the selected wiki or graph view',async({page})=>{
 await page.clock.install();
 await page.goto('/uro-daily-pick/insights?scenario=atlas-live&concept='+'a'.repeat(24));
 await expect(page.locator('.atlas-status')).toContainText('30 full texts indexed');
 await expect(page.getByRole('article',{name:'Source-based knowledge'})).toBeVisible();
 await page.getByRole('button',{name:'Zoom in'}).click();
 await page.getByRole('button',{name:'Research record',exact:true}).first().click();
 await expect(page.getByRole('region',{name:'Bibliographic record'})).toBeVisible();
 const transform=await page.locator('svg.atlas-graph > g').first().getAttribute('transform');
 await page.clock.runFor(30050);
 await expect(page.locator('.atlas-status')).toContainText('31 full texts indexed');
 await expect(page.getByRole('article',{name:'Source-based knowledge'})).toBeVisible();
 await expect(page.getByRole('region',{name:'Bibliographic record'})).toBeVisible();
 expect(await page.locator('svg.atlas-graph > g').first().getAttribute('transform')).toBe(transform);
 await expect(page.getByLabel('Knowledge refresh')).toContainText('Refreshes automatically');
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await expect(page.locator('.atlas-status')).toContainText('32 full texts indexed');
});
