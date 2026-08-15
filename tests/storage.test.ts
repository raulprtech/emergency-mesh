import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { StoreAndForwardQueue } from "../src/storage/store.ts";

const base = 1_700_000_000_000;

test("TTL and expiration stop forwarding", () => {
  const node = new SimulatedNode("origin", new DeterministicRoutingManager());
  const expired = node.create(makeReport({ createdAt: base }), 1_000);
  const queue = new StoreAndForwardQueue();
  assert.equal(queue.enqueue(expired, base), true);
  assert.equal(queue.ready(base + 999).length, 1);
  assert.equal(queue.ready(base + 1_000).length, 0);
  assert.equal(queue.size(), 0);

  const hopLimited = { ...expired, expiresAt: base + 10_000, hopCount: 2, hopLimit: 2 };
  const hopQueue = new StoreAndForwardQueue();
  assert.equal(hopQueue.enqueue(hopLimited, base), true);
  assert.equal(hopQueue.ready(base).length, 0);
});

test("deduplication retains one queued copy per eventId", () => {
  const node = new SimulatedNode("origin", new DeterministicRoutingManager());
  const envelope = node.create(makeReport({ createdAt: base, eventId: "same-event" }));
  const queue = new StoreAndForwardQueue();
  assert.equal(queue.enqueue(envelope, base), true);
  assert.equal(queue.enqueue(structuredClone(envelope), base), false);
  assert.equal(queue.size(), 1);
});

test("priority queue serves CRITICAL before HIGH, NORMAL and LOW", () => {
  const queue = new StoreAndForwardQueue();
  const node = new SimulatedNode("origin", new DeterministicRoutingManager());
  for (const [index, priority] of ["LOW", "NORMAL", "CRITICAL", "HIGH"].entries()) {
    const envelope = node.create(makeReport({ createdAt: base + index, eventId: `priority-${priority}`, priority: priority as "LOW" | "NORMAL" | "CRITICAL" | "HIGH", eventType: "AREA_STATUS" }));
    queue.enqueue(envelope, base + index);
  }
  assert.deepEqual(queue.ready(base + 10).map((item) => item.envelope.report.priority), ["CRITICAL", "HIGH", "NORMAL", "LOW"]);
});
