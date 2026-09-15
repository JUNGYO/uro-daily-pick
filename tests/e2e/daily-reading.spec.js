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
const selected = (page) => page.getByRole("article", { name: "선택한 논문" });
const summary = (page) =>
  page.getByRole("region", { name: "본문 기반 세 줄 요약" });

for (const width of [1440, 390, 320]) {
  test(`continuous reading at ${width}px opens all five summaries in four selections`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.goto("/uro-daily-pick/");
    await expect(summary(page).locator("ol>li")).toHaveCount(3);
    await expect(selected(page)).toContainText("Personalized treatment");
    await expect(
      page.getByRole("button", { name: "이전 논문", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "내 서재에 저장", exact: true }),
    ).toBeInViewport();
    if (width === 1440) {
      await expect(
        page.getByRole("complementary", { name: "오늘의 논문 목록" }),
      ).toBeVisible();
      await expect(summary(page).locator("li").last()).toBeInViewport();
    }
    await page.screenshot({
      path: info.outputPath(`daily-${width}.png`),
      fullPage: true,
    });
    for (let i = 0; i < 5; i++) {
      await expect(selected(page)).toContainText("PMID " + (12345670 + i));
      await expect(summary(page).locator("ol>li")).toHaveCount(3);
      await page
        .getByRole("button", { name: "읽음 표시", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "읽음", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".today-position")).toContainText(
        `${i + 1}편 읽음`,
      );
      if (i < 4)
        await page
          .getByRole("button", { name: "다음 논문", exact: true })
          .click();
    }
    await expect(
      page.getByRole("button", { name: "다음 논문", exact: true }),
    ).toBeDisabled();
    await expect(page.getByText("오늘의 5편을 모두 읽었습니다.")).toBeVisible();
    await expect(page).not.toHaveURL(/\/papers\//);
    const a11y = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(a11y.violations).toEqual([]);
  });
}

test("mobile Q&A stays inline; saved state and undo belong to the correct article", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/uro-daily-pick/");
  await page
    .getByRole("button", { name: "내 서재에 저장", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "저장됨", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "다음 논문", exact: true }).click();
  await expect(selected(page)).toContainText("PMID 12345671");
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await page.getByRole("button", { name: "이전 논문", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "내 서재에 저장", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.locator(".today-study > summary").click();
  await expect(
    page.getByRole("heading", { name: "이 연구의 주요 한계는 무엇인가요?" }),
  ).toBeVisible();
  await expect(summary(page).locator("ol>li")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "다음 논문", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("daily-qa-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "논문 목록", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Personalized treatment/ }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "다음 논문", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "논문 목록", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "논문 목록", exact: true }).click();
  await page.getByRole("button", { name: /Imaging surveillance/ }).click();
  await expect(selected(page)).toContainText("PMID 12345674");
  await expect(
    page.getByRole("complementary", { name: "오늘의 논문 목록" }),
  ).not.toBeVisible();
  await page.reload();
  await expect(selected(page)).toContainText("PMID 12345674");
});

test("returning from research detail keeps the selected paper and date", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/");
  await page.getByRole("button", { name: "다음 논문", exact: true }).click();
  await selected(page)
    .getByRole("link", { name: /Long-term outcomes/ })
    .click();
  await page.getByRole("link", { name: "← 목록으로", exact: true }).click();
  await expect(selected(page)).toContainText("PMID 12345671");
  await page.locator(".today-paper-title").focus();
  await page.keyboard.press("j");
  await expect(selected(page)).toContainText("PMID 12345672");
  await page.keyboard.press("k");
  await expect(selected(page)).toContainText("PMID 12345671");
  await page.getByLabel("추천 날짜").focus();
  await page.keyboard.press("j");
  await expect(selected(page)).toContainText("PMID 12345671");
  await page.getByRole("button", { name: "이전 날짜", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "이 날짜에 제공할 추천이 없습니다" }),
  ).toBeVisible();
  await expect(selected(page)).toHaveCount(0);
  await page.getByRole("button", { name: "오늘", exact: true }).click();
  await expect(selected(page)).toContainText("PMID 12345670");
});

test("failed save leaves the summary available and can be retried", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/?scenario=daily-state-error");
  await page
    .getByRole("button", { name: "내 서재에 저장", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("저장하지 못했습니다");
  await expect(summary(page).locator("ol>li")).toHaveCount(3);
  await page
    .getByRole("button", { name: "내 서재에 저장", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "저장됨", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("rapid navigation during a slow save never changes another paper", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/?scenario=slow-daily");
  await page
    .getByRole("button", { name: "내 서재에 저장", exact: true })
    .click();
  await page.getByRole("button", { name: "다음 논문", exact: true }).click();
  await expect(selected(page)).toContainText("PMID 12345671");
  await expect(
    page.getByRole("button", { name: "내 서재에 저장", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "다음 논문", exact: true }).click();
  await page.getByRole("button", { name: "이전 논문", exact: true }).click();
  await page.getByRole("button", { name: "이전 논문", exact: true }).click();
  await expect(selected(page)).toContainText("PMID 12345670");
  await expect(
    page.getByRole("button", { name: "저장됨", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("restored recommendation highlighting never marks ai within other words", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/?scenario=ai-regression");
  await expect(selected(page)).toContainText("Veterans Affairs");
  await expect(selected(page).locator("mark")).toHaveCount(0);
  await expect(selected(page).locator(".today-reason")).toHaveCount(0);
  await page.getByRole("button", { name: "다음 논문", exact: true }).click();
  await expect(selected(page).locator(".today-paper-title mark")).toHaveText(
    "AI",
  );
  await expect(selected(page).locator(".today-reason")).toContainText("ai");
});

test("detail failure can be retried without losing the queue", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/?scenario=daily-detail-error");
  await expect(page.getByRole("alert")).toContainText(
    "문헌을 불러오지 못했습니다",
  );
  await expect(
    page.getByRole("button", { name: "다음 논문", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(summary(page).locator("ol>li")).toHaveCount(3);
  await expect(selected(page)).toContainText("PMID 12345670");
});
