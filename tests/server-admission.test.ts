import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { serializeEnvelope } from "../src/protocol/codec.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("HTTP ingest rate limits never produce false custody evidence", { timeout: 15_000 }, async () => {
  const port = await availablePort();
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: repository,
    env: {
      ...process.env,
      PORT: String(port),
      EMERGENCY_MESH_INGEST_WINDOW_SECONDS: "60",
      EMERGENCY_MESH_INGEST_GLOBAL_REQUESTS: "3",
      EMERGENCY_MESH_INGEST_IDENTITY_REQUESTS: "1",
      EMERGENCY_MESH_INGEST_MAX_IDENTITIES: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { if (chunk.includes("Emergency Map:")) resolve(); });
      child.once("exit", (code) => reject(new Error(`server exited before ready (${code}): ${diagnostics}`)));
    });
    const endpoint = `http://127.0.0.1:${port}/api/packets`;
    const node = new SimulatedNode("admission-client", new DeterministicRoutingManager());
    const body = serializeEnvelope(node.create(makeReport({ eventId: "server-admission-event" })));

    const acceptedResponse = await fetch(endpoint, { method: "POST", body });
    const accepted = await acceptedResponse.json();
    assert.equal(acceptedResponse.status, 202);
    assert.equal(accepted.status, "ACCEPTED");
    assert.equal(accepted.evidence?.level, "BACKEND");

    const identityResponse = await fetch(endpoint, { method: "POST", body });
    const identityLimited = await identityResponse.json();
    assert.equal(identityResponse.status, 429);
    assert.equal(identityLimited.status, "RATE_LIMITED");
    assert.equal(identityLimited.scope, "IDENTITY");
    assert.equal(identityLimited.evidence, undefined);
    assert.ok(Number(identityResponse.headers.get("retry-after")) >= 1);

    const invalidResponse = await fetch(endpoint, { method: "POST", body: Uint8Array.of(0xff) });
    assert.equal(invalidResponse.status, 400);

    const globalResponse = await fetch(endpoint, { method: "POST", body: Uint8Array.of(0xff) });
    const globalLimited = await globalResponse.json();
    assert.equal(globalResponse.status, 429);
    assert.equal(globalLimited.scope, "GLOBAL");
    assert.equal(globalLimited.evidence, undefined);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
});
