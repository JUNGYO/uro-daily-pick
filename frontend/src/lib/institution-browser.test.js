// Synthetic pages only: no browser is launched and no publisher is contacted.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
const require = createRequire(import.meta.url);
const {
  readArticle,
  readImage,
  PublisherPolicy,
  guardPage,
  blockPublisherRequests,
} = require("../../../scripts/browser_fulltext.cjs");
const articleUrl = "https://link.springer.com/article/10.1000/fixture";
const temporaryDirectories = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    const resolved = path.resolve(directory);
    const prefix = path.resolve(os.tmpdir()) + path.sep + "uro-publisher-policy-test-";
    if (!resolved.startsWith(prefix)) throw new Error("Unexpected test cleanup path");
    fs.rmSync(resolved, { recursive: true });
  }
});
function frozenClock() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
}
function fakeContext(page) {
  return {
    newPage: vi.fn(async () => page),
    newCDPSession: vi.fn(async () => ({
      on: vi.fn(),
      send: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
    })),
  };
}
function fakePage(
  { destination = articleUrl, status = 200, challenge = false, delayed = false, body = {} } = {},
  accepted = [],
) {
  const frame = {};
  const listeners = new Map();
  let routeHandler;
  let currentUrl = "about:blank";
  const result = {
    title: "Synthetic article",
    html: "<article>Synthetic body only</article>",
    characters: 2500,
    headings: ["Methods", "Results"],
    tables: [],
    loading: false,
    challenge,
    ...body,
  };
  const request = (url) => ({ url: () => url, isNavigationRequest: () => true, frame: () => frame });
  const response = (url, code) => ({ url: () => url, status: () => code, request: () => request(url) });
  async function navigate(url, code) {
    let aborted = false;
    await routeHandler({
      request: () => request(url),
      abort: async () => {
        aborted = true;
      },
      continue: async () => {
        accepted.push({ url, time: Date.now() });
      },
    });
    if (aborted) throw new Error("Synthetic route aborted");
    currentUrl = url;
    const received = response(url, code);
    await listeners.get("response")?.(received);
    return received;
  }
  return {
    route: vi.fn(async (_pattern, handler) => {
      routeHandler = handler;
    }),
    on: vi.fn((event, listener) => {
      listeners.set(event, listener);
    }),
    off: vi.fn((event) => {
      listeners.delete(event);
    }),
    mainFrame: () => frame,
    url: () => currentUrl,
    close: vi.fn(async () => {}),
    goto: vi.fn(async (url) => {
      const first = await navigate(url, delayed ? 200 : 302);
      return delayed ? first : navigate(destination, status);
    }),
    waitForURL: vi.fn(async () => {
      if (delayed) await navigate(destination, status);
    }),
    waitForLoadState: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({ ...result, tables: [...result.tables] })),
  };
}
test("an Elsevier destination is aborted before requesting it and returned as unsupported", async () => {
  frozenClock();
  const accepted = [];
  const page = fakePage(
    { destination: "https://www.sciencedirect.com/science/article/pii/SYNTHETIC" },
    accepted,
  );
  expect(await readArticle(fakeContext(page), { doi: "10.1000/fixture" })).toMatchObject({
    status: "unsupported",
    reason: "publisher_web_disabled",
  });
  expect(accepted.map((item) => new URL(item.url).hostname)).toEqual(["doi.org"]);
  expect(page.evaluate).not.toHaveBeenCalled();
  expect(page.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
test("a known Elsevier DOI is rejected without opening a browser page", async () => {
  const context = { newPage: vi.fn() };
  expect(await readArticle(context, { doi: "10.1016/synthetic" })).toMatchObject({
    status: "unsupported",
    reason: "publisher_web_disabled",
  });
  expect(context.newPage).not.toHaveBeenCalled();
});
test.each([403, 429])(
  "HTTP %i pauses the publisher and the next article sends no request to that host",
  async (status) => {
    frozenClock();
    const policy = new PublisherPolicy();
    const accepted = [];
    const first = fakePage({ status }, accepted);
    expect(await readArticle(fakeContext(first), { doi: "10.1000/first" }, policy)).toMatchObject({
      reason: `http_${status}`,
    });
    const count = accepted.filter((item) => new URL(item.url).hostname === "link.springer.com").length;
    expect(count).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    const second = fakePage({}, accepted);
    expect(await readArticle(fakeContext(second), { doi: "10.1000/second" }, policy)).toMatchObject({
      status: "access_required",
      reason: "publisher_paused",
    });
    expect(accepted.filter((item) => new URL(item.url).hostname === "link.springer.com")).toHaveLength(count);
    expect(second.evaluate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
test("a visible challenge immediately stops article and linked-table acquisition", async () => {
  frozenClock();
  const policy = new PublisherPolicy();
  const page = fakePage({ challenge: true, body: { tables: [articleUrl + "/tables/1"] } });
  const context = fakeContext(page);
  expect(await readArticle(context, { doi: "10.1000/fixture" }, policy)).toEqual({
    status: "challenge",
    reason: "publisher_check",
  });
  expect(policy.pauseFor("link.springer.com")).toMatchObject({ reason: "publisher_check" });
  expect(context.newPage).toHaveBeenCalledTimes(1);
  expect(page.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
test("a complete ordinary article is returned and all deadline timers are cleared", async () => {
  frozenClock();
  const page = fakePage();
  const result = await readArticle(fakeContext(page), { doi: "10.1000/fixture" });
  expect(result).toMatchObject({
    status: "downloaded",
    url: articleUrl,
    html: "<article>Synthetic body only</article>",
    characters: 2500,
  });
  expect(result).not.toHaveProperty("tables");
  expect(result).not.toHaveProperty("loading");
  expect(page.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
test("Springer and Nature share the one-second request interval", async () => {
  frozenClock();
  const policy = new PublisherPolicy();
  const deadline = Date.now() + 5000;
  await policy.before("link.springer.com", deadline);
  let released = false;
  const second = policy.before("www.nature.com", deadline).then(() => {
    released = true;
  });
  await vi.advanceTimersByTimeAsync(999);
  expect(released).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await second;
  expect(released).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
test("a route with insufficient remaining budget is aborted without requesting it", async () => {
  frozenClock();
  const policy = new PublisherPolicy();
  await policy.before("link.springer.com", Date.now() + 5000);
  const frame = {};
  let handler;
  const page = {
    mainFrame: () => frame,
    on: vi.fn(),
    route: async (_pattern, callback) => {
      handler = callback;
    },
  };
  const state = {};
  await guardPage(page, policy, Date.now() + 999, state);
  const route = {
    request: () => ({ url: () => articleUrl, isNavigationRequest: () => true, frame: () => frame }),
    abort: vi.fn(async () => {}),
    continue: vi.fn(async () => {}),
  };
  await handler(route);
  expect(state.reason).toBe("article_time_budget");
  expect(route.abort).toHaveBeenCalledTimes(1);
  expect(route.continue).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
test("a synthetic saved rate limit is respected after reopening the policy", async () => {
  frozenClock();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uro-publisher-policy-test-"));
  temporaryDirectories.push(directory);
  new PublisherPolicy(directory).observe("link.springer.com", 429);
  const restored = new PublisherPolicy(directory);
  await expect(restored.before("www.nature.com", Date.now() + 5000)).rejects.toMatchObject({
    reason: "publisher_paused",
  });
  expect(JSON.parse(fs.readFileSync(path.join(directory, "springer-nature.json"), "utf8"))).toEqual({
    reason: "http_429",
    until: Date.now() + 3600000,
  });
});
test("Elsevier images are rejected before opening a page", async () => {
  const context = { newPage: vi.fn() };
  expect(await readImage(context, { url: "https://ars.els-cdn.com/content/image/synthetic.png" })).toEqual({
    status: "unsupported",
  });
  expect(context.newPage).not.toHaveBeenCalled();
});
test("a stalled article is closed at its deadline and never accepted as full text", async () => {
  frozenClock();
  let rejectWait;
  const page = {
    route: async () => {},
    on: vi.fn(),
    goto: async () => ({ status: () => 200 }),
    waitForURL: async () => {},
    waitForLoadState: async () => {},
    url: () => articleUrl,
    waitForFunction: () =>
      new Promise((_resolve, reject) => {
        rejectWait = reject;
      }),
    evaluate: async () => {
      throw new Error("Page is closed");
    },
    close: vi.fn(async () => {
      rejectWait?.(new Error("Deadline reached"));
    }),
  };
  const reading = readArticle(fakeContext(page), { doi: "10.1000/fixture", budget_ms: 1000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(rejectWait).toBeTypeOf("function");
  await vi.advanceTimersByTimeAsync(1001);
  expect(await reading).toMatchObject({ status: "retryable_error" });
  expect(page.close).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
test.each([403, 429])(
  "a delayed DOI redirect's HTTP %i also pauses the destination publisher",
  async (status) => {
    frozenClock();
    const policy = new PublisherPolicy();
    const page = fakePage({ delayed: true, status, body: { characters: 0, headings: [] } });
    await readArticle(fakeContext(page), { doi: "10.1000/fixture" }, policy);
    expect(policy.pauseFor("link.springer.com")).toMatchObject({ reason: `http_${status}` });
    expect(vi.getTimerCount()).toBe(0);
  },
);
test("a deadline expiring while the interval timer waits prevents release", async () => {
  frozenClock();
  const policy = new PublisherPolicy();
  await policy.before("link.springer.com", Date.now() + 5000);
  const pending = policy.before("www.nature.com", Date.now() + 1500);
  const assertion = expect(pending).rejects.toMatchObject({ reason: "article_time_budget" });
  vi.setSystemTime(Date.now() + 5000);
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

test("Chromium destination blocking is configured for every disabled website and an already paused publisher", async () => {
  frozenClock();
  const policy = new PublisherPolicy();
  policy.observe("link.springer.com", 403);
  policy.observe("onlinelibrary.wiley.com", 429);
  const handlers = new Map();
  const page = { on: (event, handler) => handlers.set(event, handler) };
  const sessionHandlers = new Map();
  const session = {
    on: (event, handler) => sessionHandlers.set(event, handler),
    send: vi.fn(async () => {}),
  };
  const context = { newCDPSession: vi.fn(async () => session) };
  const navigation = {};
  await blockPublisherRequests(context, page, policy, navigation);
  const [command, { patterns }] = session.send.mock.calls[0];
  expect(command).toBe("Fetch.enable");
  const urls = patterns.map((pattern) => pattern.urlPattern);
  expect(patterns.every((pattern) => pattern.requestStage === "Request")).toBe(true);
  for (const domain of ["sciencedirect.com", "elsevier.com", "els-cdn.com"]) {
    expect(urls).toContain(`*://${domain}/*`);
    expect(urls).toContain(`*://*.${domain}/*`);
  }
  expect(urls).toContain("*://link.springer.com/*");
  expect(urls).toContain("*://www.nature.com/*");
  expect(urls).toContain("*://media.springernature.com/*");
  expect(urls).toContain("*://static-content.springer-cdn.com/*");
  expect(urls).toContain("*://*.onlinelibrary.wiley.com/*");
  sessionHandlers.get("Fetch.requestPaused")({
    requestId: "synthetic-hop",
    request: { url: "https://ars.els-cdn.com/synthetic.png" },
  });
  expect(session.send).toHaveBeenCalledWith("Fetch.failRequest", {
    requestId: "synthetic-hop",
    errorReason: "BlockedByClient",
  });
  expect(navigation.reason).toBe("publisher_web_disabled");
  handlers.get("requestfailed")({ url: () => "https://www.sciencedirect.com/science/article/synthetic" });
  expect(navigation.reason).toBe("publisher_web_disabled");
  handlers.get("requestfailed")({ url: () => articleUrl });
  expect(navigation.reason).toBe("publisher_paused");
});

test("a valid image returns its synthetic bytes and clears the deadline", async () => {
  frozenClock();
  const frame = {};
  const url = "https://media.springernature.com/synthetic.png";
  let route;
  const page = {
    mainFrame: () => frame,
    url: () => url,
    on: vi.fn(),
    route: vi.fn(async (_pattern, handler) => {
      route = handler;
    }),
    goto: vi.fn(async () => {
      let aborted = false;
      await route({
        request: () => ({ url: () => url, isNavigationRequest: () => true, frame: () => frame }),
        abort: async () => {
          aborted = true;
        },
        continue: async () => {},
      });
      if (aborted) throw new Error("Synthetic abort");
      return {
        status: () => 200,
        headers: () => ({ "content-type": "image/png", "content-length": "3" }),
        body: async () => Buffer.from([1, 2, 3]),
      };
    }),
    close: vi.fn(async () => {}),
  };
  expect(await readImage(fakeContext(page), { url })).toEqual({ status: "downloaded", data: "AQID" });
  expect(page.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a stalled image is closed at its deadline and cannot be returned as downloaded", async () => {
  frozenClock();
  const url = "https://media.springernature.com/synthetic.png";
  let rejectBody;
  const page = {
    on: vi.fn(),
    route: vi.fn(async () => {}),
    url: () => url,
    goto: vi.fn(async () => ({
      status: () => 200,
      headers: () => ({ "content-type": "image/png" }),
      body: () =>
        new Promise((_resolve, reject) => {
          rejectBody = reject;
        }),
    })),
    close: vi.fn(async () => {
      rejectBody?.(new Error("Synthetic page closed"));
    }),
  };
  const reading = readImage(fakeContext(page), { url, budget_ms: 1000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(rejectBody).toBeTypeOf("function");
  await vi.advanceTimersByTimeAsync(1001);
  expect(await reading).toEqual({ status: "unavailable" });
  expect(page.close).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["media.springernature.com", "static-content.springer-cdn.com"])(
  "a paused Springer article also stops image transport to %s",
  async (host) => {
    frozenClock();
    const policy = new PublisherPolicy();
    policy.observe("link.springer.com", 403);
    const url = `https://${host}/synthetic.png`;
    const accepted = [];
    const page = fakePage({ destination: url }, accepted);
    expect(await readImage(fakeContext(page), { url }, policy)).toEqual({ status: "unavailable" });
    expect(accepted).toEqual([]);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);
