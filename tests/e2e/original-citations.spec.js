import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

for (const width of [1440, 830, 390, 320]) {
  test(`original reference markers and source details are readable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const lines = ["Introduction", "🧬 Clinical assessment is described in the study. 1 This marker refers to a source, while 195 participants, 95% confidence intervals and the year 2026 remain ordinary text.",
      "A second statement uses several references [ 2 , 3 ]. Area mm2 and stage 3 are not reference markers."];
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
        citations: [citation(one, "1", ["R1"]), citation(multiple, "[ 2 , 3 ]", ["R2", "R3"])],
        references: [{ id: "R1", text: "1. Alpha A, Beta B. Clinical assessment in an illustrative study. Example Journal. 2020;12:100–109." },
          { id: "R2", text: "2. Gamma C. A second illustrative source. Example Journal. 2021;13:110–119." },
          { id: "R3", text: "3. Delta D. A third illustrative source. Example Journal. 2022;14:120–129." }],
      },
    } }));
    await page.goto("/uro-daily-pick/fulltext/12345670?scenario=admin");
    const reader = page.getByRole("article");
    await expect(reader.locator("sup.original-citation")).toHaveCount(2);
    await expect(reader.getByRole("button", { name: "참고문헌 1 보기" })).toHaveText("[1]");
    const multipleButton = reader.getByRole("button", { name: "참고문헌 2, 3 보기" });
    await expect(multipleButton).toHaveText("[2, 3]");
    await expect(reader).toContainText("195 participants, 95% confidence intervals and the year 2026");
    await expect(reader).toContainText("Area mm2 and stage 3");
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
  });
}
