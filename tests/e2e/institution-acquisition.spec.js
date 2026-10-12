const { test, expect } = require("../../frontend/node_modules/@playwright/test");
const { readArticle } = require("../../scripts/browser_fulltext.cjs");

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
