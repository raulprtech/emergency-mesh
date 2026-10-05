import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runRehearsal } from "../src/simulator/rehearsal.js";

const [destinationArg, seedArg = "20261004", ...extra] = process.argv.slice(2);
if (!destinationArg || destinationArg.startsWith("-") || extra.length || !/^\d{1,10}$/.test(seedArg) || Number(seedArg) > 0xffffffff) throw new Error("Usage: node scripts/rehearse-coluvi.mjs NEW_OUTPUT_DIRECTORY [UINT32_SEED]");
if (process.platform !== "linux" || process.env.WSL_DISTRO_NAME !== "Ubuntu") throw new Error("Run rehearsals in Ubuntu WSL, never UbuntuPreview");
const repository = fileURLToPath(new URL("../", import.meta.url)); const destination = resolve(destinationArg);
const git = args => execFileSync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
function fingerprint() {
  const paths = [...new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "src", "tests", "scripts", "examples", "package.json"]).split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256"); for (const path of paths) hash.update(path + "\0").update(readFileSync(join(repository, path))).update("\0");
  return hash.digest("hex");
}
const provenance = { baseCommit: git(["rev-parse", "HEAD"]).trim(), dirtyWorktree: Boolean(git(["status", "--porcelain"]).trim()), sourceSha256: fingerprint() };
mkdirSync(destination, { mode: 0o700 });
const save = (name, value) => writeFileSync(join(destination, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
writeFileSync(join(destination, "progress.jsonl"), "", { flag: "wx", mode: 0o600 });
const controller = new AbortController(); const interrupt = () => controller.abort();
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
const startedAt = new Date().toISOString(); const began = performance.now();
try {
  const result = await runRehearsal({ seed: Number(seedArg), signal: controller.signal, progress: row => {
    appendFileSync(join(destination, "progress.jsonl"), JSON.stringify({ recordedAt: new Date().toISOString(), ...row }) + "\n");
    process.stderr.write(`[rehearsal] ${row.scenario} ${row.phase}\n`);
  } });
  const unchanged = fingerprint() === provenance.sourceSha256;
  const report = { ...result, status: unchanged ? result.status : "FAIL", sourceUnchanged: unchanged, startedAt,
    completedAt: new Date().toISOString(), wallMs: performance.now() - began, provenance, environment: { node: process.version, distribution: process.env.WSL_DISTRO_NAME } };
  save("rehearsal.json", report); process.exitCode = report.status === "PASS" ? 0 : 1;
  process.stdout.write(JSON.stringify({ status: report.status, report: join(destination, "rehearsal.json"), scenarios: result.scenarios.length }) + "\n");
} catch {
  save("rehearsal-failed.json", { version: 1, status: "FAIL", reason: controller.signal.aborted ? "INTERRUPTED" : "SCENARIO_EXECUTION_FAILED", startedAt,
    completedAt: new Date().toISOString(), provenance, wallMs: performance.now() - began });
  process.stderr.write("Rehearsal did not complete. Inspect the new output directory; no existing output was replaced.\n"); process.exitCode = 1;
} finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
