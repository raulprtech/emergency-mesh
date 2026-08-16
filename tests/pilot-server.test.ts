import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { serializeEnvelope } from "../src/protocol/codec.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";

const repository = fileURLToPath(new URL("../", import.meta.url));

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

async function startPilot(port: number, databasePath: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: repository,
    env: {
      ...process.env,
      PORT: String(port),
      EMERGENCY_MESH_HOST: "0.0.0.0",
      EMERGENCY_MESH_DATABASE_PATH: databasePath,
      EMERGENCY_MESH_ENABLE_DEBUG_EVENTS: "1",
      EMERGENCY_MESH_PUBLIC_MIN_GROUP_SIZE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (chunk.includes("storage=sqlite")) resolve(); });
    child.once("exit", (code) => reject(new Error(`pilot server exited before ready (${code}): ${diagnostics}`)));
  });
  return child;
}

async function stopPilot(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("pilot server persists accepted reports across a clean restart", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "emergency-mesh-pilot-"));
  const databasePath = join(directory, "nested", "pilot.sqlite");
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}`;
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = await startPilot(port, databasePath);
    const health = await (await fetch(`${endpoint}/health`)).json();
    assert.equal(health.storage, "sqlite");

    const node = new SimulatedNode("pilot-phone", new DeterministicRoutingManager());
    const envelope = node.create(makeReport({ eventId: "pilot-restart-event" }));
    const acceptedResponse = await fetch(`${endpoint}/api/packets`, {
      method: "POST",
      body: serializeEnvelope(envelope),
    });
    const accepted = await acceptedResponse.json();
    assert.equal(acceptedResponse.status, 202);
    assert.equal(accepted.status, "ACCEPTED");
    assert.equal(accepted.evidence?.level, "BACKEND");
    await stopPilot(child);
    child = undefined;

    child = await startPilot(port, databasePath);
    const reports = await (await fetch(`${endpoint}/api/events`)).json();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].eventId, envelope.report.eventId);
    const aggregate = await (await fetch(`${endpoint}/api/areas`)).json();
    assert.equal(aggregate.privacy.minimumGroupSize, 1);
    assert.equal(aggregate.areas.reduce((total: number, area: { total: number }) => total + area.total, 0), 1);
  } finally {
    if (child) await stopPilot(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
