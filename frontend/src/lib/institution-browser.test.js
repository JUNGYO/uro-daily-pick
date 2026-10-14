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

async function quotaTransport() {
  const handlers = new Map();
  const session = {on: (event, fn) => handlers.set(event, fn), send:vi.fn(async command => command === 'Page.getFrameTree' ? {frameTree:{frame:{id:'main'}}} : undefined)};
  const quota = {before:vi.fn(()=> 'a'.repeat(32)), call:vi.fn(()=>({ok:true}))};
  const policy = new PublisherPolicy(null, quota);
  const navigation = {job:{doi:'10.1007/synthetic',resource_kind:'original'}};
  const page = {on:vi.fn(), close:vi.fn(async()=>{})};
  await blockPublisherRequests({newCDPSession:async()=>session}, page, policy, navigation);
  const event = {requestId:'fetch-1',networkId:'network-1',frameId:'main',resourceType:'Document',
    request:{url:articleUrl}};
  return {handlers,session,quota,policy,navigation,event,
    paused: value=>handlers.get('Fetch.requestPaused')(value)};
}

test('403 releases its reservation once and preserves the publisher pause',async()=>{
  const h=await quotaTransport();
  await h.paused(h.event);
  await h.paused({...h.event,responseStatusCode:403});
  h.handlers.get('Network.loadingFailed')({requestId:h.event.networkId});
  expect(h.quota.call).toHaveBeenCalledExactlyOnceWith('failed',{},'',{requestId:'a'.repeat(32),reason:'http_403'});
  expect(h.policy.pauseFor('link.springer.com').reason).toBe('http_403');
  await h.paused({...h.event,requestId:'fetch-2',networkId:'network-2'});
  expect(h.quota.before).toHaveBeenCalledTimes(1);
  expect(h.navigation.reason).toBe('publisher_paused');
});

test('completed response remains charged when subsequent browser work fails',async()=>{
  const h=await quotaTransport();
  await h.paused(h.event);
  await h.paused({...h.event,responseStatusCode:200});
  expect(h.quota.call).not.toHaveBeenCalled();
  h.handlers.get('Network.loadingFinished')({requestId:h.event.networkId});
  h.handlers.get('Network.loadingFailed')({requestId:h.event.networkId});
  expect(h.quota.call).toHaveBeenCalledExactlyOnceWith('downloaded',{},'',{requestId:'a'.repeat(32),reason:undefined});
});

test('network failure releases a pending browser reservation',async()=>{
  const h=await quotaTransport();
  await h.paused(h.event);
  h.handlers.get('Network.loadingFailed')({requestId:h.event.networkId});
  expect(h.quota.call).toHaveBeenCalledExactlyOnceWith('failed',{},'',{requestId:'a'.repeat(32),reason:'transport_error'});
});

test('quota rejection reports only the blocked hostname and still prevents transport',async()=>{
  const h=await quotaTransport();
  h.quota.before.mockImplementation(()=>{throw Object.assign(new Error('unknown'),{reason:'quota_unknown_publisher'});});
  await h.paused({...h.event,request:{url:'https://unknown.example.test/article?secret=private'}});
  expect(h.navigation.blockedHost).toBe('unknown.example.test');
  expect(h.navigation.reason).toBe('quota_unknown_publisher');
  expect(JSON.stringify(h.navigation)).not.toContain('private');
  expect(h.session.send).toHaveBeenCalledWith('Fetch.failRequest',expect.objectContaining({requestId:h.event.requestId}));
});

test('redirect releases its own hop and charges the destination independently',async()=>{
  const h=await quotaTransport();
  await h.paused(h.event);
  await h.paused({...h.event,responseStatusCode:302});
  h.quota.before.mockReturnValue('b'.repeat(32));
  const next={...h.event,requestId:'fetch-2',redirectedRequestId:'fetch-1'};
  await h.paused(next);
  await h.paused({...next,responseStatusCode:200});
  h.handlers.get('Network.loadingFinished')({requestId:next.networkId});
  expect(h.quota.call.mock.calls.map(call=>[call[0],call[3].requestId])).toEqual([
    ['failed','a'.repeat(32)],['downloaded','b'.repeat(32)]]);
});
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

test('an advertisement iframe is blocked without reserving or failing the article',async()=>{
  const h=await quotaTransport();
  await h.paused({...h.event,frameId:'ad',request:{url:'https://ep2.adtrafficquality.google/frame'}});
  expect(h.quota.before).not.toHaveBeenCalled();
  expect(h.navigation.reason).toBeUndefined();
  expect(h.session.send).toHaveBeenCalledWith('Fetch.failRequest',expect.objectContaining({requestId:'fetch-1'}));
  await h.paused(h.event);
  await h.paused({...h.event,responseStatusCode:200});
  h.handlers.get('Network.loadingFinished')({requestId:'network-1'});
  expect(h.quota.call).toHaveBeenCalledExactlyOnceWith('downloaded',{},'',expect.any(Object));
});

