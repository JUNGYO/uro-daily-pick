import {
  test,
  expect,
} from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

const start = "/uro-daily-pick/insights?scenario=atlas-whole-corpus";
const rareLabel = "Rare pathway outside the first hundred";
const rareId = (1129).toString(16).padStart(24, "0");
const graph = (page) =>
  page.getByRole("group", { name: "Concept map from full texts" });
const parameters = (page) => new URL(page.url()).searchParams;

test.beforeEach(async ({ page }) => {
  await page.route(/https?:\/\//, (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
});

async function activate(locator) {
  await locator.focus();
  await locator.press("Enter");
}

async function openDisease(page) {
  const showGraph = page.getByRole("button", {
    name: "Show graph",
    exact: true,
  });
  if (await showGraph.isVisible()) await showGraph.click();
  await activate(
    graph(page).getByRole("button", { name: /^Disease, 130 concepts,/ }),
  );
  await expect(page.locator(".concept-atlas-summary")).toContainText(
    "130 concepts represented",
  );
  expect(parameters(page).get("category")).toBe("condition");
}

async function openRareRange(page) {
  await openDisease(page);
  await activate(graph(page).getByRole("button", { name: /, 50 concepts,/ }));
  await expect(page.locator(".concept-atlas-summary")).toContainText(
    "50 concepts represented",
  );
  expect(parameters(page).get("prefix")).toBe("1");
}

async function assertNoOverflow(page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const viewport = await page
    .locator(".concept-atlas-viewport")
    .evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
}

for (const width of [1440, 320]) {
  test(`whole concept map reaches rare concepts and returns without losing coverage at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(start);
    await expect(page.locator(".concept-atlas-summary")).toContainText(
      "260 concepts represented",
    );
    await expect(graph(page).locator(".concept-atlas-node")).toHaveCount(3);
    await expect(
      graph(page).getByRole("button", { name: /^Technique, 90 concepts,/ }),
    ).toBeVisible();
    await expect(
      graph(page).getByRole("button", { name: /^Substance, 40 concepts,/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: /Node limit/i }),
    ).toHaveCount(0);
    await assertNoOverflow(page);
    await page
      .locator(".concept-atlas")
      .screenshot({ path: info.outputPath(`whole-concept-map-${width}.png`) });

    await openRareRange(page);
    await expect(graph(page).locator(".concept-atlas-node")).toHaveCount(50);
    await expect(
      graph(page).getByRole("button", {
        name: new RegExp(`^${rareLabel}, 1 papers,`),
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Concept map path" }),
    ).toContainText("Disease");
    await page
      .locator(".concept-atlas")
      .screenshot({ path: info.outputPath(`concept-range-${width}.png`) });
    await page
      .getByRole("button", {
        name: "Show accessible concept list",
        exact: true,
      })
      .click();
    const list = page.getByRole("list", {
      name: "All concepts and groups in this view",
    });
    await expect(list.getByRole("listitem")).toHaveCount(50);
    await expect(
      list.getByRole("button", { name: new RegExp(rareLabel) }),
    ).toBeVisible();
    await assertNoOverflow(page);
    const audit = await new AxeBuilder({ page })
      .include("main")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`whole-concept-list-${width}.png`),
    });

    await list.getByRole("button", { name: new RegExp(rareLabel) }).click();
    await expect(
      page
        .getByRole("complementary", { name: "Selected research" })
        .getByRole("heading", { name: rareLabel, exact: true }),
    ).toBeVisible();
    expect(parameters(page).get("concept")).toBe(rareId);
    expect(parameters(page).has("category")).toBe(false);
    expect(parameters(page).has("prefix")).toBe(false);
    await expect(page.locator(".concept-atlas-summary")).toContainText(
      "87 concepts represented",
    );
    await expect(page.locator(".atlas-paper")).toHaveCount(1);
    await expect(
      page.getByRole("button", {
        name: "2024: 1 papers; 1 structured",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Research record", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Bibliographic record" }),
    ).toBeVisible();
    await assertNoOverflow(page);

    await page
      .getByRole("navigation", { name: "Concept map path" })
      .getByRole("button", { name: "All concepts", exact: true })
      .click();
    await expect(page.locator(".concept-atlas-summary")).toContainText(
      "260 concepts represented",
    );
    expect(parameters(page).has("concept")).toBe(false);
    await openRareRange(page);
    await page
      .getByRole("navigation", { name: "Concept map path" })
      .getByRole("button", { name: "Disease", exact: true })
      .click();
    await expect(page.locator(".concept-atlas-summary")).toContainText(
      "130 concepts represented",
    );
    expect(parameters(page).has("prefix")).toBe(false);
    await page.getByRole("button", { name: "Whole map", exact: true }).click();
    await expect(page.locator(".concept-atlas-summary")).toContainText(
      "260 concepts represented",
    );
    expect(parameters(page).has("category")).toBe(false);
    await assertNoOverflow(page);
    const graphAudit = await new AxeBuilder({ page })
      .include("main")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(graphAudit.violations).toEqual([]);
  });
}

test("new search and publication-year filters discard an old alphabetical range", async ({
  page,
}) => {
  await page.goto(`${start}&category=condition&prefix=1`);
  await expect(page.locator(".concept-atlas-summary")).toContainText(
    "50 concepts represented",
  );
  await page
    .getByLabel("Search concepts, papers or identifiers")
    .fill("prostate");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => parameters(page).get("q")).toBe("prostate");
  expect(parameters(page).has("category")).toBe(false);
  expect(parameters(page).has("prefix")).toBe(false);

  await page.goto(`${start}&category=condition&prefix=1`);
  await expect(page.locator(".concept-atlas-summary")).toContainText(
    "50 concepts represented",
  );
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .getByRole("combobox", { name: "From year", exact: true })
    .selectOption("2024");
  await expect.poll(() => parameters(page).get("from")).toBe("2024");
  expect(parameters(page).has("category")).toBe(false);
  expect(parameters(page).has("prefix")).toBe(false);
});

test("group citation navigation round-trips the same branch and clears it on changed filters", async ({
  page,
}) => {
  await page.goto(`${start}&project=1&returnTo=%2Fprojects%3Fproject%3D1`);
  await openRareRange(page);
  await page.getByRole("button", { name: "Citations", exact: true }).click();
  await expect.poll(() => parameters(page).get("relation")).toBe("citations");
  expect(parameters(page).get("scopeCategory")).toBe("condition");
  expect(parameters(page).get("scopePrefix")).toBe("1");
  expect(parameters(page).has("category")).toBe(false);
  expect(parameters(page).has("prefix")).toBe(false);
  expect(parameters(page).get("project")).toBe("1");
  expect(parameters(page).get("returnTo")).toBe("/projects?project=1");
  await page.getByRole("button", { name: "Concepts", exact: true }).click();
  await expect(page.locator(".concept-atlas-summary")).toContainText(
    "50 concepts represented",
  );
  expect(parameters(page).get("category")).toBe("condition");
  expect(parameters(page).get("prefix")).toBe("1");
  expect(parameters(page).has("scopeCategory")).toBe(false);
  expect(parameters(page).has("scopePrefix")).toBe(false);

  await page.getByRole("button", { name: "Citations", exact: true }).click();
  await expect.poll(() => parameters(page).get("scopePrefix")).toBe("1");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .getByRole("combobox", { name: "To year", exact: true })
    .selectOption("2024");
  await expect.poll(() => parameters(page).get("to")).toBe("2024");
  expect(parameters(page).has("scopeCategory")).toBe(false);
  expect(parameters(page).has("scopePrefix")).toBe(false);
  expect(parameters(page).get("project")).toBe("1");
});
