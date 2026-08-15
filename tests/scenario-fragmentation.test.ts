import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runScenario, type ScenarioDefinition } from "../src/simulator/scenario-runner.ts";

test("declarative small-MTU link reassembles before eventual Internet egress", async () => {
  const definition = JSON.parse(readFileSync(new URL("../examples/scenario-small-mtu.json", import.meta.url), "utf8")) as ScenarioDefinition;
  const result = await runScenario(definition);
  assert.equal(result.backend.size(), 1);
  assert.equal(result.backend.get("small-mtu-sos")?.eventType, "SOS");
  assert.equal(result.nodes.get("field-node")?.queue.size(), 0);
  assert.equal(result.nodes.get("gateway-node")?.queue.size(), 0);
  const firstFlush = result.trace.find((entry) => entry.action.type === "FLUSH" && entry.action.nodeId === "field-node");
  assert.deepEqual(firstFlush?.flush?.[0].accepted, ["small-mtu-link"]);
});
