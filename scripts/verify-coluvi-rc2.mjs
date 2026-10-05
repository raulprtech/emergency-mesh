import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sourceProvenance } from "../src/operations/source-provenance.js";
import { archivedRc2Source } from "./rc2-source.js";
import { verifyRc2Evidence } from "./rc2-evidence.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
try {
  if (process.platform !== "linux" || process.env.WSL_DISTRO_NAME !== "Ubuntu") throw new Error("USE_UBUNTU_WSL");
  const paths = process.argv.slice(2);
  if (paths.length !== 5 || paths.some(path => path.startsWith("-"))) throw new Error("Usage: node scripts/verify-coluvi-rc2.mjs QUALIFICATION_JSON MIXED_300_JSON MIXED_990_JSON THREE_HOUR_SOAK_JSON SOAK_PROGRESS_JSONL");
  if (execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim()) throw new Error("RELEASE_REQUIRES_CLEAN_WORKTREE");
  const hashes = [];
  const values = paths.map((path, index) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("INVALID_REPORT_FILE");
    const bytes = readFileSync(path); hashes.push(createHash("sha256").update(bytes).digest("hex"));
    return index === 4 ? bytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line)) : JSON.parse(bytes);
  });
  const names = ["qualification", "mixed300", "mixed990", "soak", "soakProgress"];
  const evidence = Object.fromEntries(names.map((name, index) => [name, values[index]]));
  const current = sourceProvenance(repository);
  const archives = {};
  for (const commit of new Set([current.baseCommit, ...values.slice(0, 4).map(value => value?.provenance?.baseCommit)])) archives[commit] = archivedRc2Source(repository, commit);
  const head = archives[current.baseCommit];
  if (head.sourceSha256 !== current.sourceSha256) throw new Error("HEAD_SOURCE_MISMATCH");
  const result = verifyRc2Evidence(evidence, { current: head, archives });
  const after = sourceProvenance(repository);
  if (after.baseCommit !== current.baseCommit || after.dirtyWorktree || after.sourceSha256 !== current.sourceSha256) throw new Error("SOURCE_CHANGED_DURING_RELEASE_CHECK");
  console.log(JSON.stringify({ version: 1, ...result, checkedAt: new Date().toISOString(), headCommit: current.baseCommit,
    evidence: Object.fromEntries(names.map((name, index) => [name, { sha256: hashes[index], ...(index < 4 ? { baseCommit: values[index].provenance.baseCommit } : {}) }])) }, null, 2));
} catch (error) {
  // Only fixed validator codes are surfaced; never print file contents or raw child-process output.
  const message = typeof error?.message === "string" && (/^[A-Z_]+$/.test(error.message) || error.message.startsWith("Usage:")) ? error.message : "EVIDENCE_VERIFICATION_FAILED";
  console.error(JSON.stringify({ status: "FAIL", reason: message })); process.exitCode = 1;
}
