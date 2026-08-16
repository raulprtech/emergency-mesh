import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BACKEND_RETRY_AFTER_MS,
  MemoryClientStore,
  createOutboxItem,
  synchronizeOutbox,
} from "../src/mobile-client/core.js";

const unsignedIdentity = { mode: "UNSIGNED", anonymousDeviceId: "retry-client" };
const noSignature = async (report: unknown) => report;

test("mobile outbox honors bounded backend retry guidance without losing custody", async () => {
  const now = 1_800_000_000_000;
  const store = new MemoryClientStore();
  const item = await createOutboxItem({ action: "SAFE", eventId: "retry-after-event" }, unsignedIdentity, now, noSignature);
  await store.put(item);
  let calls = 0;
  const limited = async () => {
    calls += 1;
    return {
      ok: false,
      status: 429,
      headers: { get: () => "7200" },
      json: async () => ({ status: "RATE_LIMITED", error: "ingest admission limit exceeded", retryAfterMs: 2 * MAX_BACKEND_RETRY_AFTER_MS }),
    };
  };
  await synchronizeOutbox(store, limited, "/api/packets", now);
  const queued = await store.get(item.eventId);
  assert.equal(queued?.state, "QUEUED");
  assert.equal(queued?.attempts, 1);
  assert.equal(queued?.lastError, "ingest admission limit exceeded");
  assert.equal(queued?.nextAttemptAt, now + MAX_BACKEND_RETRY_AFTER_MS);

  await synchronizeOutbox(store, async () => { calls += 1; throw new Error("retry occurred too early"); }, "/api/packets", now + 1_000);
  assert.equal(calls, 1);
  assert.equal((await store.get(item.eventId))?.attempts, 1);

  await synchronizeOutbox(store, async () => ({
    ok: true,
    status: 202,
    json: async () => ({ status: "ACCEPTED" }),
  }), "/api/packets", now + MAX_BACKEND_RETRY_AFTER_MS);
  const synced = await store.get(item.eventId);
  assert.equal(synced?.state, "SYNCED");
  assert.equal(synced?.attempts, 2);
  assert.equal(synced?.nextAttemptAt, undefined);
});
