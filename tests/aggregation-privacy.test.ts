import assert from "node:assert/strict";
import test from "node:test";
import { aggregateReports, type AggregationPolicy } from "../src/backend/aggregation.ts";
import { ReferenceBackend } from "../src/backend/backend.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { NEED_CATEGORIES, type EmergencyReport } from "../src/protocol/types.ts";

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

function reportsWithCounts(total: number, sos: number, water: number): EmergencyReport[] {
  return Array.from({ length: total }, (_, i) => ({ ...makeReport({ createdAt: now - 1_000, eventId: `breakdown-${i}`, eventType: i < sos ? "SOS" : "SAFE" }), needs: i < water ? [{ category: "WATER" as const }] : [] }));
}

test("public breakdowns withhold rare, complementary and difference counts together", () => {
  for (const counts of [[3, 3, 3], [9, 1, 3], [9, 8, 3], [12, 6, 5]]) {
    const [area] = aggregateReports(reportsWithCounts(...counts as [number, number, number]), policy, now).areas;
    assert.equal(area.total, counts[0]); assert.equal(area.critical, null); assert.equal(area.sos, null);
    assert.equal(Object.keys(area.needs).length, NEED_CATEGORIES.length);
    assert.ok(Object.values(area.needs).every(n => n === null), "all related counts are withheld, not just the rare category");
  }
});

test("safe public breakdowns publish a fixed category set including zero", () => {
  const result = aggregateReports(reportsWithCounts(12, 6, 3), policy, now);
  const [area] = result.areas;
  assert.equal(result.privacy.breakdownProtection, true);
  assert.equal(area.critical, 6); assert.equal(area.sos, 6); assert.equal(area.needs.WATER, 3); assert.equal(area.needs.FOOD, 0);
  assert.equal(Object.keys(area.needs).length, NEED_CATEGORIES.length);
});

test("needs count reports rather than repeated categories inside one report", () => {
  const report = makeReport({ createdAt: now - 1_000 });
  report.needs = [{ category: "WATER" }, { category: "WATER" }];
  const [area] = aggregateReports([report], undefined, now).areas;
  assert.equal(area.needs.WATER, 1); assert.equal(area.sos, 1);
});

test("private events and extension categories never appear in the public map projection", () => {
  const reports = reportsWithCounts(12, 6, 3);
  const privateReport = { ...reports[0], eventType: "x-coluvi-operational-notice" as const };
  reports[0].needs!.push({ category: "x-private-need" });
  const [area] = aggregateReports([...reports, privateReport], policy, now).areas;
  assert.equal(area.total, 12); assert.equal("x-private-need" in area.needs, false);
});
