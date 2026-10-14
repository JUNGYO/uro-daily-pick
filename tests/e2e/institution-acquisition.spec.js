const { test, expect } = require("../../frontend/node_modules/@playwright/test");
const { readArticle } = require("../../scripts/browser_fulltext.cjs");
const { BrowserQuota, PublisherPolicy, blockPublisherRequests } = require("../../scripts/browser_fulltext.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

test("durable quota blocks a browser redirect before transport and shares image capacity", async ({ browser }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uro-browser-quota-"));
  const policyPath = path.join(directory, "acquisition-policy.json");
  const python = process.env.URO_TEST_PYTHON || (process.platform === "win32"
    ? path.resolve(__dirname, "../../.venv/Scripts/python.exe") : "python");
  const script = path.resolve(__dirname, "../../scripts/acquisition_quota.py");
  fs.writeFileSync(policyPath, JSON.stringify({ version: 1, timezone: "Asia/Seoul",
    starts_at: "2020-01-01T00:00:00+09:00", daily_limit: 30, manual_reserve: 0 }));
  function command(...args) {
    const result = spawnSync(python, [script, "--policy", policyPath, ...args], { encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }
  command("initialize");
  command("reserve", "--publishers", "springer-nature", "--count", "28");
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/blocked-body" }); res.end(); }
    else { res.writeHead(200, { "Content-Type": "text/html" }); res.end("Synthetic local transport"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const context = await browser.newContext({ serviceWorkers: "block" });
  const nativeQuota = new BrowserQuota(policyPath, python);
  const navigation = { job: { doi: "10.1007/synthetic" } };
  // Only loopback receives transport. Translate that fixture's URL for the
  // real quota bridge; publisher/domain classification has separate unit tests.
  const quota = { before: (url, job) => {
    expect(new URL(url).hostname).toBe("127.0.0.1");
    nativeQuota.before("https://link.springer.com" + new URL(url).pathname, job);
  }};
  try {
    const page = await context.newPage();
    await blockPublisherRequests(context, page, new PublisherPolicy(null, quota), navigation);
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin + "/article"); // 29th reservation
    await expect(page.goto(origin + "/redirect")).rejects.toThrow(); // 30th then blocked redirect
    expect(hits.filter(url => url !== "/favicon.ico")).toEqual(["/article", "/redirect"]);
    expect(navigation.reason).toBe("quota_daily_limit");
    const restarted = new BrowserQuota(policyPath, python);
    expect(() => restarted.before("https://media.springernature.com/image.png", {})).toThrow("Acquisition deferred");
    expect(command("status").publishers["springer-nature"].automatic).toBe(30);
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true });
  }
});

// Real browser and extraction, entirely synthetic transport. No institution
// profile, external request, original document or credential is used.
test("lean article loading retains identical body, tables and figure links", async ({ browser }) => {
  const origin = "https://link.springer.com";
  const url = origin + "/article/10.1007/synthetic";
  const paragraph = "Synthetic methods and results describe outcome seventeen. ".repeat(55);
  const html = `<html><head><title>Synthetic article</title>
    <meta name="citation_doi" content="10.1007/synthetic">
    <link rel="stylesheet" href="${origin}/style.css"></head><body>
    <h1>Synthetic article</h1><article class="c-article-body">
    <section><h2>Methods</h2><p>${paragraph}</p></section>
    <section><h2>Results</h2><p>Outcome seventeen.</p>
    <img src="${origin}/figure.png" alt="Original figure">
    <video preload="auto" src="${origin}/movie.webm"></video>
    <a href="${url}/tables/1">Table 1</a></section></article>
    <script src="${origin}/app.js"></script></body></html>`;
  const runs = [];
  for (const lean of [false, true]) {
    const context = await browser.newContext({ serviceWorkers: "block", offline: true });
    const accepted = [];
    const blocked = [];
    const adapter = {
      newCDPSession: (page) => context.newCDPSession(page),
      newPage: async () => {
        const page = await context.newPage();
        const nativeGoto = page.goto.bind(page);
        // Redirect routing can skip a second interception. Start this extraction
        // fixture at its final synthetic URL and deny real transport entirely.
        page.goto = (address, options) => nativeGoto(address.startsWith("https://doi.org/") ? url : address, options);
        const nativeRoute = page.route.bind(page);
        page.route = (pattern, handler) => nativeRoute(pattern, async (route) => {
          const request = route.request();
          const resource = request.resourceType();
          // Baseline reproduces the previous route, which allowed these assets.
          const oldRequest = new Proxy(request, { get: (target, key) => key === "resourceType"
            ? () => "other" : typeof target[key] === "function" ? target[key].bind(target) : target[key] });
          return handler({
            request: () => lean ? request : oldRequest,
            abort: async () => { blocked.push(resource); await route.abort(); },
            continue: async () => {
              const address = request.url();
              accepted.push(resource);
              if (address === url) return route.fulfill({ contentType: "text/html", body: html });
              if (address === url + "/tables/1") return route.fulfill({ contentType: "text/html",
                body: "<title>Table 1</title><table><tr><td>Seventeen participants</td></tr></table>" });
              if (address === origin + "/style.css") return route.fulfill({ contentType: "text/css",
                body: `@font-face {font-family:Fixture;src:url('${origin}/font.woff2')} body{font-family:Fixture}` });
              if (address === origin + "/app.js") return route.fulfill({ contentType: "text/javascript",
                body: "document.body.dataset.appReady='yes'" });
              if ([origin + "/figure.png", origin + "/movie.webm", origin + "/font.woff2"].includes(address))
                return route.fulfill({ contentType: resource === "image" ? "image/png" : "application/octet-stream",
                  body: Buffer.alloc(1024 * 1024) });
              throw new Error("Unexpected synthetic request: " + address);
            },
          });
        });
        return page;
      },
    };
    try {
      const result = await readArticle(adapter, { doi: "10.1007/synthetic" });
      runs.push({ result, accepted, blocked });
    } finally { await context.close(); }
  }
  expect(runs[0].result.status).toBe("downloaded");
  expect(runs[1].result).toEqual(runs[0].result);
  expect(runs[1].result.html).toContain("Seventeen participants");
  expect(runs[1].result.html).toContain("/figure.png");
  expect(runs[0].accepted).toContain("image");
  expect(runs[1].blocked).toContain("image");
  expect(runs[1].accepted).toContain("script");
  expect(runs[1].accepted).toContain("stylesheet");
  expect(runs[1].accepted.filter(type => ["image", "font", "media"].includes(type))).toEqual([]);
});
