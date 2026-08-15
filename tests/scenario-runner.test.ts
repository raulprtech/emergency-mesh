import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runScenario, validateScenario, type ScenarioDefinition } from "../src/simulator/scenario-runner.ts";

test("declarative fragmented-network scenario reaches backend after delayed egress", async () => {
  const definition = JSON.parse(readFileSync(new URL("../examples/scenario-fragmented-network.json", import.meta.url), "utf8")) as ScenarioDefinition;
  const result = await runScenario(definition);
  assert.equal(result.backend.size(), 1);
  assert.equal(result.backend.get("scenario-sos-1")?.eventType, "SOS");
  assert.equal(result.nodes.get("node-a")?.queue.size(), 0);
  assert.equal(result.nodes.get("node-b")?.queue.size(), 0);
  assert.equal(result.trace.at(-1)?.backendEvents, 1);
});

test("scenario validation rejects unknown topology references", () => {
  const invalid: ScenarioDefinition = {
    version: 1,
    name: "invalid",
    startAt: 0,
    seed: 1,
    nodes: [{ id: "a" }],
    links: [{ id: "broken", from: "a", to: "missing" }],
    actions: [{ at: 0, type: "FLUSH", nodeId: "missing" }],
  };
  assert.match(validateScenario(invalid).join(" "), /unknown node/);
});
