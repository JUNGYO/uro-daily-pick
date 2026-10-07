import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

test.beforeEach(async ({ page }) => {
  // Never create real accounts or send real recovery messages from this fixture.
  await page.route(/https?:\/\//, (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});

for (const width of [1440, 390, 320]) {
  test(`account access stays available at ${width}px with the old email flag disabled`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/uro-daily-pick/login?scenario=signed-out&next=%2Flibrary");
    await expect(page.getByRole("button", { name: "Sign up", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Forgot password?" })).toBeVisible();
    await page.getByLabel("Email", { exact: true }).fill("reader@example.test");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("이메일 또는 비밀번호가 일치하지 않습니다");
    for (const mode of ["signin", "signup", "forgot"]) {
      if (mode === "signup") await page.getByRole("button", { name: "Sign up", exact: true }).click();
      if (mode === "forgot") await page.getByRole("button", { name: "Forgot password?" }).click();
      await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(audit.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${mode}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("status")).toContainText("등록된 이메일이라면");
    await page.getByRole("button", { name: "Back to sign in" }).click();
    await page.getByLabel("Password", { exact: true }).fill("fixture-password");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.locator("main h1")).toBeVisible();
  });
}

test("signup handles immediate sessions and confirmation without an external return", async ({ page }) => {
  await page.goto("/uro-daily-pick/login?scenario=signed-out&mode=signup&next=%2Flibrary");
  await page.getByLabel("Name", { exact: true }).fill("New reader");
  await page.getByLabel("Email", { exact: true }).fill("new@example.test");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page).toHaveURL(/\/library$/);
  await page.goto("/uro-daily-pick/login?scenario=auth-confirmation&mode=signup&next=https%3A%2F%2Fevil.invalid");
  await page.getByLabel("Email", { exact: true }).fill("new@example.test");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("status")).toContainText("confirm your account");
  await expect(page).toHaveURL(/\/login\?/);
});

test("expired recovery links open recovery and mail failures remain visible", async ({ page }) => {
  await page.goto("/uro-daily-pick/reset-password?scenario=auth-mail-failure");
  await page.getByRole("link", { name: "Request another reset link" }).click();
  await expect(page.getByRole("heading", { name: "Reset password" })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("reader@example.test");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("alert")).toContainText("메일 발송 설정 확인");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeEnabled();
});
