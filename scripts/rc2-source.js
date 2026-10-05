import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const roots = ["src", "tests", "scripts", "examples", "package.json"];
// These browser-only presentation files are not executed by the HTTP soak actor.
const browserOnly = new Set(["src/mobile-client/app.js", "src/mobile-client/styles.css", "src/mobile-client/sw.js"]);
const launchers = new Set(["examples/instrumented-server.mjs", "examples/coluvi-mixed-load.mjs", "examples/coluvi-load.mjs", "scripts/soak-coluvi.mjs"]);
export function archivedRc2Source(repository, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("INVALID_EVIDENCE_COMMIT");
  const git = args => execFileSync("git", args, { cwd: repository, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const resolved = git(["rev-parse", `${commit}^{commit}`]).toString().trim();
  if (resolved !== commit) throw new Error("EVIDENCE_COMMIT_NOT_AVAILABLE");
  const paths = git(["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots]).toString().split("\0").filter(Boolean).sort();
  if (!paths.length) throw new Error("EMPTY_EVIDENCE_SOURCE");
  const source = createHash("sha256"); const workload = createHash("sha256");
  for (const path of paths) {
    const bytes = git(["show", `${commit}:${path}`]);
    source.update(path + "\0").update(bytes).update("\0");
    if ((path.startsWith("src/") && !browserOnly.has(path)) || launchers.has(path)) workload.update(path + "\0").update(bytes).update("\0");
  }
  return { sourceSha256: source.digest("hex"), workloadSha256: workload.digest("hex"), sourceFiles: paths.length };
}
