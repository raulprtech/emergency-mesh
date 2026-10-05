import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mobileAsset } from "../src/mobile-client/assets.ts";
import {
  OUTBOX_SYNC_LOCK,
  OUTBOX_SYNC_TAG,
  runBackgroundSync,
  synchronizeOutboxExclusively,
} from "../src/mobile-client/background-sync.js";

test("foreground and background synchronization share an exclusive lock", async () => {
  const store = { marker: "store" };
  let requestedLock;
  let synchronizedStore;
  const results = await synchronizeOutboxExclusively(store, {
    locks: {
      request: async (name, callback) => {
        requestedLock = name;
        return callback();
      },
    },
    synchronize: async (received) => {
      synchronizedStore = received;
      return [{ state: "SYNCED" }];
    },
  });
  assert.equal(requestedLock, OUTBOX_SYNC_LOCK);
  assert.equal(synchronizedStore, store);
  assert.deepEqual(results, [{ state: "SYNCED" }]);
});

test("background synchronization requests a retry while custody remains local", async () => {
  let closed = false;
  await assert.rejects(runBackgroundSync({
    openDatabase: async () => ({ close: () => { closed = true; } }),
    locks: { request: async (_name, callback) => callback() },
    synchronize: async () => [{ state: "QUEUED" }],
  }), /awaiting backend custody/);
  assert.equal(closed, true);
});

test("server exposes the background module with a JavaScript content type", () => {
  const asset = mobileAsset("/mobile/background-sync.js");
  assert.ok(asset);
  assert.equal(asset.contentType, "text/javascript; charset=utf-8");
  assert.match(asset.body.toString("utf8"), /runBackgroundSync/);
});

test("PWA registers a module worker and one-shot outbox sync", () => {
  const app = readFileSync(new URL("../src/mobile-client/app.js", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../src/mobile-client/sw.js", import.meta.url), "utf8");
  assert.equal(OUTBOX_SYNC_TAG, "emergency-mesh-outbox");
  assert.match(app, /register\("\/mobile\/sw\.js", \{ type: "module" \}\)/);
  assert.match(app, /registration\.sync\.register\(OUTBOX_SYNC_TAG\)/);
  assert.match(worker, /addEventListener\("sync"/);
  assert.match(worker, /runBackgroundSync\(\)/);
  assert.match(worker, /"\/mobile\/background-sync\.js"/);
});
