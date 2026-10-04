import assert from "node:assert/strict";
import test from "node:test";
import { runColuviLoad } from "../src/simulator/coluvi-load.js";

test("HTTP load recovers confirmed signed packets after two hard kills and verifies full replay", { timeout: 120_000 }, async () => {
  const result = await runColuviLoad({ devices: 30, concurrency: 8 });
  assert.equal(result.counts.uniqueSignedPackets, 81);
  assert.equal(result.counts.safe, 12); assert.equal(result.counts.needsHelp, 15); assert.equal(result.counts.pending, 3);
  assert.equal(result.crashes.length, 2); assert.equal(result.crashes[1].acknowledgedVerified, 81);
  assert.equal(result.crashes[1].persisted, 81); assert.equal(result.http.fullReplayDuplicates, 81);
  assert.ok(result.http.requestsOutstandingAtKill > 0);
  assert.equal(result.checks.allRecipientPagesVerified, true);
});

test("load fixture rejects unbounded or unbalanced profiles before creating resources", async () => {
  for (const options of [{ devices: 0 }, { devices: 31 }, { devices: 1_020 }, { concurrency: 1 }, { concurrency: 65 }, { seed: -1 }]) {
    await assert.rejects(runColuviLoad(options));
  }
});
