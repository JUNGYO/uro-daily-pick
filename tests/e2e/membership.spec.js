import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

test.beforeEach(async ({ page }) => {
  await page.route(/https?:\/\//, route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});

for (const width of [1440, 320]) {
  test(`pending account is gated and admin can review at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/uro-daily-pick/discover?scenario=membership-pending");
    await expect(page.getByRole("heading", { name: "관리자 승인을 기다리고 있습니다" })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await page.getByRole("button", { name: "승인 상태 확인" }).click();
    await expect(page.getByRole("heading", { name: "관리자 승인을 기다리고 있습니다" })).toBeVisible();
    await page.goto("/uro-daily-pick/admin?scenario=admin-membership");
    const panel = page.getByRole("region", { name: "가입 승인", exact: true });
    await expect(panel.getByText("승인 대기 2명")).toBeVisible();
    await expect(page.getByRole("link", { name: "관리자 (2)" })).toBeVisible();
    const verified = panel.getByRole("listitem").filter({ hasText: "new@example.test" });
    const unverified = panel.getByRole("listitem").filter({ hasText: "unverified@example.test" });
    await expect(unverified.getByRole("button", { name: "승인", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include("#membership-review").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`membership-${width}.png`), fullPage: true });
    await verified.getByRole("button", { name: "승인", exact: true }).click();
    await expect(panel.getByText("승인 대기 1명")).toBeVisible();
    await expect(page.getByRole("link", { name: "관리자 (1)" })).toBeVisible();
    await page.getByRole("button", { name: "승인 완료", exact: true }).click();
    await expect(panel.getByText(/신규 연구자/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "승인", exact: true })).toHaveCount(0);
  });
}

test("rejected account sees the administrator note", async ({ page }) => {
  await page.goto("/uro-daily-pick/?scenario=membership-rejected");
  await expect(page.getByRole("heading", { name: "가입이 승인되지 않았습니다" })).toBeVisible();
  await expect(page.getByText("관리자 안내: 소속을 확인할 수 없습니다.")).toBeVisible();
});
