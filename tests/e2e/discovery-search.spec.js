import {
  test,
  expect,
} from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

test.beforeEach(async ({ page }) => {
  await page.route(/https?:\/\//, (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
});

for (const width of [1440, 320]) {
  test(`keyword, journal and inclusive day range work together at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 320 ? 900 : 1000 });
    await page.goto("/uro-daily-pick/discover?scenario=search-filters");
    const form = page.getByRole("form", { name: "문헌 검색 조건" });
    await expect(form.getByLabel("키워드·PMID·DOI")).toBeVisible();
    await expect(form.getByLabel("저널 이름")).toBeVisible();
    await expect(form.getByLabel("시작일")).toBeVisible();
    await expect(form.getByLabel("종료일")).toBeVisible();
    await form.getByLabel("키워드·PMID·DOI").fill("boundary");
    const journal = form.getByRole("combobox", { name: "저널 이름" });
    await journal.fill("European Urol");
    const option = page.getByRole("option", {
      name: "European Urology",
      exact: true,
    });
    await expect(option).toBeVisible();
    if (width === 320) await option.click();
    else {
      await journal.press("ArrowUp");
      await expect(
        page.getByRole("option", {
          name: "European Urology Oncology",
          exact: true,
        }),
      ).toHaveAttribute("aria-selected", "true");
      await journal.press("ArrowDown");
      await journal.press("Enter");
    }
    await expect(journal).toHaveValue("European Urology");
    await form.getByLabel("시작일").fill("2025-01-10");
    await form.getByLabel("종료일").fill("2025-01-20");
    await form.getByRole("button", { name: "검색", exact: true }).click();
    await expect(
      page.getByText("검색 결과 2편 · 1페이지", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Prostate boundary start", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Prostate boundary end", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Prostate (before|after|other)/ }),
    ).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("from")).toBe("2025-01-10");
    expect(new URL(page.url()).searchParams.get("to")).toBe("2025-01-20");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      axe.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
    await page.locator(".reader-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: testInfo.outputPath(`combined-search-${width}.png`),
      fullPage: true,
    });
  });
}

test("date validation, blank conditions and draft reset do not apply stale filters", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/discover");
  await page.getByLabel("키워드·PMID·DOI").fill("unsent draft");
  await page
    .getByRole("combobox", { name: "저널 이름" })
    .fill("unsent journal");
  await page.getByLabel("시작일").fill("2025-01-20");
  await page.getByRole("button", { name: "필터 초기화" }).click();
  await expect(page.getByLabel("키워드·PMID·DOI")).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "저널 이름" })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("시작일")).toHaveValue("");
  await page.goto("/uro-daily-pick/discover?scenario=search-filters");
  const url = page.url();
  await page.getByLabel("시작일").fill("2025-01-20");
  await page.getByLabel("종료일").fill("2025-01-10");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "시작일은 종료일보다 늦을 수 없습니다.",
  );
  await expect(page).toHaveURL(url);
  await page.getByLabel("시작일").fill("");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(
    page.getByText("검색 결과 2편 · 1페이지", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("시작일").fill("2025-01-20");
  await page.getByLabel("종료일").fill("");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(
    page.getByText("검색 결과 2편 · 1페이지", { exact: true }),
  ).toBeVisible();
});

test("search criteria survive pagination, paper return and saved or legacy searches", async ({
  page,
}) => {
  await page.goto(
    "/uro-daily-pick/discover?scenario=search-filters&q=prostate&journal=european%20urology&from=2025-01-10&to=2025-01-20",
  );
  await expect(
    page.getByText("검색 결과 23편 · 1페이지", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "다음 페이지", exact: true }).click();
  await expect(
    page.getByText("검색 결과 23편 · 2페이지", { exact: true }),
  ).toBeVisible();
  const resultUrl = page.url();
  await page.locator("article h2 a").first().click();
  await expect(page).toHaveURL(/\/papers\//);
  await page.goBack();
  await expect(page).toHaveURL(resultUrl);
  await expect(
    page.getByText("검색 결과 23편 · 2페이지", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "검색 저장·새 결과 알림" }).click();
  await expect(page.getByText(/검색을 저장했습니다/)).toBeVisible();
  await page.getByRole("link", { name: "저장된 검색", exact: true }).click();
  const saved = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /^prostate ·/ }) });
  await saved.getByRole("link", { name: "결과 보기" }).click();
  await expect(page.getByLabel("시작일")).toHaveValue("2025-01-10");
  await expect(page.getByLabel("종료일")).toHaveValue("2025-01-20");
  await expect(page.getByRole("combobox", { name: "저널 이름" })).toHaveValue(
    "european urology",
  );
  await expect(
    page.getByText("검색 결과 23편 · 1페이지", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "저장된 검색", exact: true }).click();
  await page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Legacy journal search" }),
    })
    .getByRole("link", { name: "결과 보기" })
    .click();
  await expect(page.getByLabel("시작일")).toHaveValue("2025-01-01");
  await expect(page.getByLabel("종료일")).toHaveValue("2025-12-31");
  await expect(
    page.getByText("검색 결과 2편 · 1페이지", { exact: true }),
  ).toBeVisible();
  await page
    .getByText("상세 검색 · 연구 유형, 요약 상태, 정렬", { exact: true })
    .click();
  await page.getByLabel("연구 유형").selectOption("rct");
  await page.getByLabel("요약 상태").selectOption("ready");
  await page
    .getByRole("combobox", { name: "정렬", exact: true })
    .selectOption("oldest");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(
    page.getByText("검색 결과 1편 · 1페이지", { exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has("year")).toBe(false);
  expect(new URL(page.url()).searchParams.get("sort")).toBe("oldest");
});
