import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Includes non-ignored source additions; generated reports and private pilot files are excluded. */
export function sourceProvenance(repository) {
  const git = args => execFileSync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const paths = [...new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "src", "tests", "scripts", "examples", "package.json"]).split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256");
  for (const path of paths) hash.update(path + "\0").update(readFileSync(join(repository, path))).update("\0");
  return { baseCommit: git(["rev-parse", "HEAD"]).trim(), dirtyWorktree: Boolean(git(["status", "--porcelain"]).trim()), sourceSha256: hash.digest("hex"), sourceFiles: paths.length };
}