test('a top-level unknown destination is still blocked and charged nowhere',async()=>{
  const h=await quotaTransport();
  h.quota.before.mockImplementation(()=>{throw Object.assign(new Error(),{reason:'quota_unknown_publisher'});});
  await h.paused({...h.event,request:{url:'https://ep2.adtrafficquality.google/article'}});
  expect(h.navigation.reason).toBe('quota_unknown_publisher');
});

test('only a Wiley-initiated exact CONNECT hop is uncharged, and its return article is charged',async()=>{
  const h=await quotaTransport();
  await h.paused({...h.event,request:{url:'https://onlinelibrary.wiley.com/doi/10.1111/synthetic'}});
  await h.paused({...h.event,responseStatusCode:302,request:{url:'https://onlinelibrary.wiley.com/doi/10.1111/synthetic'}});
  await h.paused({...h.event,requestId:'auth',request:{url:'https://wiley.scienceconnect.io/auth'}});
  expect(h.quota.before).toHaveBeenCalledTimes(1);
  await h.paused({...h.event,requestId:'return',request:{url:'https://onlinelibrary.wiley.com/doi/10.1111/synthetic'}});
  expect(h.quota.before).toHaveBeenCalledTimes(2);
  const unrelated=await quotaTransport();
  await unrelated.paused({...unrelated.event,request:{url:'https://wiley.scienceconnect.io/auth'}});
  expect(unrelated.navigation.reason).toBe('unsupported_publisher');
  expect(unrelated.quota.before).not.toHaveBeenCalled();
});

test.each([200,403])('a documented HTTP %i automatic-check document is uncharged and may complete normally',async status=>{
  const h=await quotaTransport();
  await h.paused(h.event);
  await h.paused({...h.event,responseStatusCode:status,responseHeaders:[{name:'cf-mitigated',value:'challenge'}]});
  expect(h.policy.pauseFor('link.springer.com')).toBeNull();
  expect(h.navigation.checkPending).toBe(true);
  expect(h.quota.call).toHaveBeenCalledWith('failed',{},'',expect.objectContaining({reason:'automatic_check_document'}));
  await h.paused({...h.event,requestId:'resolved',networkId:'resolved'});
  await h.paused({...h.event,requestId:'resolved',networkId:'resolved',responseStatusCode:200});
  h.handlers.get('Network.loadingFinished')({requestId:'resolved'});
  expect(h.navigation.checkPending).toBe(false);
  expect(h.quota.call).toHaveBeenLastCalledWith('downloaded',{},'',expect.any(Object));
});

test('repeated automatic checks cannot extend their original deadline',async()=>{
  frozenClock();
  const h=await quotaTransport();
  await h.paused(h.event);
  const checked={...h.event,responseStatusCode:403,responseHeaders:[{name:'cf-mitigated',value:'challenge'}]};
  await h.paused(checked);
  const end=h.navigation.checkUntil;
  await vi.advanceTimersByTimeAsync(20000);
  await h.paused(checked);
  expect(h.navigation.checkUntil).toBe(end);
  await vi.advanceTimersByTimeAsync(10001);
  await h.paused({...h.event,requestId:'too-late'});
  expect(h.quota.before).toHaveBeenCalledTimes(1);
  expect(h.navigation.reason).toBe('publisher_check');
});

test('an unresolved automatic check pauses all workers and closes without retrying',async()=>{
  const page=fakePage({status:403});
  const original=page.goto;
  page.goto=vi.fn(async url=>({...await original(url),headers:()=>({'cf-mitigated':'challenge'})}));
  // Simulate the same header on the response listener as the returned response.
  const policy=new PublisherPolicy(null,{call:vi.fn(()=>({ok:true}))});
  const result=await readArticle(fakeContext(page),{doi:'10.1007/synthetic'},policy);
  expect(result).toMatchObject({status:'challenge',reason:'publisher_check'});
  expect(policy.quota.call).toHaveBeenCalledWith('pause',expect.any(Object),expect.any(String),{reason:'publisher_check'});
  expect(page.goto).toHaveBeenCalledTimes(1);
  expect(page.close).toHaveBeenCalledTimes(1);
});

