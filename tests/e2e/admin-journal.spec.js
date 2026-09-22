import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";

test.beforeEach(async ({ page }) => {
  await page.route(/https?:\/\//, (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
});

test("journal panel shows original counts without citation growth badges", async ({ page }, testInfo) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("admin?scenario=admin");
    const panel = page.getByRole("region", { name: "저널별 원문 확보", exact: true });
    await expect(panel).toContainText("서비스에 반영된 원문");
    await expect(panel.getByText("The Journal of urology", { exact: true }).locator("..")).toContainText("2편");
    await expect(panel.getByText("European urology", { exact: true }).locator("..")).toContainText("1편");
    await expect(panel).not.toContainText("+");
    await expect(page.getByRole("region", { name: "Journals", exact: true })).toHaveCount(0);
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`original-journals-${width}.png`) });
  }
});

test("uninitialized original counts are unavailable rather than zero", async ({ page }) => {
  await page.goto("admin?scenario=admin-counts-initializing");
  const panel = page.getByRole("region", { name: "저널별 원문 확보", exact: true });
  await expect(panel.getByRole("status")).toHaveText("원문 확보 현황을 집계 중입니다.");
  await expect(panel).not.toContainText("확보된 원문이 없습니다");
  await expect(panel).not.toContainText("0편");
});
