import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceBackend } from "../src/backend/backend.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { VirtualClock } from "../src/simulator/clock.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { EgressTracker } from "../src/transports/egress.ts";
import { InternetAdapter } from "../src/transports/internet.ts";
import type { DeliveryAcknowledgement } from "../src/transports/transport.ts";

const base = 1_800_000_000_000;

function acknowledgement(level: "PEER" | "GATEWAY" | "BACKEND", at: number): DeliveryAcknowledgement {
  return { acknowledgementId: `ack-${level}-${at}`, eventId: "event", packetId: "packet", level, acknowledgedAt: at, issuerId: "issuer", status: level === "PEER" ? "CUSTODY_ACCEPTED" : "STORED" };
}

test("egress transitions UNKNOWN → REPORTED → STALE by freshness", () => {
  const tracker = new EgressTracker(["internet"], { reportedTtlMs: 1_000, confirmedTtlMs: 5_000 });
  assert.equal(tracker.advertisement(base).state, "UNKNOWN");
  tracker.report(0.8, base);
  assert.equal(tracker.advertisement(base + 1_000).state, "REPORTED");
  assert.equal(tracker.advertisement(base + 1_001).state, "STALE");
  assert.equal(tracker.advertisement(base + 1_001).quality, 0);
});

test("only gateway/backend evidence confirms egress and confirmation becomes stale", () => {
  const tracker = new EgressTracker(["internet"], { reportedTtlMs: 1_000, confirmedTtlMs: 5_000 });
  tracker.report(0.8, base);
  assert.equal(tracker.confirm(acknowledgement("PEER", base + 10)), false);
  assert.equal(tracker.advertisement(base + 10).state, "REPORTED");
  assert.equal(tracker.confirm(acknowledgement("BACKEND", base + 20)), true);
  assert.equal(tracker.advertisement(base + 5_020).state, "CONFIRMED");
  assert.equal(tracker.advertisement(base + 5_021).state, "STALE");
});

test("Internet delivery returns backend evidence, confirms egress, and records it on the node", async () => {
  const clock = new VirtualClock(base);
  const backend = new ReferenceBackend();
  const gateway = new Gateway("gateway", backend);
  const internet = new InternetAdapter("internet", gateway, () => clock.now());
  internet.setOnline(true);
  assert.equal(internet.egressAdvertisement().state, "REPORTED");

  const node = new SimulatedNode("node", new DeterministicRoutingManager());
  node.addTransport(internet);
  const report = makeReport({ eventId: "ack-event", createdAt: base });
  node.create(report);
  const [result] = await node.flush(base);
  assert.deepEqual(result.accepted, ["internet"]);
  assert.equal(internet.egressAdvertisement().state, "CONFIRMED");
  const evidence = node.deliveryEvidence.get(report.eventId);
  assert.equal(evidence?.length, 1);
  assert.equal(evidence?.[0].level, "BACKEND");
  assert.equal(evidence?.[0].status, "STORED");
  assert.equal(node.deliveryStates.get(report.eventId), "SYNCED");
});

test("disconnect changes previously confirmed egress to STALE immediately", async () => {
  const clock = new VirtualClock(base);
  const backend = new ReferenceBackend();
  const internet = new InternetAdapter("internet", new Gateway("gateway", backend), () => clock.now());
  internet.setOnline(true);
  const node = new SimulatedNode("node", new DeterministicRoutingManager());
  node.addTransport(internet);
  node.create(makeReport({ eventId: "disconnect-event", createdAt: base }));
  await node.flush(base);
  internet.setOnline(false);
  assert.equal(internet.egressAdvertisement().state, "STALE");
  assert.equal(internet.hasEgress(), false);
});
