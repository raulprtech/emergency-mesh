import { runColuviLoad } from "../src/simulator/coluvi-load.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceProvenance } from "../src/operations/source-provenance.js";

const [destinationArg, devices = "300", concurrency = "24", seed = "20261005", ...extra] = process.argv.slice(2);
if (!destinationArg || destinationArg.startsWith("-") || extra.length) throw new Error("Usage: node examples/coluvi-mixed-load.mjs NEW_OUTPUT_DIRECTORY [devices] [concurrency] [seed]");
if (process.env.WSL_DISTRO_NAME !== "Ubuntu") throw new Error("Use Ubuntu WSL");
const destination = resolve(destinationArg); mkdirSync(destination, { mode: 0o700 });
const repository = fileURLToPath(new URL("../", import.meta.url)); const provenance = sourceProvenance(repository);
const startedAt = new Date().toISOString();
try {
  const result = await runColuviLoad({ devices: Number(devices), concurrency: Number(concurrency), seed: Number(seed), mixed: true,
    progress: message => process.stderr.write(`[mixed-load] ${message}\n`) });
  if (sourceProvenance(repository).sourceSha256 !== provenance.sourceSha256) throw new Error("Source changed during mixed load");
  writeFileSync(join(destination, "mixed-load.json"), JSON.stringify({ ...result, status: "PASS", provenance, startedAt, sourceUnchanged: true }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: "PASS", report: join(destination, "mixed-load.json") }));
} catch (error) {
  writeFileSync(join(destination, "mixed-load-failed.json"), JSON.stringify({ version: 1, status: "FAIL", provenance, startedAt, completedAt: new Date().toISOString(),
    evidence: error.loadEvidence ?? null, message: "Mixed workload did not pass; this is not a successful capacity qualification" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.error(error.message); process.exitCode = 1;
}
