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
    await page
      .getByRole("link", { name: "원문 보기", exact: true })
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
    "Z8에 연결하지 못했습니다",
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
