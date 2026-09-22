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
const body =
  "Synthetic original body. This text is only a test fixture.\n<img src=x onerror=alert(1)>\n".repeat(
    12,
  );
const article = {
  pmid: "12345670",
  title: "Synthetic original article",
  doi: "10.0000/test",
  content_text: body,
};

for (const width of [1440, 390, 320]) {
  test(`long original keeps words, source anchors and all text at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const prefix =
      "The study describes clinical assessment and careful specimen handling. ";
    const line =
      prefix.repeat(19).padEnd(1392, " ") +
      " entirel" +
      "y at the clinician's discretion. The second part continues the same paragraph.";
    const text =
      line +
      "\n\nA second paragraph contains 𝛼 and 🧬 symbols.\nThe final paragraph must remain visible.";
    const characters = [...text];
    let offset = 0;
    const blocks = text.split("\n").flatMap((value) => {
      const result = [];
      const stop = offset + [...value].length;
      for (let start = offset; start < stop; start += 1400) {
        const end = Math.min(start + 1400, stop);
        result.push({
          id: `p-${String(start).padStart(7, "0")}`,
          start,
          end,
          text: characters.slice(start, end).join(""),
        });
      }
      offset = stop + 1;
      return result;
    });
    const hash = "a".repeat(64);
    await page.route("https://articles.example.test/v1/fulltext/*", (route) =>
      route.fulfill({
        json: { ...article, content_text: text, content_hash: hash, blocks },
      }),
    );
    await page.goto(
      `/uro-daily-pick/fulltext/12345670?scenario=admin&source=${hash}#p-0001400`,
    );
    const reader = page.getByRole("article");
    await expect(reader.locator("#p-0001400")).toBeFocused();
    const paragraphs = reader.locator(".original-paragraph");
    expect(
      await paragraphs.evaluateAll((items) =>
        items.map((el) => el.textContent).join("\n"),
      ),
    ).toBe(text);
    expect(await paragraphs.first().innerText()).toBe(line);
    await expect(reader).toContainText(
      "The final paragraph must remain visible.",
    );
    expect(
      await reader
        .locator("#p-0001400")
        .evaluate((el) => getComputedStyle(el).display),
    ).toBe("inline");
    await reader.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("continuous-original.png"),
      fullPage: true,
    });
  });
}

test("mobile figures load with login, retry, enlarge and download inside the reader", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const asset = "a".repeat(64);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  let attempts = 0;
  await page.route(
    "https://articles.example.test/v1/fulltext/**",
    async (route) => {
      expect(route.request().headers().authorization).toBe(
        "Bearer fixture.access.token",
      );
      if (route.request().url().includes("/images/")) {
        attempts++;
        if (attempts === 1) return route.abort();
        return route.fulfill({ body: png, contentType: "image/png" });
      }
      return route.fulfill({
        json: {
          ...article,
          figure_status: "complete",
          figures: [
            {
              key: "figure-1",
              label: "Figure 1",
              caption: "Synthetic study flow.",
              status: "ready",
              asset_id: asset,
              content_type: "image/png",
            },
          ],
        },
      });
    },
  );
  await page.goto("/uro-daily-pick/fulltext/12345670?scenario=admin");
  await expect(page.getByRole("article")).toBeVisible();
  await expect(page.getByText(/Z8/)).toHaveCount(0);
  expect(attempts).toBe(0);
  await page.getByRole("tab", { name: "본문", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "그림 (1)" })).toBeFocused();
  await page.getByRole("button", { name: "그림 다시 불러오기" }).click();
  const img = page.locator("figure > img");
  await expect(img).toBeVisible();
  expect(
    await img.evaluate((node) => node.complete && node.naturalWidth === 1),
  ).toBe(true);
  await page.getByRole("button", { name: "크게 보기" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "이미지 다운로드" }).click();
  expect((await download).suggestedFilename()).toBe("12345670-figure-1.png");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("figures-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Logout", exact: true }).click();
  await expect(page.locator("figure img")).toHaveCount(0);
});

