import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceProvenance } from "../src/operations/source-provenance.js";
import { runSoak } from "../src/simulator/coluvi-soak.js";

const [destinationArg, seconds = "10800", intervalSeconds = "30", ...extra] = process.argv.slice(2);
if (!destinationArg || destinationArg.startsWith("-") || extra.length || !/^\d+$/.test(seconds) || !/^\d+$/.test(intervalSeconds)) throw new Error("Usage: node scripts/soak-coluvi.mjs NEW_OUTPUT_DIRECTORY [seconds=10800] [intervalSeconds=30]");
if (process.platform !== "linux" || process.env.WSL_DISTRO_NAME !== "Ubuntu") throw new Error("Use Ubuntu WSL");
const repository = fileURLToPath(new URL("../", import.meta.url)); const provenance = sourceProvenance(repository);
const destination = resolve(destinationArg); mkdirSync(destination, { mode: 0o700 });
const save = (name, body) => writeFileSync(join(destination, name), JSON.stringify(body, null, 2) + "\n", { flag: "wx", mode: 0o600 });
writeFileSync(join(destination, "progress.jsonl"), "", { flag: "wx", mode: 0o600 });
const controller = new AbortController(); const interrupt = () => controller.abort(); process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
const startedAt = new Date().toISOString();
try {
  const result = await runSoak({ durationMs: Number(seconds) * 1000, intervalMs: Number(intervalSeconds) * 1000, signal: controller.signal, progress: sample => {
    appendFileSync(join(destination, "progress.jsonl"), JSON.stringify({ recordedAt: new Date().toISOString(), ...sample }) + "\n");
    process.stderr.write(sample.type === "STARTED" ? `[soak] started ${sample.durationMs / 1000}s\n` : `[soak] round=${sample.counts.rounds} elapsed=${Math.round(sample.observedMs / 1000)}s ACKs=${sample.acknowledgedPackets} restarts=${sample.counts.restarts}\n`);
  } });
  if (sourceProvenance(repository).sourceSha256 !== provenance.sourceSha256) throw new Error("Source changed during soak");
  save("soak.json", { ...result, provenance, sourceUnchanged: true });
  console.log(JSON.stringify({ status: "PASS", qualifiesThreeHours: result.qualifiesThreeHours, report: join(destination, "soak.json") }));
} catch (error) {
  save("soak-failed.json", { version: 1, status: "FAIL", reason: controller.signal.aborted ? "INTERRUPTED" : "WORKLOAD_FAILED", startedAt,
    completedAt: new Date().toISOString(), provenance, evidence: error.soakEvidence ?? null });
  console.error(error.message); process.exitCode = 1;
} finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
