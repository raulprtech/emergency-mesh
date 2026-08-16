import { OUTBOX_SYNC_TAG, runBackgroundSync } from "./background-sync.js";

const CACHE = "emergency-mesh-mobile-v6";
const ASSETS = [
  "/mobile/", "/mobile/styles.css", "/mobile/app.js", "/mobile/core.js",
  "/mobile/crypto.js", "/mobile/idb.js", "/mobile/i18n.js", "/mobile/protected.js",
  "/mobile/background-sync.js", "/mobile/manifest.webmanifest", "/mobile/icon.svg",
];

self.addEventListener("install", (event) => event.waitUntil(
  caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
));
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()),
));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const url = new URL(event.request.url);
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
