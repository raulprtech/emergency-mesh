import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceBackend } from "../src/backend/backend.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { runVerticalSlice } from "../src/simulator/scenario.ts";
import { InternetAdapter } from "../src/transports/internet.ts";

test("store-and-forward delivers after an intermediate node gains egress", async () => {
  const result = await runVerticalSlice();
  assert.equal(result.nodeA.queue.size(), 0);
  assert.equal(result.nodeB.queue.size(), 0);
  assert.equal(result.backend.size(), 1);
  assert.equal(result.backend.get(result.report.eventId)?.eventType, "SOS");
  assert.equal(result.backend.aggregate()[0].areaId, "grid:19.43,-99.13");
});

test("bounded multipath delivers the same eventId twice but creates one backend event", async () => {
  const backend = new ReferenceBackend();
  const gateway = new Gateway("gateway", backend);
  const node = new SimulatedNode("multipath", new DeterministicRoutingManager());
  const first = new InternetAdapter("internet-primary", gateway);
  const second = new InternetAdapter("internet-secondary", gateway);
  first.setOnline(true);
  second.setOnline(true);
  node.addTransport(first);
  node.addTransport(second);
  const report = makeReport({ eventId: "multipath-event", priority: "CRITICAL" });
  node.create(report);

  const [result] = await node.flush(report.createdAt);
  assert.equal(result.accepted.length, 2);
  assert.equal(backend.size(), 1);
  assert.equal(backend.arrivalCount(report.eventId), 2);
});

test("PERSON_FOUND resolves a LAST_SEEN case without deleting history", () => {
  const backend = new ReferenceBackend();
  const gateway = new Gateway("gateway", backend);
  const node = new SimulatedNode("origin", new DeterministicRoutingManager());
  const seen = node.create(makeReport({ eventId: "last-seen-1", eventType: "PERSON_LAST_SEEN", reportMode: "LAST_SEEN", subjectId: "subject-1" }));
  assert.equal(gateway.sync(seen).status, "ACCEPTED");
  assert.equal(backend.activePersonCases().length, 1);

  const found = node.create(makeReport({ eventId: "found-1", eventType: "PERSON_FOUND", reportMode: "THIRD_PARTY", subjectId: "subject-1", relatedEventId: "last-seen-1" }));
  assert.equal(gateway.sync(found).status, "ACCEPTED");
  assert.equal(backend.size(), 2);
  assert.equal(backend.activePersonCases().length, 0);
  assert.ok(backend.get("last-seen-1"), "historical observation remains available");
});
