import { test, expect } from "../../frontend/node_modules/@playwright/test/index.mjs";
import AxeBuilder from "../../frontend/node_modules/@axe-core/playwright/dist/index.mjs";

async function enlargeText(page, factor, selector = '.app-layout *') {
  // Model browser text enlargement without zooming boxes or disabling user sizing.
  await page.evaluate(({ factor, selector }) => {
    const targets = [...document.querySelectorAll(selector)].filter(el =>
      ['INPUT', 'SELECT'].includes(el.tagName) || [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
    const sizes = targets.map(el => [el, parseFloat(getComputedStyle(el).fontSize)]);
    for (const [el, size] of sizes) el.style.fontSize = `${size * factor}px`;
  }, { factor, selector });
}

async function layoutViolations(page) {
  return page.evaluate(() => {
    const errors = [], list = document.querySelector('.today-list'), bounds = list.getBoundingClientRect();
    const cards = [...list.querySelectorAll('.today-queue-item')];
    let previousBottom = -Infinity;
    cards.forEach((card, index) => {
      const box = card.getBoundingClientRect();
      if (box.top < previousBottom - 1) errors.push(`cards ${index - 1}/${index} overlap`);
      previousBottom = box.bottom;
      for (const child of card.querySelectorAll('.today-queue-title,.today-queue-meta,.today-queue-state,.today-type,.today-journal')) {
        const range = document.createRange();range.selectNodeContents(child);
        for (const rect of range.getClientRects()) {
          if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1 || rect.left < box.left - 1 || rect.right > box.right + 1)
            errors.push(`card ${index} ${child.className} spills outside its card`);
        }
      }
    });
    const progress = document.querySelector('.today-progress').getBoundingClientRect();
    const links = document.querySelector('.today-queue-links').getBoundingClientRect();
    const main = document.querySelector('main').getBoundingClientRect();
    const nav = document.querySelector('.app-layout > nav:last-child');
    if (bounds.top < progress.bottom - 1) errors.push('list overlaps progress');
    if (bounds.bottom > links.top + 1) errors.push('list overlaps footer links');
    if (getComputedStyle(nav).display !== 'none' && links.bottom > nav.getBoundingClientRect().top + 1)
      errors.push('footer links covered by bottom navigation');
    if (main.bottom > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1)
      errors.push('page overflows viewport');
    if (list.clientWidth < list.scrollWidth - 1) errors.push('list overflows horizontally');
    if (getComputedStyle(nav).display !== 'none') {
      for (const link of nav.querySelectorAll('a')) {
        const box = link.getBoundingClientRect(), range = document.createRange();
        range.selectNodeContents(link.querySelector('span'));
        for (const rect of range.getClientRects()) {
          if (rect.left < box.left - 1 || rect.right > box.right + 1 || rect.bottom > box.bottom + 1)
            errors.push('navigation label spills outside its link');
        }
      }
    }
    const date = document.querySelector('.today-date').getBoundingClientRect();
    for (const control of document.querySelectorAll('.today-date input,.today-date button')) {
      const box = control.getBoundingClientRect();
      if (box.left < date.left - 1 || box.right > date.right + 1 || Math.abs(box.top - date.top) > 1)
        errors.push('date controls overlap or wrap separately');
    }
    return errors;
  });
}

for (const [width, height, scale] of [[360, 640, 1], [320, 568, 1], [390, 640, 1.3], [360, 640, 2], [740, 360, 1], [1440, 760, 1]]) {
  test(`long daily cards stay contained at ${width}x${height}, text ${scale}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.route(/https?:\/\//, r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    await page.goto('/uro-daily-pick/?scenario=daily-long-titles&date=2026-09-01');
    const cards = page.locator('.today-queue-item'), list = page.locator('.today-list');
    await expect(cards).toHaveCount(5);
    if (scale !== 1) await enlargeText(page, scale);
    await page.screenshot({ path: info.outputPath('daily-long-list.png'), fullPage: true });
    expect(await layoutViolations(page)).toEqual([]);
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await cards.last().evaluate(el => {
      const a=el.getBoundingClientRect(), b=el.closest('.today-list').getBoundingClientRect();return a.bottom <= b.bottom + 1;
    })).toBe(true);
    await page.screenshot({ path: info.outputPath('daily-long-list-bottom.png'), fullPage: true });
    await cards.last().click();
    await expect(page.locator('.today-article')).toContainText('PMID 12345674');
    if (scale !== 1) await enlargeText(page, scale, '.today-reader *');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('daily-long-detail.png'), fullPage: true });
    await expect(page.getByRole('button', { name: '내 서재에 저장', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: '내 서재에 저장', exact: true }).click();
    if (width < 768) {
      await page.getByRole('button', { name: '논문 목록', exact: true }).click();
      await expect(cards.last()).toBeFocused();
    }
    await expect(cards.last()).toContainText('저장됨');
    expect(await layoutViolations(page)).toEqual([]);
    await list.evaluate(el => { el.scrollTop = 0; });
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(scan.violations).toEqual([]);
  });
}
