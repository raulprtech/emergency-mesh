import assert from "node:assert/strict";
import test from "node:test";
import { runSoak } from "../src/simulator/coluvi-soak.js";

test("short real-time soak verifies repeated HTTP cycles, notices, snapshots and restart without claiming three hours", { timeout: 60_000 }, async context => {
  const samples: any[] = [];
  const result = await runSoak({ durationMs: 4000, intervalMs: 1000, devices: 3, restartEvery: 2, signal: context.signal, progress: value => samples.push(value) });
  assert.equal(result.status, "PASS"); assert.equal(result.qualifiesThreeHours, false); assert.ok(result.observedMs >= 4000);
  assert.ok(result.counts.rounds >= 2); assert.ok(result.counts.restarts >= 1);
  assert.equal(result.acknowledgedPackets, result.counts.rounds * 6); assert.equal(result.counts.receiptAcknowledgements, result.counts.rounds * 4);
  assert.equal(result.audits.at(-1)?.acknowledgedPacketsVerified, result.acknowledgedPackets); assert.ok(result.counts.duplicates >= 6);
  assert.ok(samples.some(value => value.type === "ROUND"));
  for (const key of ["deviceId", "eventId", "privateKey", "publicKey", "token", "signature"]) assert.equal(JSON.stringify(result).includes(`"${key}"`), false);
});

test("soak rejects excessive or invalid work and cancellation never produces a successful report", async () => {
  for (const options of [{ durationMs: 0 }, { intervalMs: 1 }, { devices: 1 }, { restartEvery: 0 }, { seed: -1 }, { durationMs: 10_000_000, intervalMs: 250 }]) await assert.rejects(runSoak(options));
  const controller = new AbortController(); controller.abort(); await assert.rejects(runSoak({ signal: controller.signal }), { name: "AbortError" });
});
