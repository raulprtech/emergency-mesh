import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runScenario, type ScenarioDefinition } from "../src/simulator/scenario-runner.ts";

const path = resolve(process.argv[2] ?? "examples/scenario-fragmented-network.json");
const definition = JSON.parse(readFileSync(path, "utf8")) as ScenarioDefinition;
const result = await runScenario(definition);
console.log(JSON.stringify({
  name: result.name,
  backendEvents: result.backend.size(),
  areas: result.backend.aggregate(),
  trace: result.trace,
}, null, 2));