test('article identity uses citation metadata instead of a site-header h1',async()=>{
  const previousHead=document.head.innerHTML, previousBody=document.body.innerHTML;
  try {
    document.head.innerHTML='<meta name="citation_title" content="The actual study"><meta name="citation_doi" content="10.1007/synthetic">';
    document.body.innerHTML='<h1>Institution sign in</h1><div class="c-article-body"><h2>Methods</h2><p>'+
      'Synthetic measured observations. '.repeat(100)+'</p><h2>Results</h2><p>Outcome 17.</p></div>';
    for (const element of [document.body,document.querySelector('.c-article-body')])
      Object.defineProperty(element,'innerText',{configurable:true,value:element.textContent});
    const page=fakePage();
    page.evaluate.mockImplementation(async (fn,arg)=>fn(arg));
    const result=await readArticle(fakeContext(page),{doi:'10.1007/synthetic'});
    expect(result.title).toBe('The actual study');
    expect(result.doi).toBe('10.1007/synthetic');
    expect(result.status).toBe('downloaded');
  } finally {delete document.body.innerText;document.head.innerHTML=previousHead;document.body.innerHTML=previousBody;}
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

test.each(["image", "media", "font", "script", "stylesheet", "xhr", "fetch", "document"])(
  "article acquisition handles %s without dropping text application requests",
  async (type) => {
    const frame = {};
    let handler;
    const policy = new PublisherPolicy();
    const before = vi.spyOn(policy, "before");
    const page = {
      mainFrame: () => frame,
      route: async (_pattern, callback) => { handler = callback; },
    };
    await guardPage(page, policy, Date.now() + 5000, {});
    const route = {
      request: () => ({
        url: () => articleUrl,
        isNavigationRequest: () => type === "document",
        frame: () => frame,
        resourceType: () => type,
      }),
      abort: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
    };
    await handler(route);
    const omitted = ["image", "media", "font"].includes(type);
    expect(route.abort).toHaveBeenCalledTimes(omitted ? 1 : 0);
    expect(route.continue).toHaveBeenCalledTimes(omitted ? 0 : 1);
    expect(before).toHaveBeenCalledTimes(type === "document" ? 1 : 0);
  },
);
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
  const [command, { patterns }] = session.send.mock.calls.find(call=>call[0]==='Fetch.enable');
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


test('auxiliary redirects cannot download another article without original quota', async()=>{
  const h=await quotaTransport();
  const url=articleUrl+'/tables/1';
  h.navigation.auxiliaryUrl=url;
  h.navigation.job.resource_kind='table';
  await h.paused({...h.event,request:{url}});
  expect(h.quota.before).toHaveBeenCalledWith(url, expect.objectContaining({resource_kind:'table'}));
  await h.paused({...h.event,requestId:'other',request:{url:articleUrl}});
  expect(h.quota.before).toHaveBeenCalledTimes(1);
  expect(h.navigation.reason).toBe('auxiliary_redirect_not_permitted');
  expect(h.session.send).toHaveBeenCalledWith('Fetch.failRequest', expect.objectContaining({requestId:'other'}));
});

test('article reads force original accounting and only its own linked tables use table receipts',async()=>{
  const tableUrl=articleUrl+'/tables/1';
  const article=fakePage({body:{tables:[tableUrl, 'https://link.springer.com/article/other/tables/1']}});
  const table=fakePage({destination:tableUrl});
  table.waitForSelector=vi.fn(async()=>{});
  table.evaluate=vi.fn(async()=>'<table><tr><td>17</td></tr></table>');
  const handlers=new Map();
  const context={
    newPage:vi.fn().mockResolvedValueOnce(article).mockResolvedValueOnce(table),
    newCDPSession:vi.fn(async page=>({on:(event,fn)=>{if(event==='Fetch.requestPaused')handlers.set(page,fn);},send:vi.fn(async()=>{})})),
  };
  for (const page of [article,table]) {
    const goto=page.goto;
    page.goto=async url=>{
      await handlers.get(page)({requestId:page===article?'article':'table',resourceType:'Document',request:{url}});
      return goto(url);
    };
  }
  const quota={call:vi.fn(()=>({ok:true})),before:vi.fn(()=> 'a'.repeat(32))};
  const policy=new PublisherPolicy(null,quota);
  policy.before=vi.fn(async()=>{});
  const result=await readArticle(context,{doi:'10.1007/synthetic',resource_kind:'figure'},policy);
  expect(result.status).toBe('downloaded');
  expect(result.html).toContain('<td>17</td>');
  expect(quota.before).toHaveBeenCalledWith(expect.stringContaining('doi.org'),expect.objectContaining({resource_kind:'original'}));
  expect(quota.before).toHaveBeenCalledWith(tableUrl,expect.objectContaining({resource_kind:'table'}));
  expect(context.newPage).toHaveBeenCalledTimes(2);
});

test('image preflight uses its separate category even when an input requests original',async()=>{
  const quota={call:vi.fn(()=>{throw Object.assign(new Error('pause'),{reason:'quota_source_paused'});})};
  const context={newPage:vi.fn()};
  expect(await readImage(context,{url:'https://link.springer.com/image.png',resource_kind:'original'},new PublisherPolicy(null,quota)))
    .toMatchObject({status:'unavailable',reason:'quota_source_paused'});
  expect(quota.call).toHaveBeenCalledWith('check',expect.objectContaining({resource_kind:'figure'}),'https://link.springer.com/image.png');
  expect(context.newPage).not.toHaveBeenCalled();
});
