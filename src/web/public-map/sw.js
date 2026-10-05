const CACHE = "coluvi-public-map-v1";
const ASSETS = ["/map/", "/map/app.js", "/map/model.js", "/map/storage.js", "/map/styles.css", "/map/basemap.json", "/map/zones.json"];
self.addEventListener("install", event => event.waitUntil((async () => { const cache = await caches.open(CACHE); await cache.addAll(ASSETS); await self.skipWaiting(); })()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith("coluvi-public-map-") && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener("fetch", event => {
  const request = event.request; const url = new URL(request.url);
  // No API, authentication, arbitrary navigation, or operator data enters this cache.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.search || request.headers.has("authorization") || !ASSETS.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok && !response.headers.get("cache-control")?.includes("no-store")) { await cache.put(request, response.clone()); return response; }
      return (await cache.match(request)) ?? response;
    } catch { return (await cache.match(request)) ?? Response.error(); }
  })());
});
