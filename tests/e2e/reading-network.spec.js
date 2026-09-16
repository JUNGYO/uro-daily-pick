import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

test.beforeEach(async ({ page }) => {
  await page.route(/https?:\/\//, (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
});

const firstTitle = "Personalized treatment strategies for localized prostate cancer: a randomized trial";
const viewedTitle = "Long-term outcomes after robotic partial nephrectomy in patients with renal tumors";
const legacyTitle = "Legacy completed paper without a known date";
const snapshot = (page) => page.evaluate(() => globalThis.__uroFixtureSnapshot());
const workspace = (page) => page.getByRole("region", { name: "연구 설계·집필 자료" });
const referenceRow = (page, title) => page.locator(".research-table tbody tr").filter({
  has: page.getByRole("heading", { name: title, exact: true }),
});
const detail = (page) => page.getByRole("region", { name: "선택한 자료 상세" });

async function expectAccessible(page) {
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

async function openResearch(page, scenario = "research-network") {
  await page.goto(`/uro-daily-pick/projects?scenario=${scenario}&project=1&view=research`);
  await workspace(page).getByRole("button", { name: "선행연구 표", exact: true }).click();
  await expect(referenceRow(page, "Research study 25")).toBeVisible();
}

test("only read and saved transitions stamp dates; later note edits preserve both timestamps", async ({ page }) => {
  await page.goto("/uro-daily-pick/papers/12345670?scenario=reader&tab=notes");
  await expect(page.getByRole("textbox", { name: "개인 메모", exact: true })).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).reader_states.find((row) => row.paper_id === 1)?.reading_state).toBe("reading");
  expect((await snapshot(page)).reader_states.find((row) => row.paper_id === 1).read_at).toBeNull();
  await page.getByRole("button", { name: "읽음 표시", exact: true }).click();
  await page.getByRole("button", { name: "내 서재에 저장", exact: true }).click();
  const before = (await snapshot(page)).reader_states.find((row) => row.paper_id === 1);
  expect(Date.parse(before.read_at)).not.toBeNaN();
  expect(Date.parse(before.saved_at)).not.toBeNaN();
  await page.getByRole("textbox", { name: "개인 메모", exact: true }).fill("A later edit must not become a new reading event.");
  await page.getByRole("button", { name: "메모 저장", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).reader_states.find((row) => row.paper_id === 1)?.note).toBe("A later edit must not become a new reading event.");
  const after = (await snapshot(page)).reader_states.find((row) => row.paper_id === 1);
  expect(after.read_at).toBe(before.read_at);
  expect(after.saved_at).toBe(before.saved_at);
  await page.getByRole("button", { name: "읽음", exact: true }).click();
  await page.getByRole("button", { name: "저장됨", exact: true }).click();
  const cleared = (await snapshot(page)).reader_states.find((row) => row.paper_id === 1);
  expect(cleared.read_at).toBeNull();
  expect(cleared.saved_at).toBeNull();
});

test("insights separates ten-second views from marked-read dates and drills topics into real paper lists", async ({ page }) => {
  await page.goto("/uro-daily-pick/insights?scenario=insights-network");
  await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("30");
  const activities = page.locator('[aria-label="Activity to explore"]');
  await activities.getByRole("button", { name: /^Marked read/ }).click();
  const results = page.locator('[aria-labelledby="insights-results-title"]');
  await expect(results.getByRole("link", { name: firstTitle, exact: true })).toBeVisible();
  await expect(results.getByRole("link", { name: viewedTitle, exact: true })).toHaveCount(0);
  await expect(results.getByRole("link", { name: legacyTitle, exact: true })).toHaveCount(0);
  await expect(page.getByText(/1 marked read papers have no recorded action date/)).toBeVisible();
  await page.getByRole("button", { name: /전립선 종양/ }).first().click();
  await expect(results).toContainText("전립선 종양");
  await expect(results.getByRole("link", { name: firstTitle, exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("all");
  await expect(results.getByRole("link", { name: legacyTitle, exact: true })).toBeVisible();
  await activities.getByRole("button", { name: /^Viewed/ }).click();
  await expect(results.getByRole("link", { name: viewedTitle, exact: true })).toBeVisible();
  await expect(results.getByRole("link", { name: firstTitle, exact: true })).toHaveCount(0);
  const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  await expect(page.getByRole("button", { name: `${date}: 1 viewed papers`, exact: true })).toBeVisible();
  const state = (await snapshot(page)).reader_states.find((row) => row.paper_id === 6);
  expect(state.read_at).toBeNull();
});

test("sparse recommendations show content explanations without similar-reader claims", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/uro-daily-pick/insights?scenario=insights-network");
  await expect(page.getByRole("heading", { name: "Interest expansion", exact: true })).toBeVisible();
  await expect(page.getByText("Not enough verified similar-reader evidence is available. Content and profile interests remain the starting point.")).toBeVisible();
  await expect(page.getByText(/Liked by \d+ similar readers/)).toHaveCount(0);
  expect((await snapshot(page)).recommendations.every((rec) => rec.reasons.network.status === "insufficient")).toBe(true);
  await page.getByRole("region", { name: "Insights content", exact: true }).evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath("reading-insights-desktop.png"), fullPage: true });
  await expectAccessible(page);
});

