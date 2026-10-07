import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

for (const width of [1440, 390]) {
  test(`opening clicks are immediate and distinct from dwell at ${width}px`, async ({ page, context }, info) => {
    await context.route(/https?:\/\//, route =>
      new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.setViewportSize({width,height:900});
    await page.clock.install();
    await page.goto("/uro-daily-pick/?scenario=admin-reader-opens");
    const events = () => page.evaluate(() => globalThis.__uroFixtureSnapshot().reader_open_events);
    await expect(page.getByRole("button", {name:/Personalized treatment strategies/})).toBeVisible();
    await page.clock.fastForward(12000);
    expect(await events()).toEqual([]);
    await page.reload();
    await page.getByRole("button", {name:/Personalized treatment strategies/}).click();
    await expect.poll(async () => (await events()).length).toBe(1);
    // Keyboard navigation applies in the reader, not while a queue button owns focus.
    await page.locator(".today-paper-title").focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await events()).length).toBe(2);
    await page.locator('a.today-original[href*="/fulltext/"]').click();
    await expect(page).toHaveURL(/\/fulltext\/12345671$/);
    await expect.poll(async () => (await events()).map(e=>e.kind)).toEqual(["detail","detail","original"]);
    await page.getByRole("link", {name:"문헌 탐색",exact:true}).filter({visible:true}).click();
    await page.getByRole("link", {name:/Personalized treatment strategies/}).click();
    await expect.poll(async () => (await events()).length).toBe(4);
    await page.getByRole("button", {name:"읽음 표시",exact:true}).click();
    expect((await events()).length).toBe(4);
    await page.getByRole("link", {name:"관리자",exact:true}).filter({visible:true}).click();
    const panel=page.getByRole("region",{name:"User Engagement",exact:true});
    await expect(panel.getByText("4회",{exact:true})).toBeVisible();
    await expect(panel.getByText("2편",{exact:true})).toBeVisible();
    await expect(panel.getByText("19회",{exact:true})).toHaveCount(0);
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const audit=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`clicks-${width}.png`)});
  });
}
