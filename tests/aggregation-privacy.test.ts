import assert from "node:assert/strict";
import test from "node:test";
import { aggregateReports, type AggregationPolicy } from "../src/backend/aggregation.ts";
import { ReferenceBackend } from "../src/backend/backend.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";

const now = 1_800_000_000_000;
const policy: AggregationPolicy = {
  spatialPrecisionDecimals: 1,
  timeBucketMs: 60 * 60_000,
  minimumGroupSize: 3,
  maximumAgeMs: 24 * 60 * 60_000,
};

test("public aggregation suppresses small groups without exposing their event count", () => {
  const reports = [
    makeReport({ eventId: "privacy-1", createdAt: now - 1_000 }),
    makeReport({ eventId: "privacy-2", createdAt: now - 2_000 }),
  ];
  const result = aggregateReports(reports, policy, now);
  assert.deepEqual(result.areas, []);
  assert.equal(result.privacy.suppressedGroups, 1);
  assert.equal("suppressedEvents" in result.privacy, false);
});

test("visible groups use coarse grid and explicit time buckets", () => {
  const reports = [1, 2, 3].map((index) => makeReport({ eventId: `visible-${index}`, createdAt: now - index * 1_000 }));
  const result = aggregateReports(reports, policy, now);
  assert.equal(result.areas.length, 1);
  assert.equal(result.areas[0].areaId, "grid:19.4,-99.1");
  assert.equal(result.areas[0].total, 3);
  assert.equal(result.areas[0].timeBucketStart, Math.floor((now - 3_000) / policy.timeBucketMs) * policy.timeBucketMs);
  assert.equal(result.areas[0].timeBucketEnd, result.areas[0].timeBucketStart! + policy.timeBucketMs);
});

test("public window excludes stale observations", () => {
  const stale = makeReport({ eventId: "stale-public", createdAt: now - 2 * 24 * 60 * 60_000 });
  const result = aggregateReports([stale], { ...policy, minimumGroupSize: 1 }, now);
  assert.deepEqual(result.areas, []);
  assert.equal(result.privacy.suppressedGroups, 0, "filtered observations never form a group");
});

test("backend keeps internal evidence while returning a separately governed public projection", () => {
  const backend = new ReferenceBackend();
  const origin = new SimulatedNode("origin", new DeterministicRoutingManager());
  for (const index of [1, 2]) {
    const envelope = origin.create(makeReport({ eventId: `backend-private-${index}`, createdAt: now - index * 1_000 }));
    assert.equal(backend.ingest(envelope, now).status, "ACCEPTED");
  }
  assert.equal(backend.size(), 2);
  assert.equal(backend.aggregate(undefined, now).length, 1, "internal aggregate remains available to authorized code");
  assert.equal(backend.publicAggregate(policy, now).areas.length, 0);
});

test("invalid aggregation policies fail closed", () => {
  assert.throws(() => aggregateReports([], { ...policy, minimumGroupSize: 0 }, now), /Invalid aggregation policy/);
  assert.throws(() => aggregateReports([], { ...policy, spatialPrecisionDecimals: 5 }, now), /Invalid aggregation policy/);
});
