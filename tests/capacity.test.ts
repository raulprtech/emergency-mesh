import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { SqliteStoreAndForwardQueue } from "../src/storage/sqlite-store.ts";
import { StoreAndForwardQueue } from "../src/storage/store.ts";
import { MockTransportAdapter } from "../src/transports/mock.ts";

const now = 1_700_000_000_000;
const factoryNode = new SimulatedNode("factory", new DeterministicRoutingManager());
const envelope = (eventId: string, priority: "CRITICAL" | "HIGH" | "NORMAL" | "LOW") =>
  factoryNode.create(makeReport({ eventId, priority, eventType: priority === "CRITICAL" ? "SOS" : "AREA_STATUS", createdAt: now }));

function assertPriorityEviction(queue: StoreAndForwardQueue | SqliteStoreAndForwardQueue): void {
  assert.equal(queue.enqueue(envelope("low", "LOW"), now), true);
  assert.equal(queue.enqueue(envelope("normal", "NORMAL"), now), true);
  assert.equal(queue.enqueue(envelope("critical", "CRITICAL"), now), true);
  assert.equal(queue.size(), 2);
  assert.equal(queue.has("low"), false, "lowest-priority record should yield custody");
  assert.equal(queue.hasSeen("low"), true, "eviction must not erase replay memory");
  assert.equal(queue.has("normal"), true);
  assert.equal(queue.has("critical"), true);
  assert.equal(queue.enqueue(envelope("another-low", "LOW"), now), false, "lower priority cannot evict protected records");
  assert.equal(queue.hasSeen("another-low"), false, "capacity rejection is not false custody");
}

test("in-memory capacity evicts only strictly lower-priority custody", () => {
  assertPriorityEviction(new StoreAndForwardQueue({ maxItems: 2 }));
});

test("SQLite capacity applies the same eviction policy transactionally", () => {
  const directory = mkdtempSync(join(tmpdir(), "emergency-mesh-capacity-"));
  const queue = new SqliteStoreAndForwardQueue(join(directory, "queue.sqlite"), { maxItems: 2 });
  try { assertPriorityEviction(queue); }
  finally { queue.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("oversized packet is rejected without entering replay memory", () => {
  const queue = new StoreAndForwardQueue({ maxBytes: 32 });
  const packet = envelope("oversized", "CRITICAL");
  assert.equal(queue.enqueue(packet, now), false);
  assert.equal(queue.size(), 0);
  assert.equal(queue.hasSeen(packet.report.eventId), false);
});

test("transport does not claim custody when a saturated peer rejects a packet", async () => {
  const targetQueue = new StoreAndForwardQueue({ maxItems: 1 });
  const target = new SimulatedNode("target", new DeterministicRoutingManager(), undefined, targetQueue);
  target.receive(envelope("protected-critical", "CRITICAL"), now);

  const sender = new SimulatedNode("sender", new DeterministicRoutingManager());
  const link = new MockTransportAdapter("bounded-link");
  link.connect((packet) => target.receive(packet, now));
  sender.addTransport(link);
  sender.create(makeReport({ eventId: "incoming-low", eventType: "AREA_STATUS", priority: "LOW", createdAt: now }));
  const [result] = await sender.flush(now);
  assert.deepEqual(result.accepted, []);
  assert.equal(sender.queue.has("incoming-low"), true, "sender keeps custody after peer rejection");
  assert.equal(target.queue.has("incoming-low"), false);
});
