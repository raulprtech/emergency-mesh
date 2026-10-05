import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length !== 3 || process.argv[2].startsWith("-")) throw new Error("Usage: COLUVI_CHROMIUM_PATH=/installed/chromium node scripts/qualify-coluvi.mjs NEW_OUTPUT_DIRECTORY");
if (process.platform !== "linux" || process.env.WSL_DISTRO_NAME !== "Ubuntu") throw new Error("Qualification must run in Ubuntu WSL, never UbuntuPreview");
const chromium = process.env.COLUVI_CHROMIUM_PATH;
if (!chromium) throw new Error("Provide an installed Chromium using COLUVI_CHROMIUM_PATH; this command installs nothing");
accessSync(chromium, constants.X_OK);
const destination = resolve(process.argv[2]);
const git = args => execFileSync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const sourcePaths = () => [...new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "src", "tests", "scripts", "examples", "package.json"]).split("\0").filter(Boolean))].sort();
function sourceHash() {
  const hash = createHash("sha256");
  for (const path of sourcePaths()) hash.update(path + "\0").update(readFileSync(join(repository, path))).update("\0");
  return hash.digest("hex");
}
const provenance = { baseCommit: git(["rev-parse", "HEAD"]).trim(), dirtyWorktree: Boolean(git(["status", "--porcelain"]).trim()), sourceSha256: sourceHash(), sourceFiles: sourcePaths().length };
// Exclusive creation: never replace an earlier qualification or pilot directory.
mkdirSync(destination, { mode: 0o700 });
const startedAt = new Date().toISOString(); const started = performance.now();
const steps = []; let activeChild; let interrupted = false;
function signalGroup(signal) {
  if (!activeChild?.pid) return;
  try { process.kill(-activeChild.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
const interrupt = () => { interrupted = true; signalGroup("SIGTERM"); };
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
const save = (name, data) => writeFileSync(join(destination, name), data, { flag: "wx", mode: 0o600 });
async function run(name, args, timeoutMs) {
  if (interrupted) throw new Error("Qualification interrupted");
  process.stderr.write(`[qualification] ${name}\n`);
  const before = performance.now(); let stdout = ""; let stderr = ""; let exceeded = false; let timedOut = false;
  const child = spawn(process.execPath, args, { cwd: repository, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  activeChild = child;
  const capture = stream => chunk => {
    if (stream === "stdout") stdout += chunk; else stderr += chunk;
    if (stdout.length + stderr.length > 8 * 1024 * 1024) { exceeded = true; signalGroup("SIGKILL"); }
  };
  child.stdout.on("data", capture("stdout")); child.stderr.on("data", capture("stderr"));
  const timeout = setTimeout(() => { timedOut = true; signalGroup("SIGKILL"); }, timeoutMs);
  const cancellation = setInterval(() => { if (interrupted) signalGroup("SIGKILL"); }, 1_000);
  try {
    const outcome = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal })); });
    save(`${name}.stdout`, stdout); save(`${name}.stderr`, stderr);
    const result = { name, ...outcome, wallMs: performance.now() - before, timedOut, exceededOutputLimit: exceeded };
    steps.push(result);
    if (outcome.code !== 0 || interrupted || timedOut || exceeded) throw new Error(`${name} failed; inspect the private output directory`);
    return stdout;
  } finally { clearTimeout(timeout); clearInterval(cancellation); signalGroup("SIGKILL"); activeChild = undefined; }
}
try {
  const tests = readdirSync(join(repository, "tests")).filter(name => name.endsWith(".test.ts")).sort().map(name => `tests/${name}`);
  const tap = await run("tests", ["--test", "--test-concurrency=2", "--test-reporter=tap", ...tests], 5 * 60_000);
  const count = field => Number([...tap.matchAll(new RegExp(`^# ${field} (\\d+)$`, "gm"))].at(-1)?.[1]);
  const testSummary = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped", "todo"].map(field => [field, count(field)]));
  assert.ok(testSummary.tests > 0); assert.equal(testSummary.pass, testSummary.tests);
  for (const field of ["fail", "cancelled", "skipped", "todo"]) assert.equal(testSummary[field], 0);
  await run("rehearsal", ["scripts/rehearse-coluvi.mjs", join(destination, "rehearsal")], 60_000);
  const rehearsal = JSON.parse(readFileSync(join(destination, "rehearsal", "rehearsal.json"), "utf8"));
  assert.equal(rehearsal.status, "PASS"); assert.equal(rehearsal.sourceUnchanged, true); assert.equal(rehearsal.scenarios.length, 6);
  for (const scenario of rehearsal.scenarios) assert.ok(scenario.timeline.every(step => step.status === "PASS"));
  const integrated = JSON.parse(await run("integrated-browser", ["examples/coluvi-browser-smoke.mjs"], 5 * 60_000));
  assert.equal(integrated.integratedMapEvidence.sameBackendAndOrigin, true);
  assert.equal(integrated.integratedMapEvidence.offlineSnapshotDuringPrivateResponse, true);
  assert.equal(integrated.reconnectedState, "SYNCED"); assert.equal(integrated.publicPrivacy, true); assert.deepEqual(integrated.diagnostics, []);
  assert.equal(integrated.deviceDiagnosticEvidence.offline.pending, 2);
  assert.equal(integrated.deviceDiagnosticEvidence.offline.privateValuesExcluded, true);
  assert.equal(integrated.deviceDiagnosticEvidence.reconnected.pending, 0);
  assert.equal(integrated.deviceDiagnosticEvidence.reconnected.server, "REACHABLE");
  assert.equal(integrated.deviceDiagnosticEvidence.reconnected.privateValuesExcluded, true);
  const continuity = JSON.parse(await run("client-continuity", ["examples/mobile-continuity-smoke.mjs"], 3 * 60_000));
  assert.equal(continuity.status, "PASS"); assert.equal(continuity.browserKilledWithSIGKILL, true);
  assert.equal(continuity.actualRC1AssetsUsed, true); assert.equal(continuity.pendingPacketUnchangedAfterUpgrade, true);
  assert.equal(continuity.failedLocalAckRetriedAsDuplicate, true); assert.deepEqual(continuity.diagnostics, []);
  await run("mobile-readiness", ["examples/mobile-readiness-smoke.mjs", join(destination, "mobile-readiness")], 3 * 60_000);
  const readiness = JSON.parse(readFileSync(join(destination, "mobile-readiness", "readiness.json"), "utf8"));
  assert.equal(readiness.status, "PASS"); assert.equal(readiness.sourceUnchanged, true); assert.equal(readiness.cases.length, 12);
  assert.ok(readiness.cases.every(item => item.status === "PASS"));
  const map = JSON.parse(await run("map-browser", ["examples/public-map-browser-smoke.mjs"], 3 * 60_000));
  assert.equal(map.status, "PASS"); assert.equal(map.offlineAfterAbruptStop, true); assert.equal(map.expiredSnapshotRejected, true);
  await run("soak-smoke", ["scripts/soak-coluvi.mjs", join(destination, "soak-smoke"), "5", "5"], 3 * 60_000);
  const soakSmoke = JSON.parse(readFileSync(join(destination, "soak-smoke", "soak.json"), "utf8"));
  assert.equal(soakSmoke.status, "PASS"); assert.equal(soakSmoke.sourceUnchanged, true);
  assert.equal(soakSmoke.qualifiesThreeHours, false); assert.ok(soakSmoke.counts.rounds > 0);
  const load = JSON.parse(await run("load-300", ["examples/coluvi-load.mjs", "300", "24", "20261004"], 21 * 60_000));
  assert.equal(load.counts.uniqueSignedPackets, 810); assert.equal(load.crashes[1].acknowledgedVerified, 810);
  assert.equal(sourceHash(), provenance.sourceSha256, "Source changed during qualification; results cannot qualify the current tree");
  const report = { version: 1, status: "PASS", startedAt, completedAt: new Date().toISOString(), wallMs: performance.now() - started,
    provenance, environment: { node: process.version, distro: process.env.WSL_DISTRO_NAME }, steps, tests: testSummary,
    integrated, map, load, rehearsal, continuity, readiness, soakSmoke, limitations: ["Software qualification in Ubuntu WSL and loopback Chromium, not physical Android/LAN/radio validation", "Short soak is not the separate three-hour real-time acceptance run", "Not a production certification or guarantee of emergency assistance"] };
  save("qualification.json", JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ status: report.status, report: join(destination, "qualification.json"), tests: testSummary.tests, devices: load.configuration.devices }, null, 2) + "\n");
} catch (error) {
  save("qualification-failed.json", JSON.stringify({ version: 1, status: "FAIL", startedAt, completedAt: new Date().toISOString(), provenance, steps, message: error.message }, null, 2) + "\n");
  throw error;
} finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
