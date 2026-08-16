import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { request } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { serializeEnvelope } from "../src/protocol/codec.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";

const repository = fileURLToPath(new URL("../", import.meta.url));
const opensslAvailable = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

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

function httpsJson(port: number, ca: Buffer, path: string, method = "GET", body?: Uint8Array): Promise<{
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: unknown;
}> {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : undefined;
    const call = request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      ca,
      rejectUnauthorized: true,
      headers: payload ? { "content-type": "application/cbor", "content-length": payload.length } : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) { reject(error); }
      });
    });
    call.once("error", reject);
    if (payload) call.write(payload);
    call.end();
  });
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("TLS certificate and key configuration must be paired", () => {
  const environment = { ...process.env, EMERGENCY_MESH_TLS_CERT_PATH: "missing-cert.pem" };
  delete environment.EMERGENCY_MESH_TLS_KEY_PATH;
  const result = spawnSync(process.execPath, ["src/server.ts"], { cwd: repository, env: environment, encoding: "utf8", timeout: 5_000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TLS_CERT_PATH and EMERGENCY_MESH_TLS_KEY_PATH must be configured together/);
});

test("trusted pilot HTTPS accepts a signed report and exposes secure headers", { timeout: 20_000, skip: !opensslAvailable }, async () => {
  const directory = mkdtempSync(join("/tmp", "emergency-mesh-https-"));
  const tlsDirectory = join(directory, "tls");
  const databasePath = join(directory, "pilot.sqlite");
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const generated = spawnSync(process.execPath, ["scripts/generate-pilot-cert.mjs", "127.0.0.1", tlsDirectory], {
      cwd: repository,
      encoding: "utf8",
    });
    assert.equal(generated.status, 0, generated.stderr);
    const caPath = join(tlsDirectory, "ca-cert.pem");
    const certificatePath = join(tlsDirectory, "server-cert.pem");
    const keyPath = join(tlsDirectory, "server-key.pem");
    assert.equal(statSync(join(tlsDirectory, "ca-key.pem")).mode & 0o777, 0o600);
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    const certificate = spawnSync("openssl", ["x509", "-in", certificatePath, "-noout", "-text"], { encoding: "utf8" });
    assert.equal(certificate.status, 0, certificate.stderr);
    assert.match(certificate.stdout, /IP Address:127\.0\.0\.1/);
    const refused = spawnSync(process.execPath, ["scripts/generate-pilot-cert.mjs", "127.0.0.1", tlsDirectory], {
      cwd: repository,
      encoding: "utf8",
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Refusing to overwrite existing TLS material/);

    const port = await availablePort();
    child = spawn(process.execPath, ["src/server.ts"], {
      cwd: repository,
      env: {
        ...process.env,
        PORT: String(port),
        EMERGENCY_MESH_HOST: "127.0.0.1",
        EMERGENCY_MESH_DATABASE_PATH: databasePath,
        EMERGENCY_MESH_TLS_CERT_PATH: certificatePath,
        EMERGENCY_MESH_TLS_KEY_PATH: keyPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let diagnostics = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { diagnostics += chunk; });
    await new Promise<void>((resolve, reject) => {
      child!.stdout.setEncoding("utf8");
      child!.stdout.on("data", (chunk) => { if (chunk.includes("https://127.0.0.1")) resolve(); });
      child!.once("exit", (code) => reject(new Error(`HTTPS pilot exited before ready (${code}): ${diagnostics}`)));
    });

    const ca = readFileSync(caPath);
    const health = await httpsJson(port, ca, "/health");
    assert.equal(health.status, 200);
    assert.equal((health.body as { https?: boolean }).https, true);
    assert.equal((health.body as { storage?: string }).storage, "sqlite");
    assert.equal(health.headers["strict-transport-security"], "max-age=86400");
    assert.equal(health.headers["x-content-type-options"], "nosniff");

    const node = new SimulatedNode("https-phone", new DeterministicRoutingManager());
    const envelope = node.create(makeReport({ eventId: "https-pilot-event" }));
    const accepted = await httpsJson(port, ca, "/api/packets", "POST", serializeEnvelope(envelope));
    assert.equal(accepted.status, 202);
    assert.equal((accepted.body as { status?: string }).status, "ACCEPTED");
    assert.equal((accepted.body as { evidence?: { level?: string } }).evidence?.level, "BACKEND");
  } finally {
    if (child) await stop(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
