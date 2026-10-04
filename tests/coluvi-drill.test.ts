import assert from "node:assert/strict";
import test from "node:test";
import { runColuviDrill, DRILL_MODES } from "../src/simulator/coluvi-drill.ts";

test("thirty bidirectional fictional flood cycles use real queues/contracts and replay deterministically", { timeout: 120_000 }, async () => {
  const first = await runColuviDrill(); const second = await runColuviDrill();
  assert.deepEqual(second, first);
  assert.equal(first.cycles.length, 30); assert.equal(first.totals.requested, 120);
  assert.equal(first.configuration.externalInternetUsed, false); assert.equal(first.evidence, "VIRTUAL_SIMULATION_ONLY");
  for (const mode of DRILL_MODES) assert.equal(first.cycles.filter(row => row.mode === mode).length, 6);
  assert.equal(first.cycles.reduce((sum, row) => sum + row.restarts, 0), 30);
  assert.equal(first.totals.responded + first.totals.unknown, 120); assert.equal(first.totals.pending, 0);
  assert.ok(first.totals.safe > 0); assert.ok(first.totals.needsHelp > 0); assert.ok(first.totals.late > 0);
  assert.ok(first.latency.imposedCenterOutageMs.maximum! > 0);
  const json = JSON.stringify(first);
  for (const field of ["publicKey", "privateKey", "deviceId", "token", "signature", "eventId"]) assert.equal(json.includes(`"${field}"`), false);
});
test("fictional drill rejects unbounded or malformed run parameters", async () => {
  for (const cycles of [0, 1, 6, 101, Infinity]) await assert.rejects(runColuviDrill(cycles));
  for (const seed of [-1, NaN, 2 ** 32]) await assert.rejects(runColuviDrill(5, seed));
});
