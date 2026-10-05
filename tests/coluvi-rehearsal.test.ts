import assert from "node:assert/strict";
import test from "node:test";
import { runRehearsal, REHEARSAL_SCENARIOS } from "../src/simulator/rehearsal.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

test("rehearsal composes outages, late responses, state evolution, expiry, silent recipients and reordered history", { timeout: 60_000 }, async context => {
  const progress: unknown[] = [];
  const result = await runRehearsal({ signal: context.signal, progress: row => progress.push(row) });
  assert.equal(result.status, "PASS", JSON.stringify(result.scenarios.filter(row => row.status !== "PASS")));
  assert.deepEqual(result.scenarios.map(row => row.scenario), REHEARSAL_SCENARIOS);
  assert.equal(progress.length, REHEARSAL_SCENARIOS.length * 2);
  for (const scenario of result.scenarios) {
    assert.ok(scenario.restarts >= 1);
    assert.equal(scenario.acceptedPackets, scenario.duplicateChecks);
    assert.deepEqual(scenario.noticeCounts, { requested: 3, received: 2, shown: 2 });
    assert.ok(scenario.timeline.every(row => row.status === "PASS"));
  }
  const intermittent = result.scenarios.find(row => row.scenario === "INTERMITTENT")!;
  assert.equal(intermittent.restarts, 3); assert.equal(intermittent.final.safe, 2); assert.equal(intermittent.final.unknown, 1);
  const replay = await runRehearsal({ scenarios: ["INTERMITTENT"], signal: context.signal });
  assert.deepEqual(replay.scenarios[0], intermittent);
  for (const forbidden of ["privateKey", "publicKey", "deviceId", "signature", "token", "eventId"]) assert.equal(JSON.stringify(result).includes(`"${forbidden}"`), false);
});

test("rehearsal rejects unknown scope and honors cancellation before creating fixtures", async () => {
  for (const options of [{ seed: -1 }, { scenarios: [] }, { scenarios: ["REAL_ANDROID"] }, { scenarios: ["INTERMITTENT", "INTERMITTENT"] }]) await assert.rejects(runRehearsal(options));
  const controller = new AbortController(); controller.abort(); await assert.rejects(runRehearsal({ signal: controller.signal }), { name: "AbortError" });
});

test("rehearsal cancellation stops at a scenario boundary and leaves no false complete result", async () => {
  const controller = new AbortController(); const progress: string[] = [];
  await assert.rejects(runRehearsal({ signal: controller.signal, progress: row => {
    progress.push(row.phase); if (row.phase === "COMPLETED") controller.abort();
  } }), { name: "AbortError" });
  assert.deepEqual(progress, ["STARTED", "COMPLETED"]);
});

test("rehearsal command refuses existing output, malformed seeds and UbuntuPreview before creating output", () => {
  const root = mkdtempSync("/tmp/coluvi-rehearsal-cli-");
  try {
    const sentinel = join(root, "sentinel"); writeFileSync(sentinel, "keep");
    const run = (args: string[], distribution = "Ubuntu") => spawnSync(process.execPath, ["scripts/rehearse-coluvi.mjs", ...args], { encoding: "utf8", timeout: 5000, env: { ...process.env, WSL_DISTRO_NAME: distribution } });
    assert.notEqual(run([root]).status, 0); assert.equal(readFileSync(sentinel, "utf8"), "keep");
    const fresh = join(root, "new");
    assert.notEqual(run([fresh, "-1"]).status, 0); assert.equal(existsSync(fresh), false);
    assert.notEqual(run([fresh], "UbuntuPreview").status, 0); assert.equal(existsSync(fresh), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
