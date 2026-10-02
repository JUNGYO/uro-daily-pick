import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

for (const width of [1440, 830, 390, 320]) {
  test(`original reference markers and source details are readable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const lines = ["Introduction", "🧬 Clinical assessment is described in the study. 1 This marker refers to a source, while 195 participants, 95% confidence intervals and the year 2026 remain ordinary text.",
      "A second statement uses several references [ 2 , 3 ]. Area mm2 and stage 3 are not reference markers.",
      "Author evidence (Smith et al., 2024; Jones, 2022; Beta, 2021).",
      "Range evidence (10–12). Smith et al. (2024) reported a separate result."];
    const text = lines.join("\n\n"), chars = [...text], hash = "a".repeat(64);
    const offset = (n) => [...text.slice(0, n)].length;
    let cursor = 0;
    const blocks = lines.map((line, i) => {
      const start = cursor; cursor += [...line].length + 2;
      return { kind: i === 0 ? "heading" : "paragraph", start, end: cursor - 2 };
    });
    const one = text.indexOf("1 This"), multiple = text.indexOf("[ 2 , 3 ]");
    const citation = (start, value, targets) => ({ start: offset(start), end: offset(start + value.length), text: value, targets });
    await page.route("https://articles.example.test/v1/fulltext/*", (route) => route.fulfill({ json: {
      pmid: "12345670", title: "Reading an article with consistent references", doi: "10.0000/fixture", content_text: text, content_hash: hash, figures: [],
      blocks: blocks.map((b) => ({ id: `p-${String(b.start).padStart(7, "0")}`, start: b.start, end: b.end, text: chars.slice(b.start, b.end).join("") })),
      reading_layout: { version: 1, content_hash: hash, blocks, citation_version: 1,
        citations: [citation(one, "1", ["R1"]), citation(multiple, "[ 2 , 3 ]", ["R2", "R3"]),
          citation(text.indexOf("Smith et al., 2024"), "Smith et al., 2024; Jones, 2022; Beta, 2021", ["smith", "jones", "R2"]),
          citation(text.indexOf("10–12"), "10–12", ["R10", "R12"]),
          citation(text.indexOf("Smith et al. (2024)"), "Smith et al. (2024)", ["smith"])],
        references: [{ id: "R1", text: "1. Alpha A, Beta B. Clinical assessment in an illustrative study. Example Journal. 2020;12:100–109." },
          { id: "R2", text: "2. Gamma C. A second illustrative source. Example Journal. 2021;13:110–119." },
          { id: "R3", text: "3. Delta D. A third illustrative source. Example Journal. 2022;14:120–129." },
          { id: "smith", text: "Smith A. Author-year source. 2024." },
          { id: "jones", text: "Jones B. Another author-year source. 2022." },
          { id: "R10", text: "10. Source ten." }, { id: "R12", text: "12. Source twelve." }],
      },
    } }));
    await page.goto("/uro-daily-pick/fulltext/12345670?scenario=admin");
    const reader = page.getByRole("article");
    await expect(reader.locator("sup.original-citation")).toHaveCount(5);
    await expect(reader.locator(".original-citation-attachment")).toHaveCount(4);
    expect(await reader.locator(".original-citation-attachment").first().evaluate(el => getComputedStyle(el).whiteSpace)).toBe("nowrap");
    await expect(reader.getByRole("button", { name: "참고문헌 1 보기" })).toHaveText("[1]");
    const multipleButton = reader.getByRole("button", { name: "참고문헌 2, 3 보기" });
    await expect(multipleButton).toHaveText("[2, 3]");
    await expect(reader).toContainText("195 participants, 95% confidence intervals and the year 2026");
    await expect(reader).toContainText("Area mm2 and stage 3");
    await expect(reader).toContainText("Author evidence [2, 4, 5].");
    await expect(reader).toContainText("Smith et al. [4] reported a separate result.");
    await expect(reader.getByRole("button", { name: "참고문헌 6–8 보기" })).toHaveText("[6–8]");
    expect(await reader.locator("sup.original-citation").first().evaluate((el) => getComputedStyle(el).verticalAlign)).toBe("super");
    await page.screenshot({ path: testInfo.outputPath("citation-reading.png"), fullPage: true });
    await multipleButton.click();
    const details = reader.getByRole("complementary", { name: "참고문헌 2, 3" });
    await expect(details).toBeFocused();
    await expect(details).toContainText("Gamma C.");
    await expect(details).toContainText("Delta D.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("citation-details.png"), fullPage: true });
    await details.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(multipleButton).toBeFocused();
    await multipleButton.press("Enter");
    await expect(reader.getByRole("complementary")).toBeVisible();
    await reader.getByRole("button", { name: "참고문헌 닫기" }).click();
    await expect(reader.getByRole("complementary")).toHaveCount(0);
    await reader.getByRole("button", { name: "참고문헌 2, 4, 5 보기" }).click();
    await expect(reader.getByRole("complementary")).toContainText("[4] Smith A.");
    await expect(reader.getByRole("complementary")).toContainText("[2] Gamma C.");
    await reader.getByRole("button", { name: "참고문헌 닫기" }).click();
    await reader.getByRole("button", { name: "참고문헌 6–8 보기" }).click();
    await expect(reader.getByRole("complementary")).toContainText("[6] Source ten.");
    await expect(reader.getByRole("complementary")).toContainText("[7] 저장된 원문에서 참고문헌 내용을 확인할 수 없습니다.");
    await expect(reader.getByRole("complementary")).toContainText("[8] Source twelve.");
  });
}
