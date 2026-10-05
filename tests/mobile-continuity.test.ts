import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { MemoryClientStore, createOutboxItem, synchronizeOutbox, OUTBOX_REQUEST_TIMEOUT_MS } from "../src/mobile-client/core.js";

test("stalled HTTP headers or body time out without false confirmation and can retry the same packet", { timeout: 10_000 }, async () => {
  let mode = "headers"; let calls = 0;
  const server = createServer((request, response) => {
    calls++; request.resume();
    if (mode === "headers") return;
    response.writeHead(200, { "content-type": "application/json" }); response.write('{"status":"ACCEPTED",');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(OUTBOX_REQUEST_TIMEOUT_MS, 10_000);
    for (const scenario of ["headers", "body"]) {
      mode = scenario; const now = Date.now(); const store = new MemoryClientStore();
      const item = await createOutboxItem({ action: "SAFE" }, { mode: "UNSIGNED", anonymousDeviceId: "test-device" }, now, async report => report);
      await store.put(item);
      const start = performance.now();
      await synchronizeOutbox(store, fetch, `http://127.0.0.1:${(server.address() as { port: number }).port}/api/packets`, now, { requestTimeoutMs: 150 });
      assert.ok(performance.now() - start < 2000); const queued = await store.get(item.eventId);
      assert.equal(queued.state, "QUEUED"); assert.match(queued.lastError, /timed out/); assert.equal(queued.evidence.length, 0);
      assert.deepEqual(queued.envelope, item.envelope);
      await synchronizeOutbox(store, async () => ({ ok: true, json: async () => ({ status: "DUPLICATE", evidence: {
        acknowledgementId: "retry-ack", eventId: item.eventId, packetId: item.envelope.packetId, level: "BACKEND", issuerId: "test-backend", acknowledgedAt: now + 1, status: "DUPLICATE",
      } }) }), "/api/packets", now + 2);
      assert.equal((await store.get(item.eventId)).state, "SYNCED"); assert.equal((await store.list()).length, 1);
    }
    assert.equal(calls, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("failed local ACK write preserves the existing packet and retry requires correlated backend evidence", async () => {
  const now = Date.now(); const store = new MemoryClientStore();
  const item = await createOutboxItem({ action: "SAFE" }, { mode: "UNSIGNED", anonymousDeviceId: "test-device" }, now, async report => report);
  await store.put(item); const put = store.put.bind(store); let denyAck = true;
  store.put = async value => { if (denyAck && value.state === "SYNCED") throw new DOMException("Injected failure", "QuotaExceededError"); return put(value); };
  const outcome = async () => ({ ok: true, json: async () => ({ status: "DUPLICATE", evidence: { acknowledgementId: "ack", eventId: item.eventId,
    packetId: item.envelope.packetId, level: "BACKEND", issuerId: "backend", acknowledgedAt: now, status: "DUPLICATE" } }) });
  await assert.rejects(synchronizeOutbox(store, outcome, "/api/packets", now), { name: "QuotaExceededError" });
  assert.equal((await store.get(item.eventId)).state, "FORWARDED"); assert.equal((await store.get(item.eventId)).evidence.length, 0);
  denyAck = false; await synchronizeOutbox(store, outcome, "/api/packets", now + 1);
  assert.equal((await store.get(item.eventId)).state, "SYNCED"); assert.equal((await store.list()).length, 1);
});
