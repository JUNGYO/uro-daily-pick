import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";
test.beforeEach(async ({ page }) => {
  await page.route(/https?:\/\//, route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});
test("notice queue stays compact, paginates and filters without hiding access to notices", async ({ page }, testInfo) => {
  await page.goto("admin?scenario=admin-integrity");
  const panel=page.getByRole("region",{name:"정정·철회 확인",exact:true});
  await expect(panel).toContainText("정정 19편 · 우려 공지 2편 · 철회 2편");
  await expect(panel.locator("details")).toHaveCount(0);
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:900});await panel.scrollIntoViewIfNeeded();
    expect(await panel.evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`notice-compact-${width}.png`)});
  }
  await panel.getByRole("button",{name:"목록 보기"}).click();
  await expect(panel.locator("details")).toHaveCount(10);
  await panel.getByRole("button",{name:"다음",exact:true}).click();
  await expect(panel).toContainText("2 / 3");
  await panel.getByLabel("공지 유형").selectOption("corrected");
  await expect(panel).toContainText("1 / 2");await expect(panel.locator("details")).toHaveCount(10);
  await panel.locator("summary").first().click();
  await expect(panel.getByRole("link",{name:"공지 원문 · PMID 904"})).toHaveAttribute("href","https://pubmed.ncbi.nlm.nih.gov/904/");
  await expect(panel.getByRole("button",{name:"검토 완료 기록"})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath("notice-expanded-320.png")});
  await panel.getByLabel("공지 유형").selectOption("retracted");
  await expect(panel.locator("details")).toHaveCount(2);
  await panel.locator("summary").first().click();
  await expect(panel.getByRole("button",{name:"검토 완료 기록"})).toHaveCount(0);
  await panel.getByRole("button",{name:"목록 접기"}).click();
  await expect(panel.locator("details")).toHaveCount(0);
});
