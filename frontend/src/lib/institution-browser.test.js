// No browser or publisher requests: exercise the hung-page deadline with a fake page.
import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vitest";
const require = createRequire(import.meta.url);
const { readArticle } = require("../../../scripts/browser_fulltext.cjs");
afterEach(() => vi.useRealTimers());

test("a stalled article is closed at its deadline and never accepted as full text", async () => {
  vi.useFakeTimers();
  let rejectWait;
  const page = {
    route: async () => {},
    goto: async () => ({ status: () => 200 }),
    waitForURL: async () => {},
    waitForLoadState: async () => {},
    url: () => "https://link.springer.com/article/10.1000/fixture",
    waitForFunction: () => new Promise((_resolve, reject) => { rejectWait = reject; }),
    evaluate: async () => { throw new Error("Page is closed"); },
    close: vi.fn(async () => { rejectWait?.(new Error("Deadline reached")); }),
  };
  const reading = readArticle({ newPage: async () => page }, { doi: "10.1000/fixture", budget_ms: 1000 });
  await vi.advanceTimersByTimeAsync(1001);
  expect(await reading).toMatchObject({ status: "retryable_error" });
  expect(page.close).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
