import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

test.beforeEach(async ({ page }) => {
  await page.route(/https?:\/\//, route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});
async function open(page,scenario="review") { await page.goto(`/uro-daily-pick/projects?scenario=${scenario}&project=1&view=review`); await expect(page.getByRole("heading",{name:"체계적 고찰·메타분석",exact:true})).toBeVisible(); }

for(const width of [1440,390,320])test(`review workflow preserves layout at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});await open(page);
  await expect(page.getByRole("textbox",{name:"연구 질문",exact:true})).toHaveValue("Does treatment reduce mortality?");
  await page.screenshot({path:`test-results/review-protocol-${width}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.getByRole("button",{name:"문헌 선별",exact:true}).click();
  await page.getByRole("button",{name:"선별·출처 기록",exact:true}).first().click();
  await expect(page.getByText("출처 버전 확인됨")).toBeVisible();
  await page.screenshot({path:`test-results/review-screening-${width}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const accessibility=await new AxeBuilder({page}).include('.review-workspace').analyze();
  expect(accessibility.violations.filter(v=>["serious","critical"].includes(v.impact))).toEqual([]);
});

test("analysis selection fills context and freezes exact revisions",async({page})=>{
  await open(page);await page.getByRole("button",{name:"분석·내보내기",exact:true}).click();
  await page.getByRole("checkbox",{name:/Trial 1 · Mortality/}).check();
  await page.getByRole("checkbox",{name:/Trial 2 · Mortality/}).check();
  await expect(page.getByLabel("평가변수",{exact:true})).toHaveValue("Mortality");
  await page.getByRole("button",{name:"입력 고정·계산 요청",exact:true}).click();
  await expect(page.getByText(/계산 대기 ·/)).toBeVisible();
  const call=await page.evaluate(()=>window.__reviewFixture.calls.find(x=>x.name==='review_start_analysis'));
  expect(call.args.p_rows).toHaveLength(2);expect(call.args.p_rows.every(x=>x.revision===1)).toBe(true);expect(call.args.p_config.timepoint).toBe("12 months");
});

test("peer review remains an honest placeholder without credential persistence",async({page})=>{
  await open(page);await page.getByRole("button",{name:"리뷰",exact:true}).click();
  await expect(page.getByText("미실시 · 검토 기능 준비 중")).toBeVisible();
  await expect(page.getByText("미연결 · 검토 기능 준비 중")).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  const keys=await page.evaluate(()=>[...Object.keys(localStorage),...Object.keys(sessionStorage)]);
  expect(keys.some(k=>/api.?key|gemini|openai/i.test(k))).toBe(false);
});

test("existing project library imports with supported search provenance",async({page})=>{
  await open(page);
  await page.getByRole("button",{name:"검색·가져오기",exact:true}).click();
  await page.getByRole("button",{name:"프로젝트 문헌 가져오기",exact:true}).click();
  await expect(page.getByText("저장했습니다.",{exact:true})).toBeVisible();
  const calls=await page.evaluate(()=>window.__reviewFixture.calls);
  const searches=calls.filter(x=>x.name==='review_save_search');
  expect(searches.length).toBeGreaterThan(0);
  const allowed=['import_format','journal','from','to','topic','kind','keywords','page','language','date_field','coverage_note'];
  for(const search of searches){
    expect(search.args.p_payload.source).toBe('Project library');
    expect(Object.keys(search.args.p_payload.limits).every(k=>allowed.includes(k))).toBe(true);
    expect(search.args.p_payload.status).toBe('partial');
  }
  expect(calls.some(x=>x.name==='review_import_records'&&x.args.p_items.length>0)).toBe(true);
});

test("switching populated review stages never renders the previous record type",async({page})=>{
  await open(page);
  await page.getByRole("button",{name:"검색·가져오기",exact:true}).click();
  await expect(page.getByRole("heading",{name:"PubMed",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"분석·내보내기",exact:true}).click();
  await expect(page.getByRole("checkbox",{name:/Trial 1 · Mortality/})).toBeVisible();
  await page.getByRole("button",{name:"문헌 선별",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Trial 1 on treatment outcomes",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"데이터 추출",exact:true}).click();
  await expect(page.getByRole("button",{name:"수치·근거 열기",exact:true}).first()).toBeVisible();
  await page.getByRole("button",{name:"검색·가져오기",exact:true}).click();
  await expect(page.getByRole("heading",{name:"PubMed",exact:true})).toBeVisible();
  await expect(page.getByText("화면을 불러오지 못했습니다",{exact:true})).toHaveCount(0);
});

test("project reader cannot submit protocols or numerical analysis",async({page})=>{
  await open(page,"review-reader");await expect(page.getByRole("button",{name:"연구계획 저장"})).toBeDisabled();
  await page.getByRole("button",{name:"분석·내보내기",exact:true}).click();
  await expect(page.getByRole("button",{name:"입력 고정·계산 요청"})).toBeDisabled();
});

test("discovery transfers selected metadata and records the actual search scope",async({page})=>{
  await page.goto('/uro-daily-pick/discover?scenario=review&q=prostate');
  await page.getByRole("button",{name:"연구 프로젝트로 가져오기",exact:true}).click();
  await page.getByLabel("대상 프로젝트").selectOption("1");
  await page.getByRole("button",{name:"이 페이지 선택",exact:true}).click();
  await page.getByRole("button",{name:/선택 \d+편 가져오기/}).click();
  await expect(page.getByRole("link",{name:"프로젝트에서 선별하기"})).toBeVisible();
  const calls=await page.evaluate(()=>window.__reviewFixture.calls);
  const search=calls.find(x=>x.name==='review_save_search');expect(search.args.p_payload.status).toBe('partial');expect(search.args.p_payload.query).toContain('prostate');
  const imported=calls.find(x=>x.name==='review_import_records');expect(imported.args.p_items.length).toBeGreaterThan(0);
});