for (const width of [1440, 390, 320]) {
  test(`stored publisher structure reads as paragraphs and table cells at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const text =
      "Results\nThe 𝛼 biomarker was evaluated in two groups.\nGroup N A 123 B 456\nFigure 1 Study workflow.\nFinal intact sentence.";
    const position = (value) => [...text.slice(0, text.indexOf(value))].length;
    const range = (value, kind) => ({
      kind,
      start: position(value),
      end: position(value) + [...value].length,
    });
    const table = range("Group N A 123 B 456", "table");
    const cell = (value, header = false) => ({
      ...range(value),
      header,
      rowspan: 1,
      colspan: 1,
    });
    table.rows = [
      [cell("Group", true), cell("N", true)],
      [cell("A"), cell("123")],
      [cell("B"), cell("456")],
    ];
    const hash = "b".repeat(64);
    const layout = {
      version: 1,
      content_hash: hash,
      blocks: [
        range("Results", "heading"),
        range("The 𝛼 biomarker was evaluated in two groups.", "paragraph"),
        table,
        range("Figure 1 Study workflow.", "figure"),
        range("Final intact sentence.", "paragraph"),
      ],
    };
    let start = 0;
    const blocks = text.split("\n").map((value) => {
      const block = {
        id: `p-${String(start).padStart(7, "0")}`,
        start,
        end: start + [...value].length,
        text: value,
      };
      start = block.end + 1;
      return block;
    });
    await page.route("https://articles.example.test/v1/fulltext/*", (route) =>
      route.fulfill({
        json: {
          ...article,
          content_text: text,
          content_hash: hash,
          blocks,
          reading_layout: layout,
        },
      }),
    );
    await page.goto("/uro-daily-pick/fulltext/12345670?scenario=admin");
    const reader = page.getByRole("article");
    await expect(
      reader.getByRole("heading", { name: "Results" }),
    ).toBeVisible();
    await expect(reader.getByRole("table")).toBeVisible();
    await expect(reader.getByRole("columnheader")).toHaveText(["Group", "N"]);
    await expect(reader.getByRole("cell")).toHaveText(["A", "123", "B", "456"]);
    expect((await reader.textContent()).replace(/\s/g, "")).toBe(
      text.replace(/\s/g, ""),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("structured-original.png"),
      fullPage: true,
    });
  });
}

for (const width of [390, 320]) {
  test(`owner reads original inside mobile service at ${width}px and logout clears it`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const requests = [];
    await page.route(
      "https://articles.example.test/v1/fulltext/*",
      async (route) => {
        requests.push(route.request());
        await route.fulfill({ json: article });
      },
    );
    await page.goto("/uro-daily-pick/?scenario=admin");
    await page.getByRole("button", { name: /Personalized treatment/ }).click();
    await page.getByRole("link", { name: /Personalized treatment/ }).click();
    await page.getByRole("button", { name: "근거·원문", exact: true }).click();
    await page
      .getByRole("link", { name: "원문·표·그림 보기", exact: true })
      .filter({ visible: true })
      .click();
    await expect(
      page.getByRole("article", { name: "논문 본문" }),
    ).toContainText("Synthetic original body");
    expect(requests).toHaveLength(1);
    expect(requests[0].headers().authorization).toBe(
      "Bearer fixture.access.token",
    );
    expect(requests[0].url()).not.toContain("token");
    await expect(page.getByRole("article").locator("img")).toHaveCount(0);
    await page.getByLabel("글자 크기").selectOption("20");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("original-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Logout", exact: true }).click();
    await expect(page.getByRole("article", { name: "논문 본문" })).toHaveCount(
      0,
    );
  });
}

test("offline viewer retries without claiming an original exists; other account is denied", async ({
  page,
}) => {
  let available = false;
  await page.route("https://articles.example.test/v1/fulltext/*", (route) =>
    available ? route.fulfill({ json: article }) : route.abort(),
  );
  await page.goto("/uro-daily-pick/fulltext/12345670?scenario=admin");
  await expect(page.getByRole("alert")).toContainText(
    "원문을 불러오지 못했습니다",
  );
  available = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("article")).toContainText(
    "Synthetic original body",
  );
  await page.route("https://articles.example.test/v1/fulltext/*", (route) =>
    route.fulfill({ status: 403, json: { error: "access_denied" } }),
  );
  await page.goto("/uro-daily-pick/fulltext/12345670");
  await expect(page.getByRole("alert")).toContainText("권한이 없습니다");
  await expect(page.getByRole("article")).toHaveCount(0);
});
