import {test, expect} from "../../frontend/node_modules/@playwright/test/index.mjs";
import {readFile} from "node:fs/promises";

test.beforeEach(async ({page}) => {
  await page.route(/https?:\/\//, (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
});

const titles = (page) => page.locator("article h2 a");
async function submitSearch(page, value) {
  const field = page.locator('input[name="q"]').filter({visible: true});
  await field.fill(value);
  await field.press("Enter");
}

test("library searches unsaved notes beyond the first page and paginates matching records", async ({page}) => {
  await page.goto("/uro-daily-pick/library?scenario=research-documents&tab=notes");
  await expect(titles(page)).toHaveCount(20);
  await expect(page.getByRole("link", {name: "Research study 01", exact: true})).toHaveCount(0);
  await page.getByRole("button", {name: "다음 페이지", exact: true}).click();
  await expect(titles(page)).toHaveCount(6);
  await expect(page.getByRole("link", {name: "Research study 01", exact: true})).toBeVisible();
  await submitSearch(page, "UNSAVED NEEDLE");
  await expect(titles(page)).toHaveCount(1);
  await expect(page.getByText("메모 · Unsaved needle memo", {exact: true})).toBeVisible();
  expect(new URL(page.url()).searchParams.get("page")).toBe(null);
  await expect(page.getByRole("button", {name: "다음 페이지", exact: true})).toBeDisabled();
  await submitSearch(page, "review");
  await expect(titles(page)).toHaveCount(20);
  await page.getByRole("button", {name: "다음 페이지", exact: true}).click();
  await expect(titles(page)).toHaveCount(5);
  expect(new URL(page.url()).searchParams.get("q")).toBe("review");
});

test("library memo search retains saved, liked, reading and completed tab filters", async ({page}) => {
  for (const [tab, expected] of [["saved", 20], ["liked", 1], ["reading", 1], ["read", 1]]) {
    await page.goto(`/uro-daily-pick/library?scenario=research-documents&tab=${tab}`);
    await submitSearch(page, "journal entry");
    await expect(titles(page)).toHaveCount(expected);
    expect(new URL(page.url()).searchParams.get("tab")).toBe(tab);
  }
  await page.goto("/uro-daily-pick/library?scenario=research-documents&tab=saved");
  await submitSearch(page, "unsaved needle");
  await expect(titles(page)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("tab")).toBe("saved");
});

test("project search finds old shared notes and tags without altering the original project interface", async ({page}) => {
  await page.goto("/uro-daily-pick/projects?scenario=research-documents&project=1");
  await expect(titles(page)).toHaveCount(20);
  await submitSearch(page, "special-cohort");
  await expect(titles(page)).toHaveCount(1);
  await expect(page.getByRole("link", {name: "Research study 01", exact: true})).toBeVisible();
  await page.locator('textarea[name="note"]').fill("Edited shared project rationale");
  await page.getByRole("button", {name: "메모 저장", exact: true}).click();
  await submitSearch(page, "Edited shared");
  await expect(titles(page)).toHaveCount(1);
  await submitSearch(page, "team");
  await expect(titles(page)).toHaveCount(20);
  await page.getByRole("button", {name: "다음 페이지", exact: true}).click();
  await expect(titles(page)).toHaveCount(5);
  expect(new URL(page.url()).searchParams.get("q")).toBe("team");
  await expect(page.getByRole("button", {name: "연구 정리", exact: true})).toBeVisible();
});

const workspace = (page) => page.getByRole("region", {name: "연구 설계·집필 자료"});
const researchRow = (page, title) => page.locator(".research-table tbody tr").filter({has: page.getByRole("heading", {name: title, exact: true})});
async function openResearch(page, scenario = "research-documents") {
  await page.goto(`/uro-daily-pick/projects?scenario=${scenario}&project=1&view=research`);
  await expect(workspace(page).getByRole("textbox", {name: "연구 질문", exact: true})).toBeVisible();
}
async function download(page, button) {
  const pending = page.waitForEvent("download");
  await button.click();
  const file = await pending;
  return {name: file.suggestedFilename(), bytes: await readFile(await file.path())};
}

test("workspace persists edits, preserves manual cells through extraction and exports all project references with history", async ({page}, testInfo) => {
  await page.setViewportSize({width: 1440, height: 1000});
  await openResearch(page);
  const panel = workspace(page);
  await panel.getByRole("textbox", {name: "연구 질문", exact: true}).fill("How should we design the next comparative study?");
  await panel.getByRole("button", {name: "직접 항목 추가", exact: true}).click();
  await panel.getByLabel("항목 이름 3", {exact: true}).fill("Follow-up");
  await panel.getByLabel("추출 지침 3", {exact: true}).fill("Describe the follow-up duration");
  await panel.getByRole("button", {name: "질문·항목 저장", exact: true}).click();
  await expect(panel.getByRole("button", {name: "질문·항목 저장", exact: true})).toBeDisabled();
  await panel.getByRole("button", {name: "프로젝트로 돌아가기", exact: true}).click();
  await page.getByRole("button", {name: "연구 정리", exact: true}).click();
  await expect(panel.getByRole("textbox", {name: "연구 질문", exact: true})).toHaveValue("How should we design the next comparative study?");
  await expect(panel.getByLabel("항목 이름 3", {exact: true})).toHaveValue("Follow-up");
  await panel.getByRole("button", {name: "선행연구 표", exact: true}).click();
  await expect(page.locator(".research-table tbody tr")).toHaveCount(20);
  const row = researchRow(page, "Research study 25");
  await row.locator(".research-override").filter({hasText: "Population"}).getByRole("checkbox").check();
  const correction = row.locator('textarea[aria-label*="Population"]');
  await correction.fill("Human verified correction");
  await row.locator("td").last().locator("textarea").fill("Plan an external validation cohort.");
  await row.getByRole("button", {name: "문헌 수정 저장", exact: true}).click();
  await expect(row.getByRole("button", {name: "문헌 수정 저장", exact: true})).toBeDisabled();
  await row.getByRole("button", {name: "항목 추출 요청", exact: true}).click();
  await expect.poll(async () => {
    await panel.getByRole("button", {name: "추출 상태 새로고침", exact: true}).click();
    return row.locator(".research-auto-value").first().textContent();
  }).toBe("Refreshed Population from original");
  await expect(correction).toHaveValue("Human verified correction");
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({path: testInfo.outputPath("research-desktop-table.png"), fullPage: true});
  await row.locator("td").first().getByRole("button", {name: "이 항목을 논점에 연결", exact: true}).click();
  await panel.getByLabel("논점 제목", {exact: true}).fill("Interpretation of the retained cohort evidence");
  await panel.locator(".research-topic-editor textarea").fill("Use this evidence to justify external validation in the next study.");
  await panel.getByRole("combobox", {name: "문서 위치", exact: true}).selectOption("discussion");
  await expect(panel.locator(".research-linked-reference")).toContainText("Research study 25");
  await expect(panel.locator(".research-linked-reference")).toContainText("Population");
  await panel.getByRole("button", {name: "논점 저장", exact: true}).click();
  await expect(panel.locator(".research-topic")).toContainText("Interpretation of the retained cohort evidence");
  await expect(panel.locator(".research-topic")).toContainText("Population");
  await panel.getByRole("button", {name: "연구 자료 내보내기", exact: true}).click();
  const csv = await download(page, panel.getByRole("button", {name: "연구 표 CSV", exact: true}));
  expect(csv.name).toMatch(/\.csv$/);
  const csvText = csv.bytes.toString("utf8");
  expect(csvText.match(/^"연구표","\d+","Research study \d{2}"/gm)).toHaveLength(26);
  expect(new Set(csvText.match(/Research study \d{2}/g)).size).toBe(26);
  expect(csvText).toContain("Research study 01");
  expect(csvText).toContain("Human verified correction");
  expect(csvText).not.toContain("This simulated research abstract");
  await expect(panel.locator(".research-export-history")).toHaveCount(1);
  await expect(panel.locator(".research-export-history")).toContainText("26");
  const ris = await download(page, panel.getByRole("button", {name: "참고문헌 RIS", exact: true}));
  expect(ris.bytes.toString("utf8").match(/TY  - JOUR/g)).toHaveLength(26);
  await expect(panel.locator(".research-export-history")).toHaveCount(2);
  const docx = await download(page, panel.getByRole("button", {name: "Word 문서 DOCX", exact: true}));
  expect(docx.name).toMatch(/\.docx$/);expect(docx.bytes.subarray(0, 2).toString()).toBe("PK");expect(docx.bytes.length).toBeGreaterThan(1000);
  await expect(panel.locator(".research-export-history")).toHaveCount(3);
  await panel.evaluate((element) => element.scrollIntoView({block: "start"}));
  await page.screenshot({path: testInfo.outputPath("research-desktop-exports.png"), fullPage: true});
  await panel.getByRole("button", {name: "프로젝트로 돌아가기", exact: true}).click();
  await page.getByRole("button", {name: "연구 정리", exact: true}).click();
  await panel.getByRole("button", {name: "서론·고찰 논점", exact: true}).click();
  await expect(panel.locator(".research-topic")).toContainText("Interpretation of the retained cohort evidence");
  await panel.getByRole("button", {name: "연구 자료 내보내기", exact: true}).click();
  await expect(panel.locator(".research-export-history")).toHaveCount(3);
});

test("shared readers cannot edit research data, while personal exports remain available", async ({page}) => {
  await openResearch(page, "research-reader");
  const panel = workspace(page);
  await expect(panel.getByRole("textbox", {name: "연구 질문", exact: true})).toBeDisabled();
  await expect(panel.getByRole("button", {name: "질문·항목 저장", exact: true})).toBeDisabled();
  await panel.getByRole("button", {name: "선행연구 표", exact: true}).click();
  await expect(panel.getByRole("button", {name: "항목 추출 요청", exact: true})).toHaveCount(0);
  await expect(panel.locator(".research-override input").first()).toBeDisabled();
  await panel.getByRole("button", {name: "연구 자료 내보내기", exact: true}).click();
  await expect(panel.getByRole("button", {name: "연구 표 CSV", exact: true})).toBeEnabled();
});

test("closing research refreshes a previously displayed project note after a research edit", async ({page}) => {
  for (const closeWith of ["return button", "browser back"]) {
    await page.goto("/uro-daily-pick/projects?scenario=research-documents&project=1");
    const card = page.locator("article.reader-card").filter({has: page.getByRole("link", {name: "Research study 25", exact: true})});
    await expect(card.locator('textarea[name="note"]')).toHaveValue("Team entry 25");
    await page.getByRole("button", {name: "연구 정리", exact: true}).click();
    await workspace(page).getByRole("button", {name: "선행연구 표", exact: true}).click();
    const row = researchRow(page, "Research study 25");
    await row.locator("td").last().locator("textarea").fill("Updated research design rationale");
    await row.getByRole("button", {name: "문헌 수정 저장", exact: true}).click();
    await expect(row.getByRole("button", {name: "문헌 수정 저장", exact: true})).toBeDisabled();
    if (closeWith === "browser back") await page.goBack();
    else await workspace(page).getByRole("button", {name: "프로젝트로 돌아가기", exact: true}).click();
    await expect(card.locator('textarea[name="note"]')).toBeVisible();
    await expect(card.locator('textarea[name="note"]')).toHaveValue("Updated research design rationale");
  }
});

test("research controls and mobile reference cards fit a 320 pixel viewport", async ({page}, testInfo) => {
  await page.setViewportSize({width: 320, height: 900});
  await openResearch(page);
  const panel = workspace(page);
  for (const tab of ["연구 질문·추출 항목", "선행연구 표", "서론·고찰 논점", "연구 자료 내보내기"]) {
    await panel.getByRole("button", {name: tab, exact: true}).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    if (tab === "연구 질문·추출 항목") {
      await panel.locator(".research-question").evaluate((element) => element.scrollIntoView({block: "start"}));
      await page.screenshot({path: testInfo.outputPath("research-mobile-question.png"), fullPage: true});
    }
    if (tab === "서론·고찰 논점") {
      await panel.getByRole("button", {name: "논점 추가", exact: true}).click();
      await panel.locator(".research-topic-editor").evaluate((element) => element.scrollIntoView({block: "start"}));
      await page.screenshot({path: testInfo.outputPath("research-mobile-topic.png"), fullPage: true});
      await panel.getByRole("button", {name: "논점 작성 취소", exact: true}).click();
    }
    if (tab === "연구 자료 내보내기") {
      await panel.locator(".research-export").evaluate((element) => element.scrollIntoView({block: "start"}));
      await page.screenshot({path: testInfo.outputPath("research-mobile-export.png"), fullPage: true});
    }
  }
  await panel.getByRole("button", {name: "선행연구 표", exact: true}).click();
  await panel.evaluate((element) => element.scrollIntoView({block: "start"}));
  await page.screenshot({path: testInfo.outputPath("research-mobile-workspace.png"), fullPage: true});
  await page.locator(".research-table tbody tr").first().evaluate((element) => element.scrollIntoView({block: "start"}));
  await page.screenshot({path: testInfo.outputPath("research-mobile.png"), fullPage: true});
});
