import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { aggregateReports, PUBLIC_AGGREGATION_POLICY } from "../src/backend/aggregation.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { publicSnapshot, publicZones, areaBounds, filteredAreas, mergeAreas, viewBox, geometryPath, MAX_SNAPSHOT_AGE } from "../src/web/public-map/model.js";
import { mapAsset } from "../src/web/public-map/assets.ts";
import { NEED_CATEGORIES } from "../src/protocol/types.ts";
import { NEED_NAMES } from "../src/web/public-map/model.js";

const now = 1_800_000_000_000;
const snapshot = () => aggregateReports(Array.from({ length: 6 }, () => makeReport({ createdAt: now - 1_000 })), PUBLIC_AGGREGATION_POLICY, now);

test("public map persistence whitelists aggregate fields and rejects malformed or expired data", () => {
  const original = snapshot();
  const result = publicSnapshot({ ...original, participants: ["private"], areas: [{ ...original.areas[0], anonymousDeviceId: "private" }] }, now);
  assert.equal("participants" in result, false); assert.equal("anonymousDeviceId" in result.areas[0], false);
  assert.throws(() => publicSnapshot(original, now + MAX_SNAPSHOT_AGE), /caducada/);
  assert.throws(() => publicSnapshot(original, now - 360_000), /caducada/);
  assert.throws(() => publicSnapshot({ ...original, areas: [{ ...original.areas[0], total: -1 }] }, now), /inválido/);
  assert.throws(() => publicSnapshot({ ...original, areas: [{ ...original.areas[0], needs: { WATER: 7 } }] }, now), /inválido/);
  assert.throws(() => publicSnapshot({ ...original, areas: [{ ...original.areas[0], timeBucketEnd: 1 }] }, now), /Intervalo/);
  assert.equal(publicSnapshot({ ...original, privacy: { ...original.privacy, maximumAgeMs: 500 } }, now).areas.length, 0);
});

test("map filters do not treat unpublished breakdowns as zero or infer hidden needs", () => {
  const original = snapshot(); const second = { ...original.areas[0], areaId: "zone:refugio-norte", needs: { WATER: null }, sos: null, critical: null };
  const value = publicSnapshot({ ...original, areas: [original.areas[0], second] }, now);
  assert.equal(filteredAreas(value).length, 2);
  assert.equal(filteredAreas(value, { need: "MEDICAL_CARE" }).length, 1);
  assert.equal(filteredAreas(value, { need: "WATER" }).length, 0);
  assert.equal(filteredAreas(value, { zone: second.areaId }).length, 1);
  assert.equal(filteredAreas(value, { bucket: "0" }).length, 0);
  const merged = mergeAreas([original.areas[0], { ...second, areaId: original.areas[0].areaId }]);
  assert.equal(merged[0].total, 12); assert.equal(merged[0].sos, null); assert.equal(merged[0].needs.WATER, null);
});

test("coarse cells have actual geographic bounds and logical areas are never invented", () => {
  const zones = publicZones(JSON.parse(mapAsset("/map/zones.json")!.body.toString()));
  const box = areaBounds("grid:21.0,-89.6", 1, zones);
  assert.deepEqual(box, [-89.64999999999999, 20.95, -89.55, 21.05]);
  assert.deepEqual(areaBounds("zone:refugio-norte", 1, zones), zones[0].bounds);
  assert.equal(areaBounds("zone:undocumented", 1, zones), undefined);
  assert.equal(areaBounds("unknown", 1, zones), undefined);
  assert.equal(areaBounds("grid:91,181", 1, zones), undefined);
  assert.ok(viewBox(box).every(Number.isFinite));
  assert.throws(() => publicZones({ version: 1, zones: [...zones, zones[0]] }), /inválida/);
});

test("bundled basemap is fixed local geography and asset routing is an exact allowlist", () => {
  const data = JSON.parse(mapAsset("/map/basemap.json")!.body.toString());
  assert.equal(data.features.length, 177);
  assert.equal(data.revision, "f1890d9f152c896d250a77557a5751a93d494776");
  assert.equal(data.sourceSha256, "6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f");
  assert.ok(data.features.every(feature => /^M/.test(geometryPath(feature.geometry)) && !/NaN|Infinity/.test(geometryPath(feature.geometry))));
  for (const path of ["/map/../server.ts", "/map/.env", "/map/app.js?secret=1", "/api/areas", "/command-center/"]) assert.equal(mapAsset(path), undefined);
  const bytes = readFileSync(new URL("../src/web/public-map/basemap.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "c4e5ae35abcc73458dd094e6191bc6f782df9bee2b5baf02e8864fe75223a645");
  assert.deepEqual(Object.keys(NEED_NAMES).sort(), [...NEED_CATEGORIES].sort());
});
