import { OUTBOX_SYNC_TAG, runBackgroundSync } from "./background-sync.js";

const CACHE = "emergency-mesh-mobile-v10";
const ASSETS = [
  "/mobile/", "/mobile/styles.css", "/mobile/app.js", "/mobile/core.js",
  "/mobile/crypto.js", "/mobile/idb.js", "/mobile/i18n.js", "/mobile/protected.js",
  "/mobile/background-sync.js", "/mobile/manifest.webmanifest", "/mobile/icon.svg",
  "/mobile/commands.js", "/mobile/inbox.js", "/mobile/notices.js",
];

self.addEventListener("install", (event) => event.waitUntil(
  caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
));
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith("emergency-mesh-mobile-") && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()),
));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const isAsset = url.origin === self.location.origin && ASSETS.includes(url.pathname) && !url.search;
  const isMobileNavigation = event.request.mode === "navigate" && url.origin === self.location.origin && url.pathname.startsWith("/mobile/");
  // Never cache private API responses, operator pages or authenticated requests.
  if (!isAsset && !isMobileNavigation) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (isAsset && response.ok && !response.headers.get("cache-control")?.includes("no-store") && !event.request.headers.has("authorization")) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    if (event.request.mode === "navigate" && url.origin === self.location.origin && url.pathname.startsWith("/mobile/")) return caches.match("/mobile/");
    throw new TypeError("Offline and resource is not cached");
  }));
});

self.addEventListener("sync", (event) => {
  if (event.tag !== OUTBOX_SYNC_TAG) return;
  event.waitUntil(runBackgroundSync().then(async () => {
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) client.postMessage({ type: "OUTBOX_UPDATED" });
  }));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "COLUVI_CACHE_VERSION") event.ports[0]?.postMessage({ cache: CACHE, privateApiCache: false });
});
