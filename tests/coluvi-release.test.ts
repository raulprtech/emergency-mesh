import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRc2Evidence } from "../scripts/rc2-evidence.js";
import { archivedRc2Source } from "../scripts/rc2-source.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(join(repository, path), "utf8"));
function fixture() {
  const qualification = json("docs/coluvi-qualification-20261005-rc2.json");
  const mixed300 = json("docs/coluvi-mixed-300-20261005.json");
  const mixed990 = json("docs/coluvi-mixed-990-20261005.json");
  // Synthetic validator input, NOT evidence that a three-hour execution happened.
  const soak = structuredClone(qualification.soakSmoke);
  Object.assign(soak, { qualifiesThreeHours: true, observedMs: 10_800_000, startedAt: "2026-10-05T00:00:00.000Z", completedAt: "2026-10-05T03:00:00.000Z", acknowledgedPackets: 3240 });
  Object.assign(soak.configuration, { durationMs: 10_800_000, intervalMs: 30_000 });
  Object.assign(soak.counts, { rounds: 40, commands: 120, notices: 120, receiptAcknowledgements: 2160, packetAcknowledgements: 3402, duplicates: 162, heartbeats: 42, restarts: 2 });
  soak.roundMs.samples = 40;
  soak.audits = [20, 40, 40].map((round, index) => ({ label: index === 2 ? "FINAL" : "AFTER_SIGKILL", round, acknowledgedPacketsVerified: round * 81, integrity: "ok", foreignKeyViolations: 0 }));
  for (const [route, status, value] of [["POST /api/packets", 202, 3402], ["POST /api/mobile/receipts", 202, 2160], ["POST /api/operator/checkins", 201, 120],
    ["POST /api/operator/notices", 201, 120], ["GET /api/operator/session", 401, 2], ["GET /health", 200, 42], ["GET /api/areas", 200, 42]] as const) soak.endpoints[route] = { statuses: { [status]: value }, failures: 0 };
  const soakProgress: any[] = [{ type: "STARTED", startedAt: soak.startedAt, recordedAt: soak.startedAt, durationMs: soak.configuration.durationMs, devices: 30 }];
  for (let round = 1; round <= 40; round++) {
    const restarts = Math.floor(round / 20); const observedMs = round * 270_000;
    soakProgress.push({ type: "ROUND", phase: "OBSERVING", recordedAt: new Date(Date.parse(soak.startedAt) + observedMs).toISOString(), observedMs, roundMs: 270_000,
      acknowledgedPackets: round * 81, counts: { ...soak.counts, rounds: round, commands: round * 3, notices: round * 3, receiptAcknowledgements: round * 54,
        restarts, duplicates: restarts * 81, packetAcknowledgements: round * 81 + restarts * 81, heartbeats: round + restarts } });
  }
  const evidence = { qualification, mixed300, mixed990, soak, soakProgress };
  const archives = Object.fromEntries([qualification, mixed300, mixed990, soak].map(report => [report.provenance.baseCommit, { sourceSha256: report.provenance.sourceSha256, workloadSha256: "synthetic-workload" }]));
  return { evidence, context: { current: { sourceSha256: qualification.provenance.sourceSha256, workloadSha256: "synthetic-workload" }, archives } };
}
function rejects(change: (f: ReturnType<typeof fixture>) => void, code: string) {
  const f = fixture(); change(f); assert.throws(() => verifyRc2Evidence(f.evidence, f.context), new RegExp(code));
}
test("RC2 gate accepts internally consistent synthetic validator data without asserting physical qualification", () => {
  const f = fixture(); const result = verifyRc2Evidence(f.evidence, f.context);
  assert.equal(result.status, "PASS"); assert.equal(result.physicalAndroid, "PENDING"); assert.equal(result.originalTimeoutCause, "NOT_ESTABLISHED");
  assert.match(result.limitations[0], /not authenticated/);
});
test("RC2 gate refuses short or clock-inconsistent soak reports even when labeled PASS", () => {
  rejects(f => { f.evidence.soak.observedMs = 60_000; }, "SOAK_TOO_SHORT");
  rejects(f => { f.evidence.soak.qualifiesThreeHours = false; }, "SOAK_TOO_SHORT");
  rejects(f => { f.evidence.soak.completedAt = f.evidence.soak.startedAt; }, "SOAK_CLOCK_INCONSISTENT");
  rejects(f => { f.evidence.soak.configuration.durationMs = 5000; }, "SOAK_PROFILE_MISMATCH");
});
test("RC2 gate requires clean matching source and unchanged exercised workload", () => {
  rejects(f => { f.evidence.mixed990.provenance.dirtyWorktree = true; }, "UNCLEAN_OR_MISSING_PROVENANCE");
  rejects(f => { f.evidence.mixed990.provenance.sourceSha256 = "changed"; }, "SOURCE_HASH_MISMATCH");
  rejects(f => { f.context.current.sourceSha256 = "changed"; }, "CURRENT_SOURCE_NOT_QUALIFIED");
  rejects(f => { f.context.current.workloadSha256 = "changed"; }, "WORKLOAD_CHANGED_SINCE_EVIDENCE");
  rejects(f => { f.evidence.qualification.readiness.provenance.sourceSha256 = "changed"; }, "NESTED_PROVENANCE_MISMATCH");
});
test("RC2 gate rejects incomplete tests, missing stages and contradictory browser evidence", () => {
  rejects(f => { f.evidence.qualification.tests.skipped = 1; }, "TEST_SUITE_NOT_CLEAN");
  rejects(f => { f.evidence.qualification.steps.pop(); }, "QUALIFICATION_STEPS_MISSING");
  rejects(f => { f.evidence.qualification.continuity.browserKilledWithSIGKILL = false; }, "CONTINUITY_EVIDENCE_MISSING");
  rejects(f => { f.evidence.qualification.readiness.cases[0].layout.horizontalOverflow = true; }, "READINESS_LAYOUT_FAILED");
  rejects(f => { f.evidence.qualification.rehearsal.scenarios[0].timeline[0].observed.requested++; }, "REHEARSAL_CHECKPOINT_MISMATCH");
});
test("RC2 gate does not turn failed or partial mixed loads into capacity evidence", () => {
  rejects(f => { f.evidence.mixed990.status = "FAIL"; }, "MIXED_LOAD_FAILED");
  rejects(f => { f.evidence.mixed990.crashes[1].persisted = 1; }, "LOAD_DURABILITY_FAILED");
  rejects(f => { f.evidence.mixed990.measurements.endpoints["POST /api/packets"].errors.TIMEOUT = 1; }, "MIXED_TIMEOUT_RECORDED");
  rejects(f => { delete f.evidence.mixed300.measurements.endpoints["GET /api/areas"]; }, "MIXED_ENDPOINT_NOT_EXERCISED");
});
test("RC2 gate verifies soak audit, receipt, replay and endpoint counts independently", () => {
  rejects(f => { f.evidence.soak.audits.pop(); }, "SOAK_AUDITS_MISSING");
  rejects(f => { f.evidence.soak.audits[0].acknowledgedPacketsVerified--; }, "SOAK_AUDIT_FAILED");
  rejects(f => { f.evidence.soak.counts.receiptAcknowledgements--; }, "SOAK_OPERATION_COUNTS");
  rejects(f => { f.evidence.soak.counts.duplicates--; }, "SOAK_RESTART_COUNTS");
  rejects(f => { f.evidence.soak.endpoints["POST /api/packets"].failures = 1; }, "SOAK_ENDPOINT_FAILURE");
  rejects(f => { f.evidence.soak.endpoints["POST /api/packets"].statuses[202]--; }, "SOAK_ENDPOINT_COUNTS");
});
test("RC2 gate requires the complete original soak chronology", () => {
  rejects(f => { f.evidence.soakProgress = []; }, "SOAK_TIMELINE_INCOMPLETE");
  rejects(f => { f.evidence.soakProgress.splice(3, 1); }, "SOAK_TIMELINE_INCOMPLETE");
  rejects(f => { f.evidence.soakProgress[0].startedAt = "wrong"; }, "SOAK_TIMELINE_START");
  rejects(f => { f.evidence.soakProgress[3].counts.rounds = 2; }, "SOAK_TIMELINE_SEQUENCE");
});
test("RC2 gate checks intermediate timeline counts and rejects final disagreement", () => {
  rejects(f => { f.evidence.soakProgress[10].counts.duplicates++; }, "SOAK_TIMELINE_COUNTS");
  rejects(f => { f.evidence.soakProgress[20].counts.rateLimited = -1; }, "SOAK_TIMELINE_COUNTS");
  rejects(f => { f.evidence.soakProgress[40].counts.heartbeats++; }, "SOAK_TIMELINE_FINAL_COUNTS");
});
test("RC2 gate rejects reversed, oversized or discontinuous timeline intervals", () => {
  rejects(f => { f.evidence.soakProgress[2].observedMs = 1; }, "SOAK_TIMELINE_CLOCK_ORDER");
  rejects(f => { f.evidence.soakProgress[2].roundMs *= 2; }, "SOAK_TIMELINE_CLOCK_ORDER");
  rejects(f => { f.evidence.soakProgress[2].recordedAt = f.evidence.soakProgress[1].recordedAt; }, "SOAK_TIMELINE_CLOCK_ORDER");
  rejects(f => { f.evidence.soakProgress[2].recordedAt = new Date(Date.parse(f.evidence.soakProgress[2].recordedAt) + 10_000).toISOString(); }, "SOAK_TIMELINE_CLOCK_STEP");
});
test("RC2 gate records gradual clock divergence without hiding it or shortening either duration", () => {
  const f = fixture();
  for (const [index, row] of f.evidence.soakProgress.entries()) row.recordedAt = new Date(Date.parse(row.recordedAt) + index * 1500).toISOString();
  f.evidence.soak.completedAt = "2026-10-05T03:01:00.000Z";
  const result = verifyRc2Evidence(f.evidence, f.context);
  assert.equal(result.status, "PASS"); assert.equal(result.clocks.status, "DIVERGENT_BOTH_EXCEED_MINIMUM");
  assert.equal(result.clocks.conservativeMs, 10_800_000); assert.equal(result.clocks.wallMinusMonotonicMs, 60_000);
  assert.equal(result.clocks.verifiedRounds, 40); assert.equal(result.clocks.maxClockDifferencePerIntervalMs, 1500);
  assert.match(result.limitations.at(-1)!, /cause is not established/);
});
test("RC2 gate still rejects an insufficient duration on either clock", () => {
  rejects(f => { f.evidence.soak.completedAt = "2026-10-05T02:59:59.999Z"; }, "SOAK_CLOCK_INCONSISTENT");
  rejects(f => { f.evidence.soak.observedMs = 10_799_999; }, "SOAK_TOO_SHORT");
});
test("RC2 gate rejects a stale or contradictory final timestamp after the last round", () => {
  rejects(f => { f.evidence.soak.completedAt = "2026-10-05T03:02:00.000Z"; }, "SOAK_TIMELINE_FINAL_CLOCK");
  rejects(f => { f.evidence.soak.observedMs += 65_000; }, "SOAK_TIMELINE_FINAL_CLOCK");
});
test("archived workload hashing excludes only browser presentation files and detects protocol changes", () => {
  const root = mkdtempSync("/tmp/coluvi-release-source-");
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git(["init", "-q"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    mkdirSync(join(root, "src/mobile-client"), { recursive: true });
    writeFileSync(join(root, "src/mobile-client/styles.css"), "body { color: black; }");
    writeFileSync(join(root, "src/mobile-client/commands.js"), "export const value = 1;");
    const commit = () => { git(["add", "."]); git(["commit", "-qm", "fixture"]); return git(["rev-parse", "HEAD"]); };
    const before = archivedRc2Source(root, commit());
    writeFileSync(join(root, "src/mobile-client/styles.css"), "body { color: blue; }");
    const presentation = archivedRc2Source(root, commit());
    assert.notEqual(before.sourceSha256, presentation.sourceSha256); assert.equal(before.workloadSha256, presentation.workloadSha256);
    writeFileSync(join(root, "src/mobile-client/commands.js"), "export const value = 2;");
    assert.notEqual(presentation.workloadSha256, archivedRc2Source(root, commit()).workloadSha256);
    assert.throws(() => archivedRc2Source(root, "HEAD"), /INVALID_EVIDENCE_COMMIT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("release CLI refuses UbuntuPreview before reading reports", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-coluvi-rc2.mjs", "missing", "missing", "missing", "missing", "missing"], { cwd: repository, encoding: "utf8", env: { ...process.env, WSL_DISTRO_NAME: "UbuntuPreview" } });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).reason, "USE_UBUNTU_WSL");
});
