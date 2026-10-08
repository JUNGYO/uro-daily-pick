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
 await page.getByRole('button',{name:'prostate cancer, 28 papers',exact:true}).focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('link',{name:'Read knowledge page'})).toBeVisible();
 await expect(page.getByText('12 shared papers',{exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'Read knowledge page'})).toHaveCSS('color','rgb(255, 255, 255)');
 await page.getByLabel('Topic groups').selectOption('a'.repeat(24));
 await expect(page.locator('.knowledge-node-list li')).toHaveCount(2);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const audit=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations).toEqual([]);
 await english(page);await page.screenshot({path:info.outputPath(`map-${width}.png`)});
});
test('stale knowledge hides prose while retaining current paper navigation',async({page})=>{
 await page.goto('/uro-daily-pick/knowledge/'+'a'.repeat(24)+'?scenario=knowledge-stale');
 await expect(page.getByText(/This knowledge page is being updated/)).toBeVisible();
 await expect(page.getByRole('article',{name:'Source-based knowledge'})).toHaveCount(0);
 await expect(page.getByRole('link',{name:'Read full text'})).toHaveCount(3);await english(page);
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
 await expect(page.getByRole('link',{name:'Read full text'})).toHaveCount(3);await english(page);
});
