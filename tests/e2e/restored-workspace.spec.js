import {
  test,
  expect,
} from "../../frontend/node_modules/@playwright/test/index.mjs";

test.beforeEach(async ({ page }) => {
  await page.route(/https?:\/\//, (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
});

test("mobile list does not record reading; browser Back preserves the selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/uro-daily-pick/");
  await expect(
    page.getByRole("button", { name: /Personalized treatment/ }),
  ).toBeVisible();
  await expect(page.getByRole("article", { name: "선택한 논문" })).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: "내 서재", exact: true }).click();
  await page.getByRole("button", { name: "읽는 중", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "아직 보관된 문헌이 없습니다" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "오늘 읽기", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: /A multicenter evaluation/ }).click();
  await expect(
    page.getByRole("article", { name: "선택한 논문" }),
  ).toContainText("PMID 12345672");
  await page.goBack();
  await expect(page.getByRole("article", { name: "선택한 논문" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /A multicenter evaluation/ }),
  ).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: /A multicenter evaluation/ }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: /A multicenter evaluation/ }),
  ).toBeFocused();
});

test("original menus, collections and insights coexist with research tools", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/");
  await page
    .getByRole("link", { name: "Collections", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Collections", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Collection name").fill("Original collection flow");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Find a paper to add").fill("Personalized");
  await page
    .getByRole("button", { name: "Search papers", exact: true })
    .click();
  await page.getByRole("button", { name: /^Add Personalized/ }).click();
  await expect(
    page.getByRole("link", { name: /Personalized treatment/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Remove Personalized/ }).click();
  await expect(
    page.getByText("No papers in this collection yet."),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Delete Original collection flow",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Delete collection", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Original collection flow", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Insights", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Research Insights" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Reading Activity/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Research Topics", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Study Types", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "연구 프로젝트", exact: true }).click();
  await expect(page.getByLabel("새 프로젝트 이름")).toBeVisible();
  await page.goto("/uro-daily-pick/collections?project=1");
  await expect(page).toHaveURL(/\/projects\?project=1$/);
  await expect(
    page.getByRole("heading", { name: "Journal club", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "문헌 탐색", exact: true }).click();
  await expect(page.getByLabel("키워드·PMID·DOI")).toBeVisible();
  await page
    .getByRole("link", { name: "내 설정", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your research profile" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Topic alerts" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Account", exact: true }),
  ).toBeVisible();
});

test("like remains separate from saving and is discoverable in the library", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/");
  await page.getByRole("button", { name: "관심 있음", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "관심 있음", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "내 서재에 저장", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page
    .getByRole("link", { name: "관심 표시한 논문", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: /Personalized treatment/ }),
  ).toBeVisible();
});

test("expanded study details and existing list opinions survive paper navigation", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/");
  await page.locator(".today-study > summary").click();
  await page.getByRole("button", { name: "다음 논문", exact: true }).click();
  await expect(page.locator(".today-study")).toHaveAttribute("open", "");
  await expect(
    page.getByRole("heading", { name: /Q\. 이 연구의 주요 한계/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "관심 있음", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "관심 있음", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("link", { name: "내 서재", exact: true }).click();
  await page
    .getByRole("link", { name: "오늘 읽기", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Long-term outcomes/ }),
  ).toContainText("관심 있음");
});
