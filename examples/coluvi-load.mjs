import { runColuviLoad } from "../src/simulator/coluvi-load.js";
import { writeFileSync } from "node:fs";

if (process.argv.length > 6) throw new Error("Usage: node examples/coluvi-load.mjs [devices=300] [concurrency=24] [seed=20261004] [new-report.json]");
const [devices = "300", concurrency = "24", seed = "20261004", output] = process.argv.slice(2);
const result = await runColuviLoad({ devices: Number(devices), concurrency: Number(concurrency), seed: Number(seed),
  progress: message => process.stderr.write(`[coluvi-load] ${message}\n`) });
const json = JSON.stringify(result, null, 2) + "\n";
if (output) writeFileSync(output, json, { flag: "wx", mode: 0o600 });
process.stdout.write(json);
