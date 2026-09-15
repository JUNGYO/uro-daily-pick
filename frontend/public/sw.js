/* Build substitutes the content fingerprint and application assets. No API or article caching. */
const VERSION = "__VERSION__";
const ASSETS = "__ASSETS__";
const CACHE = "uro-shell-" + VERSION;
const base = new URL("./",self.location.href).pathname;
const shell = Array.isArray(ASSETS) ? ASSETS.map(path=>base+path) : [];
self.addEventListener("install", event => event.waitUntil(
  caches.open(CACHE).then(cache=>cache.addAll(shell)).then(()=>self.skipWaiting())
));
self.addEventListener("activate", event => event.waitUntil(
  caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith("uro-shell-")&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())
));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method!=="GET" || url.origin!==self.location.origin) return;
  if (event.request.mode==="navigate" && url.pathname.startsWith(base)) {
    event.respondWith(fetch(event.request).catch(()=>caches.match(base+"index.html")));
  } else if (shell.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
  }
});
