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
    await expect(panel.getByText("원문 열람: 차단")).toBeVisible();
    await panel.getByRole("button", { name: "원문 권한 부여" }).click();
    await expect(panel.getByRole("group", { name: "new@example.test 원문 권한 변경 확인" })).toContainText("가입 승인과 별도로 적용됩니다");
    await panel.getByRole("button", { name: "취소", exact: true }).click();
    await expect(panel.getByText("원문 열람: 차단")).toBeVisible();
    await panel.getByRole("button", { name: "원문 권한 부여" }).click();
    await panel.getByRole("button", { name: "변경 확인" }).click();
    await expect(panel.getByText("원문 열람: 허용")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "new@example.test: 원문 열람 권한을 부여했습니다." })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include("#membership-review").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`original-access-${width}.png`) });
    await panel.getByRole("button", { name: "원문 권한 회수" }).click();
    await expect(panel.getByText(/이미 열린 내용은 회수할 수 없습니다/)).toBeVisible();
    await panel.getByRole("button", { name: "변경 확인" }).click();
    await expect(panel.getByText("원문 열람: 차단")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "new@example.test: 원문 열람 권한을 회수했습니다." })).toBeVisible();
  });
}

test("rejected account sees the administrator note", async ({ page }) => {
  await page.goto("/uro-daily-pick/?scenario=membership-rejected");
  await expect(page.getByRole("heading", { name: "가입이 승인되지 않았습니다" })).toBeVisible();
  await expect(page.getByText("관리자 안내: 소속을 확인할 수 없습니다.")).toBeVisible();
});
