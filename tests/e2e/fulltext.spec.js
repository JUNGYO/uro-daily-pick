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
