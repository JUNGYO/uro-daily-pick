import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

test.beforeEach(async ({ page }) => {
  await page.route(/https?:\/\//, (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
});

for (const width of [1440, 390, 320]) {
  test(`reading keeps citations out of the text at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/uro-daily-pick/?scenario=reading-evidence");
    if (width < 768) await page.getByRole("button", { name: /Personalized treatment/ }).click();
    const article = page.getByRole("article", { name: "선택한 논문" });
    await expect(article.locator(".reader-summary li")).toHaveCount(3);
    await article.locator(".today-study > summary").click();
    await expect(article.locator(".today-study")).toHaveAttribute("open", "");
    await expect(article.locator(".today-facts").first().locator("dt")).toHaveText([
      "Design:", "N:", "Pop:", "Key:",
    ]);
    await expect(article.locator(".today-qa")).toBeVisible();
    await expect(article.locator(".reader-summary a, .today-facts a, .today-qa a")).toHaveCount(0);
    await expect(article.getByText("추가 연구 정보", { exact: true })).toHaveCount(0);
    await expect(article.getByText("요약·연구 근거 보기", { exact: true })).toHaveCount(0);
    await expect(article.locator(".reading-evidence, .today-extra-study")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "원문·표·그림", exact: true })).toBeVisible();
    expect(await article.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("reading-restored.png"), fullPage: true });
    await page.getByRole("button", { name: "다음 논문", exact: true }).click();
    await expect(article.getByText("요약·연구 근거 보기", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "이전 논문", exact: true }).click();
    await expect(article.locator(".reading-evidence")).toHaveCount(0);
  });
}

test("paper tabs remove unsolicited disclosures and retain original access", async ({ page }) => {
  await page.goto("/uro-daily-pick/papers/12345670?scenario=reading-evidence");
  await expect(page.locator(".reader-summary a")).toHaveCount(0);
  await expect(page.getByText("요약·연구 근거 보기", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "연구 상세·Q&A", exact: true }).click();
  await expect(page.locator(".reader-facts a, .reading-qa a, .reading-evidence")).toHaveCount(0);
  await expect(page.getByText("추가 연구 정보", { exact: true })).toHaveCount(0);
  await page.goto("/uro-daily-pick/papers/12345670?scenario=reading-evidence-no-access");
  await expect(page.getByText("요약·연구 근거 보기", { exact: true })).toHaveCount(0);
  await expect(page.locator(".reader-summary li")).toHaveCount(3);
});
