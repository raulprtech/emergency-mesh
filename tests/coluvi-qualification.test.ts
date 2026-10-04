import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../", import.meta.url));
const invoke = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, ["scripts/qualify-coluvi.mjs", ...args], {
  cwd: repository, encoding: "utf8", timeout: 10_000, env: { ...process.env, WSL_DISTRO_NAME: "Ubuntu", COLUVI_CHROMIUM_PATH: process.execPath, ...env },
});
test("qualification refuses to overwrite an existing directory or its contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "coluvi-qualification-test-"));
  try {
    const sentinel = join(directory, "sentinel"); writeFileSync(sentinel, "preserve");
    const result = invoke([directory], {}); assert.equal(result.status, 1); assert.match(result.stderr, /EEXIST/);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve"); assert.equal(existsSync(join(directory, "tests.stdout")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("qualification rejects UbuntuPreview and missing Chromium before creating output", () => {
  const directory = mkdtempSync(join(tmpdir(), "coluvi-qualification-test-")); const output = join(directory, "new");
  try {
    const wrongDistro = invoke([output], { WSL_DISTRO_NAME: "UbuntuPreview" }); assert.equal(wrongDistro.status, 1); assert.match(wrongDistro.stderr, /Ubuntu WSL/);
    const missing = invoke([output], { COLUVI_CHROMIUM_PATH: "" }); assert.equal(missing.status, 1); assert.match(missing.stderr, /installed Chromium/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
