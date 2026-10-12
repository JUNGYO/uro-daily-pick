import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";
test.beforeEach(async ({ page }) => {
  await page.route(/https?:\/\//, route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});
for (const width of [1440, 320]) {
  test(`administrator enrollment and verification at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/uro-daily-pick/admin?scenario=admin-mfa-enroll");
    await expect(page.getByRole("heading", { name: "관리자 2단계 인증" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toHaveCount(0);
    await page.getByRole("button", { name: "인증 앱 등록 시작" }).click();
    await expect(page.getByAltText("인증 앱 등록 QR 코드")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include('[aria-labelledby="admin-mfa-title"]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    // This is a synthetic factor, never a real enrollment secret.
    await page.screenshot({ path: testInfo.outputPath(`synthetic-admin-mfa-${width}.png`), fullPage: true });
    await page.getByLabel("인증 앱의 6자리 번호").fill("111111");
    await page.getByRole("button", { name: "인증하고 관리자 화면 열기" }).click();
    await expect(page.getByRole("alert")).toContainText("인증번호가 맞지 않습니다");
    await expect(page.getByLabel("인증 앱의 6자리 번호")).toHaveValue("");
    await page.getByLabel("인증 앱의 6자리 번호").fill("222222");
    await page.getByRole("button", { name: "인증하고 관리자 화면 열기" }).click();
    await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toBeVisible();
    await expect(page.getByAltText("인증 앱 등록 QR 코드")).toHaveCount(0);
  });
}
test("existing factor challenges without reenrollment; server denial stays closed", async ({ page }) => {
  await page.goto("/uro-daily-pick/admin?scenario=admin-mfa-challenge");
  await expect(page.getByLabel("인증 앱의 6자리 번호")).toBeVisible();
  await expect(page.getByRole("button", { name: "인증 앱 등록 시작" })).toHaveCount(0);
  await page.getByLabel("인증 앱의 6자리 번호").fill("222222");
  await page.getByRole("button", { name: "인증하고 관리자 화면 열기" }).click();
  await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toBeVisible();
  await page.goto("/uro-daily-pick/admin?scenario=admin-mfa-server-denied");
  await page.getByLabel("인증 앱의 6자리 번호").fill("222222");
  await page.getByRole("button", { name: "인증하고 관리자 화면 열기" }).click();
  await expect(page.getByRole("alert")).toContainText("인증 상태를 확인하지 못했습니다");
  await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toHaveCount(0);
});
