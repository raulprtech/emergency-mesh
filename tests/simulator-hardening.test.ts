import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceBackend } from "../src/backend/backend.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { VirtualClock } from "../src/simulator/clock.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { LossyLinkAdapter } from "../src/simulator/lossy-link.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { SeededRandom } from "../src/simulator/random.ts";
import { InternetAdapter } from "../src/transports/internet.ts";

const base = 1_700_000_000_000;

test("virtual clock advances deterministically and never goes backwards", () => {
  const clock = new VirtualClock(base);
  assert.equal(clock.advance(2_000), base + 2_000);
  assert.throws(() => clock.advance(-1), /non-negative/);
  assert.throws(() => clock.set(base), /cannot move backwards/);
});

test("seeded lossy links reproduce the same delivery sequence", async () => {
  const report = makeReport({ createdAt: base });
  const origin = new SimulatedNode("origin", new DeterministicRoutingManager());
  const envelope = origin.create(report);
  const first = new LossyLinkAdapter("first", new SeededRandom(42), { lossRate: 0.5 });
  const second = new LossyLinkAdapter("second", new SeededRandom(42), { lossRate: 0.5 });
  first.connect(() => undefined);
  second.connect(() => undefined);
  const firstSequence: boolean[] = [];
  const secondSequence: boolean[] = [];
  for (let index = 0; index < 12; index += 1) {
    firstSequence.push((await first.send(envelope)).accepted);
    secondSequence.push((await second.send(envelope)).accepted);
  }
  assert.deepEqual(firstSequence, secondSequence);
  assert.ok(firstSequence.includes(true) && firstSequence.includes(false));
});

test("virtual time exposes retry only after exponential backoff", async () => {
  const clock = new VirtualClock(base);
  const node = new SimulatedNode("isolated", new DeterministicRoutingManager());
  node.create(makeReport({ createdAt: base }));
  assert.equal((await node.flush(clock.now())).length, 1);
  assert.equal((await node.flush(clock.advance(1_999))).length, 0);
  assert.equal((await node.flush(clock.advance(1))).length, 1);
});

test("LOW_BATTERY mode limits critical delivery to one path and accounts energy", async () => {
  const backend = new ReferenceBackend();
  const gateway = new Gateway("gateway", backend);
  const node = new SimulatedNode("battery-node", new DeterministicRoutingManager(), { batteryPercent: 5, energyMode: "LOW_BATTERY", maxCriticalPaths: 2 });
  const first = new InternetAdapter("internet-a", gateway);
  const second = new InternetAdapter("internet-b", gateway);
  first.setOnline(true);
  second.setOnline(true);
  node.addTransport(first);
  node.addTransport(second);
  const report = makeReport({ createdAt: Date.now(), eventId: "low-battery-event" });
  node.create(report);
  const [result] = await node.flush(report.createdAt);
  assert.equal(result.accepted.length, 1);
  assert.equal(backend.arrivalCount(report.eventId), 1);
  assert.ok(node.batteryPercent() < 5);
});
