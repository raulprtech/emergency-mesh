import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/mobile-client/sw.js", import.meta.url), "utf8");

test("service worker precaches every module required by the offline shell", () => {
  for (const asset of ["/mobile/", "/mobile/app.js", "/mobile/core.js", "/mobile/crypto.js", "/mobile/idb.js", "/mobile/i18n.js", "/mobile/protected.js", "/mobile/styles.css", "/mobile/notices.js", "/mobile/inbox.js", "/mobile/diagnostics.js"]) {
    assert.match(source, new RegExp(asset.replaceAll("/", "\\/")));
  }
});

function workerHarness() {
  const handlers = new Map<string, (event: any) => void>();
  const puts: string[] = []; const deleted: string[] = [];
  const context = {
    URL,
    self: { location: { origin: "https://pilot.test" }, addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler), clients: { claim: async () => {} } },
    caches: {
      keys: async () => ["emergency-mesh-mobile-v7", "emergency-mesh-mobile-v8", "emergency-mesh-mobile-v9", "emergency-mesh-mobile-v10", "emergency-mesh-mobile-v11", "unrelated-cache"],
      delete: async (key: string) => { deleted.push(key); },
      open: async () => ({ put: async (request: any) => { puts.push(request.url); } }),
      match: async () => undefined,
    },
    fetch: async () => ({ ok: true, headers: new Headers({ "cache-control": "no-cache" }), clone: () => ({}) }),
  };
  runInNewContext(source.replace(/^import .*;\n/, 'const OUTBOX_SYNC_TAG="unused"; const runBackgroundSync=async()=>{};\n'), context);
  return { handlers, puts, deleted };
}

test("worker never intercepts or caches private, public API, remote, or operator requests", async () => {
  const harness = workerHarness();
  for (const path of ["/api/mobile/inbox", "/api/mobile/notices", "/api/operator/notices", "/api/operator/checkins", "/api/areas", "/health", "/command-center/", "https://other.test/mobile/app.js", "/mobile/app.js?token=private"]) {
    let intercepted = false;
    harness.handlers.get("fetch")!({
      request: { method: "GET", mode: "cors", url: new URL(path, "https://pilot.test").href, headers: new Headers() },
      respondWith: () => { intercepted = true; }, waitUntil: () => {},
    });
    assert.equal(intercepted, false, path);
  }
  assert.deepEqual(harness.puts, []);
});

test("worker caches only successful shell assets and purges its old caches without deleting unrelated ones", async () => {
  const harness = workerHarness();
  const pending: Promise<unknown>[] = [];
  let response: Promise<unknown> | undefined;
  harness.handlers.get("fetch")!({
    request: { method: "GET", mode: "cors", url: "https://pilot.test/mobile/app.js", headers: new Headers() },
    respondWith: (value: Promise<unknown>) => { response = value; }, waitUntil: (value: Promise<unknown>) => pending.push(value),
  });
  await response; await Promise.all(pending);
  assert.deepEqual(harness.puts, ["https://pilot.test/mobile/app.js"]);
  let activation: Promise<unknown> | undefined;
  harness.handlers.get("activate")!({ waitUntil: (value: Promise<unknown>) => { activation = value; } });
  await activation;
  assert.deepEqual(harness.deleted, ["emergency-mesh-mobile-v7", "emergency-mesh-mobile-v8", "emergency-mesh-mobile-v9", "emergency-mesh-mobile-v10"]);
});

test("authenticated asset requests never enter the shell cache", async () => {
  const harness = workerHarness();
  let response: Promise<unknown> | undefined;
  harness.handlers.get("fetch")!({
    request: { method: "GET", mode: "cors", url: "https://pilot.test/mobile/app.js", headers: new Headers({ authorization: "Bearer fictitious" }) },
    respondWith: (value: Promise<unknown>) => { response = value; }, waitUntil: () => {},
  });
  await response;
  assert.deepEqual(harness.puts, []);
});

test("offline shell fallback is restricted to same-origin mobile navigations", () => {
  assert.match(source, /event\.request\.mode === "navigate"/);
  assert.match(source, /url\.origin === self\.location\.origin/);
  assert.match(source, /url\.pathname\.startsWith\("\/mobile\/"\)/);
  assert.match(source, /throw new TypeError\("Offline and resource is not cached"\)/);
  assert.doesNotMatch(source, /cached \?\? caches\.match\("\/mobile\/"\)/);
});
