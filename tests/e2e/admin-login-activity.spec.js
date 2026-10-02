import {test,expect} from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";
test("admin separates login and reading timestamps with a contained mobile table",async({page},info)=>{
  await page.route(/https?:\/\//,r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  await page.goto('admin?scenario=admin-login-activity');
  const panel=page.getByRole('region',{name:'User Engagement',exact:true});
  await expect(panel.getByRole('columnheader',{name:'최근 로그인',exact:true})).toBeVisible();
  await expect(panel).toContainText('2026. 10. 02. 00:25');
  await expect(panel).toContainText('2026. 04. 26. 10:00');
  await expect(panel.getByText('기록 없음',{exact:true})).toHaveCount(2);
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:900});
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    const scroll=panel.locator('.overflow-x-auto');
    await scroll.evaluate(el=>{el.scrollLeft=el.scrollWidth;});
    await expect(panel.getByRole('columnheader',{name:'최근 읽기',exact:true})).toBeInViewport();
    expect(await panel.locator('tbody tr').first().evaluate(row=>{
      let end=-Infinity;
      return [...row.cells].every(cell=>{const box=cell.getBoundingClientRect();const good=box.left>=end-1;end=box.right;return good;});
    })).toBe(true);
    await page.screenshot({path:info.outputPath(`admin-logins-${width}.png`)});
  }
  const scan=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(scan.violations).toEqual([]);
});