test("qualified recommendations show actual support and turning personalization off clears their cache", async ({ page }) => {
  await page.goto("/uro-daily-pick/insights?scenario=insights-qualified");
  await expect(page.getByText(/Liked by 3 similar readers \(group: 4\)/)).toBeVisible();
  await page.getByRole("link", { name: "내 설정", exact: true }).click();
  const personalized = page.getByRole("checkbox", { name: /열람·좋아요 기록으로/ });
  await personalized.uncheck();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).profiles[0].personalization_enabled).toBe(false);
  expect((await snapshot(page)).recommendations).toEqual([]);
  await page.getByRole("link", { name: "Insights", exact: true }).click();
  await expect(page.getByText("Behavior-based personalization is off. Suggestions use your explicit profile and content preferences.")).toBeVisible();
  await expect(page.getByText(/Liked by \d+ similar readers/)).toHaveCount(0);
});

test("project graph distinguishes explicit writing links from topic classification and keeps unsaved table drafts", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openResearch(page);
  const panel = workspace(page), row = referenceRow(page, "Research study 25");
  await row.getByRole("textbox", { name: "Research study 25 설계 판단·메모", exact: true }).fill("Retain this unsaved design decision.");
  await panel.getByRole("button", { name: "연결 지도", exact: true }).click();
  const graph = panel.getByRole("region", { name: "프로젝트 연결 지도" });
  await expect(graph.getByText("사용자가 연결한 자료", { exact: true })).toBeVisible();
  await expect(graph.getByText("주제 분류", { exact: true })).toBeVisible();
  await expect(graph.getByText(/실제 참고문헌 인용이 확인된 데이터가 없어/)).toBeVisible();
  await graph.locator(".project-network-node.argument").filter({ hasText: "Validation needs independent evidence" }).click();
  await expect(detail(page)).toContainText("User-authored interpretation linked to retained sources.");
  await expect(detail(page).getByRole("link", { name: "본문 근거 1 보기 ↗", exact: true })).toHaveAttribute("href", /#p-0000001$/);
  await expect(detail(page)).not.toContainText("p-0000001");
  await graph.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: info.outputPath("project-network-desktop.png"), fullPage: true });
  await expectAccessible(page);
  await detail(page).getByRole("button", { name: "표 항목 · Population", exact: true }).click();
  await expect(row).toBeVisible();
  await expect(row.getByRole("textbox", { name: "Research study 25 설계 판단·메모", exact: true })).toHaveValue("Retain this unsaved design decision.");
  expect((await snapshot(page)).research_reference_entries.find((ref) => ref.paper_id === 25).note).toBe("Team entry 25");
  await panel.getByRole("button", { name: "연결 지도", exact: true }).click();
  await graph.locator(".project-network-node.paper").filter({ hasText: "Research study 25" }).click();
  await expect(detail(page).locator(".project-source-badge")).toHaveText("원문 확보");
  await expect(detail(page).getByRole("link", { name: "원문·근거 보기 ↗", exact: true })).toHaveAttribute("href", /\/papers\/52345024\?tab=study$/);
  await detail(page).getByRole("button", { name: "표에서 보기", exact: true }).click();
  await expect(row.getByRole("textbox", { name: "Research study 25 설계 판단·메모", exact: true })).toHaveValue("Retain this unsaved design decision.");
});

test("project distribution uses metadata and scoped search instead of inferring a research method from surgery", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openResearch(page);
  const panel = workspace(page);
  await panel.getByRole("button", { name: "분포", exact: true }).click();
  const distribution = panel.getByRole("region", { name: "프로젝트 문헌 분포" });
  await distribution.getByRole("button", { name: "연구 방법", exact: true }).click();
  await distribution.getByRole("button", { name: /미분류/ }).click();
  await expect(distribution).toContainText("Research study 24");
  await distribution.locator(".project-distribution-papers").getByRole("button", { name: /Research study 24/ }).click();
  await expect(detail(page)).toContainText("확인된 연구 방법 메타데이터 없음");
  await distribution.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: info.outputPath("project-distribution-desktop.png"), fullPage: true });
  await expectAccessible(page);
  const search = panel.locator(".research-filter input");
  await search.fill("special-cohort");
  await search.press("Enter");
  await panel.getByRole("button", { name: "연결 지도", exact: true }).click();
  await expect(panel.locator(".project-network-node.paper")).toHaveCount(1);
  await expect(panel.locator(".project-network-node.paper")).toContainText("Research study 01");
});

test("shared project readers can inspect graphs and return to a read-only table", async ({ page }) => {
  await openResearch(page, "research-network-reader");
  const panel = workspace(page);
  await expect(panel.locator(".research-override input").first()).toBeDisabled();
  await panel.getByRole("button", { name: "연결 지도", exact: true }).click();
  await panel.locator(".project-network-node.paper").filter({ hasText: "Research study 25" }).click();
  await detail(page).getByRole("button", { name: "표에서 보기", exact: true }).click();
  await expect(referenceRow(page, "Research study 25")).toBeVisible();
  await expect(panel.getByRole("button", { name: "항목 추출 요청", exact: true })).toHaveCount(0);
  await expect(panel.locator(".research-override input").first()).toBeDisabled();
  expect((await snapshot(page)).research_reference_entries.every((ref) => ref.revision === 0)).toBe(true);
});

test("insights and project network retain usable lists without page overflow at 320 pixels", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/uro-daily-pick/insights?scenario=insights-network");
  await expect(page.getByRole("heading", { name: "Interest expansion", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("reading-insights-mobile.png"), fullPage: true });
  await openResearch(page);
  await workspace(page).getByRole("button", { name: "연결 지도", exact: true }).click();
  const list = page.locator('[aria-label="연결 지도 목록"]');
  await expect(list).toBeVisible();
  await list.getByRole("button", { name: /Validation needs independent evidence/ }).click();
  await expect(detail(page)).toContainText("User-authored interpretation linked to retained sources.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await workspace(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("project-network-mobile.png"), fullPage: true });
});
