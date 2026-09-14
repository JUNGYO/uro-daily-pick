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
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test(`all pages render at ${viewport.width}px without overflow or accessibility violations`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const path of [
      "",
      "settings",
      "collections",
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
test("mobile detail back navigation and saved feedback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/uro-daily-pick/");
  await page.getByRole("button", { name: /Personalized treatment/ }).click();
  await expect(
    page.getByRole("button", { name: "Back to picks" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Like paper", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Saved to Liked Papers");
  await page.getByRole("button", { name: "Back to picks" }).click();
  await expect(page.getByRole("button", { name: "Back to picks" })).toHaveCount(
    0,
  );
  await expect(
    page
      .getByRole("link", { name: "Settings", exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
});
test("collection creation and removal persist in the simulated API", async ({
  page,
}) => {
  await page.goto("/uro-daily-pick/collections");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Collection name").fill("Upcoming journal club");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Upcoming journal club", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Find a paper to add").fill("prostate");
  await page.getByRole("button", { name: "Search papers" }).click();
  await page
    .getByRole("button", { name: /^Add Personalized treatment/ })
    .click();
  await expect(
    page.getByRole("button", { name: /^Remove Personalized treatment/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete Upcoming journal club", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete collection", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Upcoming journal club", exact: true }),
  ).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`historical AI false matches are removed from paper bodies at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/uro-daily-pick/?scenario=ai-regression");
    await page
      .getByRole("button", { name: /DNA mismatch repair in Veterans Affairs/ })
      .click();
    await expect(
      page
        .getByText(/The role of DNA mismatch repair/)
        .filter({ visible: true }),
    ).toBeVisible();
    expect(await page.locator("mark").allTextContents()).not.toContain("ai");
    if (width === 390)
      await page.getByRole("button", { name: "Back to picks" }).click();
    await page.getByRole("button", { name: /AI-assisted diagnosis/ }).click();
    const marks = await page.locator("mark").allTextContents();
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((text) => text === "AI")).toBe(true);
  });
}

test("instant recommendations preserve partial journal subscription explanations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/uro-daily-pick/?scenario=journal-alert");
  await expect(
    page
      .getByText("Alert: Urol", { exact: true })
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`every current pick has a visible three-line body summary after stale-pick recovery at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/uro-daily-pick/?scenario=stale-picks");
    await expect(
      page.getByRole("button", { name: /Recent paper without/ }),
    ).toHaveCount(0);
    for (const title of [
      /Personalized treatment/,
      /Long-term outcomes/,
      /A multicenter evaluation/,
      /Patient-reported quality/,
      /Imaging surveillance/,
    ]) {
      await page.getByRole("button", { name: title }).click();
      const summary = page
        .getByRole("region", { name: "본문 기반 세 줄 요약" })
        .filter({ visible: true });
      await expect(summary.locator("ol > li")).toHaveCount(3);
      await expect(summary).not.toContainText("원문이 아직 확보되지 않아");
      if (String(title).includes("Personalized")) {
        await expect(
          page
            .getByRole("button", { name: "Like paper", exact: true })
            .filter({ visible: true }),
        ).toHaveAttribute("aria-pressed", "true");
      }
      if (width === 390)
        await page.getByRole("button", { name: "Back to picks" }).click();
    }
  });
}
