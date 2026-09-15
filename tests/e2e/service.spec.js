import {
  test,
  expect,
} from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

test.beforeEach(async ({ page }) => {
  // Fail closed: the browser fixture is allowed to request only its own local assets.
  await page.route(/https?:\/\//, (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
});
test("public summary trial opens directly from the welcome page", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/welcome?scenario=signed-out");
  await page.getByRole("button", { name: "요약 체험하기" }).click();
  await expect(page).toHaveURL(/\/preview$/);
  await expect(
    page.getByRole("heading", { name: "본문 기반 세 줄 요약" }).first(),
  ).toBeVisible();
});
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test(`all pages render at ${viewport.width}px without overflow or accessibility violations`, async ({
    page,
  }, testInfo) => {
    // This case visits 17 routes and runs a complete axe audit on each.
    test.setTimeout(60000);
    await page.setViewportSize(viewport);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const path of [
      "",
      "discover",
      "papers/12345670",
      "papers/12345670?tab=study",
      "library",
      "compare?pmids=12345670,12345671",
      "preview",
      "settings",
      "collections",
      "projects",
      "insights",
      "admin?scenario=admin",
      "welcome",
      "login?scenario=signed-out",
      "onboarding?scenario=onboarding",
      "reset-password",
      "privacy",
    ]) {
      await page.goto(path ? `/uro-daily-pick/${path}` : "/uro-daily-pick/");
      await expect(page.locator("#root")).not.toBeEmpty();
      await expect(
        page.locator("h1").first(),
        `${path}: ${errors.join("; ")}`,
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        results.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            summary: n.failureSummary,
          })),
        })),
        path,
      ).toEqual([]);
      if (viewport.width !== 320)
        await page.screenshot({
          path: testInfo.outputPath(`${path.split("?")[0] || "daily"}.png`),
          fullPage: true,
        });
    }
    expect(errors).toEqual([]);
  });
}
test("mobile detail keeps save, read and recommendation opinions separate", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/uro-daily-pick/");
  await page.getByRole("button", { name: /Personalized treatment/ }).click();
  await page.getByRole("link", { name: /Personalized treatment/ }).click();
  await expect(page).toHaveURL(/papers\/12345670/);
  await page
    .getByRole("button", { name: "내 서재에 저장", exact: true })
    .click();
  await page.getByRole("button", { name: "읽음 표시", exact: true }).click();
  await page.getByRole("button", { name: "관심 없음", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "저장됨", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "읽음", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("link", { name: "내 서재", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("link", { name: /Personalized treatment/ }),
  ).toBeVisible();
});
test("projects support topic suggestions, notes and revocation", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/projects");
  await page.getByLabel("새 프로젝트 이름").fill("Upcoming journal club");
  await page
    .getByRole("button", { name: "프로젝트 만들기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Upcoming journal club", exact: true })
    .click();
  await page.getByLabel(/프로젝트 추천 주제/).fill("prostate");
  await page.getByRole("button", { name: "주제 저장" }).click();
  await page
    .locator("article")
    .filter({ hasText: "Personalized treatment" })
    .getByRole("button", { name: "프로젝트에 추가" })
    .click();
  const row = page
    .locator("article")
    .filter({ hasText: "Personalized treatment" });
  await row.getByLabel("공동 메모").fill("Discuss endpoints at journal club.");
  await row.getByRole("button", { name: "메모 저장", exact: true }).click();
  await page.getByRole("button", { name: "공유 권한 관리" }).click();
  await page.getByLabel("계정 이메일").fill("guest@example.test");
  await page.getByRole("button", { name: "초대 등록" }).click();
  await expect(page.getByText(/guest@example.test/)).toBeVisible();
  await page.getByRole("button", { name: "접근 회수" }).click();
  await expect(page.getByText(/guest@example.test/)).toHaveCount(0);
  await page
    .getByRole("button", { name: "프로젝트 삭제", exact: true })
    .click();
  await page.getByRole("button", { name: "삭제 확인", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Upcoming journal club", exact: true }),
  ).toHaveCount(0);
});
for (const width of [1440, 390]) {
  test(`AI search excludes substring matches at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/uro-daily-pick/discover?scenario=ai-regression&q=AI");
    await expect(
      page.getByRole("link", { name: "AI-assisted diagnosis", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Veterans Affairs/ }),
    ).toHaveCount(0);
  });
  test(`ready daily papers retain three-line summaries at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/uro-daily-pick/?scenario=stale-picks");
    await expect(
      page.getByRole("link", { name: /Recent paper without/ }),
    ).toHaveCount(0);
    if (width < 768) await page.getByRole("button", { name: /Personalized treatment/ }).click();
    const titles = [
      /Personalized treatment/,
      /Long-term outcomes/,
      /A multicenter evaluation/,
      /Patient-reported quality/,
      /Imaging surveillance/,
    ];
    for (let i = 0; i < titles.length; i++) {
      await expect(
        page
          .getByRole("article", { name: "선택한 논문" })
          .getByRole("heading", { name: titles[i] }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("region", { name: "본문 기반 세 줄 요약" })
          .locator("ol > li"),
      ).toHaveCount(3);
      if (i < titles.length - 1)
        await page
          .getByRole("button", { name: "다음 논문", exact: true })
          .click();
    }
  });
}
test("existing journal subscriptions keep their explanation", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/?scenario=journal-alert");
  await expect(
    page.getByText("추천 이유 · 구독 저널 · Urol").first(),
  ).toBeVisible();
});
test("discovery saves queries and exports a bounded comparison", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/discover");
  await page.getByLabel("제목·주제·PMID·DOI").fill("prostate");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.getByRole("button", { name: "검색 저장·새 결과 알림" }).click();
  await expect(page.getByText(/검색을 저장했습니다/)).toBeVisible();
  await page.getByRole("checkbox", { name: "비교에 추가" }).nth(0).check();
  await page.getByRole("checkbox", { name: "비교에 추가" }).nth(1).check();
  await page.getByRole("link", { name: "비교하기" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "참고문헌 RIS" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("references.ris");
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(await file.path(), "utf8");
  expect(text).toContain("TY  - JOUR");
  expect(text.match(/ER  -/g)).toHaveLength(2);
  await page
    .getByRole("link", { name: "내 서재", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "새 문헌 알림" }).click();
  await expect(page.getByText(/prostate/).first()).toBeVisible();
});
test("paper issues reach admin and return a resolution", async ({ page }) => {
  await page.goto("/uro-daily-pick/papers/12345670?scenario=admin");
  await page.getByRole("button", { name: "내용 오류 알리기" }).click();
  await page.getByLabel("확인할 내용").fill("Please verify this sample size.");
  await page.getByRole("button", { name: "검토 요청", exact: true }).click();
  await page
    .getByRole("link", { name: "관리자", exact: true })
    .filter({ visible: true })
    .click();
  const form = page
    .locator("form")
    .filter({ hasText: "Please verify this sample size." });
  await form.getByLabel("처리 상태").selectOption("resolved");
  await form
    .getByLabel("검토 결과")
    .fill("Sample size verified against the source.");
  await form.getByRole("button", { name: "처리 저장" }).click();
  await form.getByRole("link", { name: /Personalized treatment/ }).click();
  await page.getByText("내 검토 요청 1건").click();
  await expect(
    page.getByText("Sample size verified against the source."),
  ).toBeVisible();
});
test("admin remains usable when catalog fails and retries that section", async ({
  page,
}) => {
  await page.goto("admin?scenario=admin-partial-error");
  await expect(
    page.getByRole("heading", { name: "Admin Dashboard" }),
  ).toBeVisible();
  const catalog = page.getByRole("region", { name: "문헌 처리 현황" });
  await expect(catalog.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "자동 처리 상태" }),
  ).toBeVisible();
  await expect(page.getByText("Total Users", { exact: true })).toBeVisible();
  await catalog.getByRole("button", { name: "다시 시도" }).click();
  await expect(catalog.getByRole("alert")).toHaveCount(0);
  await expect(catalog).toContainText("문헌 정보 등록");
  await expect(catalog).toContainText("본문 요약 완료");
});

test("mobile admin distinguishes metadata, originals and summaries with accurate progress", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("admin?scenario=admin");
  const panel = page.getByRole("region", { name: "문헌 처리 현황" });
  await expect(
    panel.getByRole("meter", { name: "등록 문헌 중 원문 확보율" }),
  ).toHaveAttribute("aria-valuenow", "75");
  await expect(
    panel.getByRole("meter", { name: "확보 원문 중 요약 완료율" }),
  ).toHaveAttribute("aria-valuetext", "2 / 3편");
  await expect(panel).toContainText("원문 확보·요약 미제공 1편");
  await expect(
    page.getByRole("region", { name: "Admin content" }),
  ).not.toContainText(/Z8|Spark|Qwen|전체 목록|1866|메타데이터/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../tmp/admin-mobile-since-2000.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "../tmp/admin-desktop-since-2000.png",
    fullPage: true,
  });
});
