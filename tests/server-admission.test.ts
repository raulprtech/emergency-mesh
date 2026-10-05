import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { serializeEnvelope } from "../src/protocol/codec.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { createDeviceIdentityFromSeed } from "../src/protocol/identity.ts";
import { authorityFor, createCheckinCommand } from "../src/commands/authority.ts";

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
      EMERGENCY_MESH_HOST: "127.0.0.1",
      EMERGENCY_MESH_DATABASE_PATH: "",
      EMERGENCY_MESH_COLUVI_CONFIG_PATH: "",
      EMERGENCY_MESH_TLS_CERT_PATH: "",
      EMERGENCY_MESH_TLS_KEY_PATH: "",
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

test("unconfigured HTTP operational ingest fails closed without false backend acknowledgement", { timeout: 15_000 }, async () => {
  const port = await availablePort();
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, PORT: String(port), EMERGENCY_MESH_HOST: "127.0.0.1", EMERGENCY_MESH_DATABASE_PATH: ":memory:", EMERGENCY_MESH_COLUVI_CONFIG_PATH: "", EMERGENCY_MESH_TLS_CERT_PATH: "", EMERGENCY_MESH_TLS_KEY_PATH: "", EMERGENCY_MESH_ENABLE_DEBUG_EVENTS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server startup timed out: ${diagnostics}`)), 5_000);
      child.stdout.on("data", (chunk) => { if (chunk.toString().includes("Emergency Map:")) { clearTimeout(timer); resolve(); } });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${diagnostics}`)); });
    });
    const issuer = createDeviceIdentityFromSeed(new Uint8Array(32).fill(3));
    const now = Date.now();
    const report = createCheckinCommand(issuer, authorityFor(issuer, ["north"]), {
      commandId: "unconfigured-command", incidentRef: "flood-drill", zoneId: "north", nonce: "unconfigured-nonce", issuedAt: now, promptUntil: now + 60_000, responseUntil: now + 120_000,
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/packets`, { method: "POST", body: serializeEnvelope({ packetId: "packet", report, expiresAt: report.validUntil, hopCount: 0, hopLimit: 12 }) });
    const outcome = await response.json();
    assert.equal(response.status, 400); assert.equal(outcome.status, "INVALID"); assert.equal(outcome.evidence, undefined);
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/areas`)).json()).areas, []);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/events`)).status, 404);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM"); await stopped;
    }
  }
});
