import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { get as httpsGet } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createDeviceIdentity } from "../src/protocol/identity.ts";
import { createColuviConfiguration } from "../src/commands/config.ts";
import { ColuviStore } from "../src/commands/store.ts";
import { SqliteBackend } from "../src/backend/sqlite-backend.ts";
import { createBrowserIdentity } from "../src/mobile-client/crypto.js";
import { createCheckinCommand } from "../src/commands/authority.ts";
import { createCheckinResponse } from "../src/mobile-client/commands.js";
import { backupPilot, diagnosePilot, restorePilot, preparePilotStart } from "../src/operations/pilot.js";
import { preflightPilot } from "../src/operations/preflight.js";

async function fixture(origin = "http://127.0.0.1:9876") {
  const root = mkdtempSync("/tmp/coluvi-operations-"); const pilot = join(root, "pilot"); mkdirSync(pilot, { mode: 0o700 });
  const identity = createDeviceIdentity(); const material = await createColuviConfiguration(identity, origin, ["north"]);
  writeFileSync(join(pilot, "operator-config.json"), JSON.stringify(material.configuration), { mode: 0o600 });
  writeFileSync(join(pilot, "mobile-trust.json"), JSON.stringify(material.mobileTrust), { mode: 0o600 });
  writeFileSync(join(pilot, "operator-secrets.txt"), `test-only: ${material.operatorPassword}`, { mode: 0o600 });
  return { root, pilot, material, identity };
}
async function freePort() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
async function stop(child: ReturnType<typeof spawn> | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5_000); await exited; clearTimeout(timer);
}
function cli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/coluvi-pilot.mjs", ...args], { stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("exit", code => resolve({ code, stdout, stderr }));
  });
}

test("online SQLite backup captures committed WAL, restores privately and preserves originals without overwrites", async () => {
  const { root, pilot, material, identity } = await fixture(); const path = join(pilot, "pilot.sqlite");
  const backend = new SqliteBackend(path); const store = new ColuviStore(path, material.mobileTrust.authorities);
  try {
    const browser = await createBrowserIdentity(); const now = Date.now(); store.enroll(browser.publicKey, "north", now);
    const credential = store.grantCredential(browser.anonymousDeviceId, now);
    const command = createCheckinCommand(identity, material.configuration.authority, { commandId: "backup-request", zoneId: "north", incidentRef: "drill", nonce: "backup-nonce", issuedAt: now, promptUntil: now + 60_000, responseUntil: now + 120_000 });
    store.issue(command, now); const response = await createCheckinResponse(command, "SAFE", browser, now + 1); store.acceptResponse(response.envelope, now + 2);
    assert.ok(lstatSync(path + "-wal").size > 0);
    const configBefore = readFileSync(join(pilot, "operator-config.json")); const expected = store.projection(command.eventId, now + 3);
    const result = await backupPilot(pilot, join(root, "snapshot")); assert.equal(result.containsPrivateMaterial, true);
    assert.equal(lstatSync(result.backupDirectory).mode & 0o777, 0o700);
    for (const name of ["operator-config.json", "mobile-trust.json", "operator-secrets.txt", "pilot.sqlite", "backup-manifest.json"]) assert.equal(lstatSync(join(result.backupDirectory, name)).mode & 0o777, 0o600);
    store.revokeParticipant(browser.anonymousDeviceId, now + 4);
    const restored = await restorePilot(result.backupDirectory, join(root, "restored")); assert.equal(restored.requiresRollbackReview, true);
    assert.deepEqual(readFileSync(join(pilot, "operator-config.json")), configBefore);
    const restoredStore = new ColuviStore(join(restored.restoredDirectory, "pilot.sqlite"), material.mobileTrust.authorities);
    try {
      assert.deepEqual(restoredStore.projection(command.eventId, now + 3), expected);
      assert.equal(restoredStore.authenticateCredential(`Bearer ${credential.token}`, now + 5)?.active, 1);
      assert.equal(store.authenticateCredential(`Bearer ${credential.token}`, now + 5), undefined);
    } finally { restoredStore.close(); }
    await assert.rejects(preparePilotStart(restored.restoredDirectory), /review/);
    await assert.rejects(preparePilotStart(result.backupDirectory), /backup directory/);
    await assert.rejects(backupPilot(pilot, result.backupDirectory));
    await assert.rejects(restorePilot(result.backupDirectory, pilot));
    assert.deepEqual(readFileSync(join(pilot, "operator-config.json")), configBefore);
    const diagnosis = diagnosePilot(restored.restoredDirectory); assert.equal(diagnosis.database.status, "CHECKED"); assert.equal(diagnosis.database.counts.responses, 1); assert.equal(diagnosis.network, "NOT_PROBED");
    for (const value of [credential.token, material.operatorPassword, material.enrollmentCode, material.configuration.privateKeyPem, browser.anonymousDeviceId]) assert.equal(JSON.stringify(diagnosis).includes(value), false);
  } finally { store.close(); backend.close(); rmSync(root, { recursive: true, force: true }); }
});

test("backup checksums, path allowlist, ownership and symlink gates fail before restoring existing data", async () => {
  const { root, pilot, material } = await fixture(); const path = join(pilot, "pilot.sqlite");
  const backend = new SqliteBackend(path); backend.close(); const store = new ColuviStore(path, material.mobileTrust.authorities); store.close();
  try {
    const snapshot = join(root, "snapshot"); await backupPilot(pilot, snapshot);
    const manifestPath = join(snapshot, "backup-manifest.json"); const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const altered = structuredClone(manifest); altered.files[0].name = "../operator-config.json"; writeFileSync(manifestPath, JSON.stringify(altered));
    await assert.rejects(restorePilot(snapshot, join(root, "traversal")), /manifest|entry/); assert.equal(existsSync(join(root, "traversal")), false);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(join(snapshot, "operator-secrets.txt"), "changed", { mode: 0o600 });
    await assert.rejects(restorePilot(snapshot, join(root, "corrupt")), /checksum/); assert.equal(existsSync(join(root, "corrupt")), false);
    symlinkSync(pilot, join(root, "link")); await assert.rejects(backupPilot(join(root, "link"), join(root, "unsafe")), /symbolic/);
    await assert.rejects(backupPilot(pilot, join(pilot, "nested")), /outside/);
    await assert.rejects(backupPilot(pilot, join(pilot, "..still-inside")), /outside/);
    await assert.rejects(backupPilot(pilot, join(root, "link", "via-link")), /outside/);
    const bad = await cli(["diagnose", join(root, "missing")]); assert.equal(bad.code, 1); assert.equal(bad.stderr.includes(material.operatorPassword), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("foreground pilot launcher starts, diagnoses, stops its child and refuses an occupied port or malformed options", { timeout: 20_000 }, async () => {
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`; const { root, pilot, material } = await fixture(origin); let child;
  try {
    assert.equal(diagnosePilot(pilot).database.status, "NOT_CREATED");
    child = spawn(process.execPath, ["scripts/coluvi-pilot.mjs", "start", pilot], { stdio: ["ignore", "pipe", "pipe"] }); let output = ""; let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Pilot launch timeout")), 8_000);
      child!.stdout.on("data", chunk => { output += chunk; if (output.includes("Emergency Map:")) { clearTimeout(timer); resolve(); } });
      child!.once("exit", () => { clearTimeout(timer); reject(new Error("Pilot exited before ready")); }); child!.once("error", reject);
    });
    assert.equal((await fetch(origin + "/health")).status, 200);
    const preflight = await preflightPilot(pilot, { probe: true });
    assert.equal(preflight.checks.find(check => check.id === "server")?.status, "PASS");
    assert.equal(preflight.checks.find(check => check.id === "phoneOrigin")?.status, "FAIL");
    assert.equal(preflight.physicalConnectivityVerified, false);
    await assert.rejects(preparePilotStart(pilot), /unavailable/);
    assert.equal((await fetch(origin + "/health")).status, 200);
    const diagnosed = await cli(["diagnose", pilot]); assert.equal(diagnosed.code, 0); assert.equal(JSON.parse(diagnosed.stdout).database.status, "CHECKED");
    for (const value of [material.operatorPassword, material.enrollmentCode, material.configuration.privateKeyPem]) assert.equal((output + errors + diagnosed.stdout + diagnosed.stderr).includes(value), false);
    assert.equal((await cli(["start", pilot, "--host", "0.0.0.0"])).code, 1);
    assert.equal((await cli(["start", pilot, "--unknown"])).code, 1);
    await stop(child); child = undefined;
    await assert.rejects(fetch(origin + "/health"));
    const db = new DatabaseSync(join(pilot, "pilot.sqlite"), { readOnly: true }); assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok"); db.close();
    assert.equal(lstatSync(join(pilot, "pilot.sqlite")).mode & 0o777, 0o600);
    const snapshot = join(root, "snapshot"); const restored = join(root, "restored");
    assert.equal((await cli(["backup", pilot, snapshot])).code, 0);
    assert.equal((await cli(["restore", snapshot, restored])).code, 0);
    assert.equal((await cli(["start", restored])).code, 1);
    const prepared = await preparePilotStart(restored, { acknowledgeRollback: true }); assert.equal(prepared.origin, origin);
    child = spawn(process.execPath, ["scripts/coluvi-pilot.mjs", "start", restored, "--acknowledge-rollback"], { stdio: ["ignore", "pipe", "pipe"] }); child.stderr.resume();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Restored pilot launch timeout")), 8_000); let ready = "";
      child!.stdout.on("data", chunk => { ready += chunk; if (ready.includes("Emergency Map:")) { clearTimeout(timer); resolve(); } }); child!.once("error", reject);
      child!.once("exit", () => { clearTimeout(timer); reject(new Error("Restored pilot exited before ready")); });
    });
    assert.equal((await fetch(origin + "/health")).status, 200);
    await stop(child); child = undefined;
    rmSync(join(restored, "restore-complete.json"));
    await assert.rejects(preparePilotStart(restored, { acknowledgeRollback: true }), /incomplete/);
  } finally { await stop(child); rmSync(root, { recursive: true, force: true }); }
});

test("HTTPS launcher verifies matching certificate/key/origin and serves only with the test CA trusted explicitly", { timeout: 20_000 }, async () => {
  const port = await freePort(); const origin = `https://127.0.0.1:${port}`; const { root, pilot } = await fixture(origin); let child;
  try {
    const tls = join(root, "tls"); const generated = spawnSync(process.execPath, ["scripts/generate-pilot-cert.mjs", "127.0.0.1", tls], { encoding: "utf8" }); assert.equal(generated.status, 0);
    const options = { tlsCert: join(tls, "server-cert.pem"), tlsKey: join(tls, "server-key.pem") };
    await assert.rejects(preparePilotStart(pilot));
    await assert.rejects(preparePilotStart(pilot, { ...options, tlsKey: join(tls, "ca-key.pem") }), /TLS/);
    const wrongTls = join(root, "wrong-host-tls");
    assert.equal(spawnSync(process.execPath, ["scripts/generate-pilot-cert.mjs", "localhost", wrongTls], { encoding: "utf8" }).status, 0);
    await assert.rejects(preparePilotStart(pilot, { tlsCert: join(wrongTls, "server-cert.pem"), tlsKey: join(wrongTls, "server-key.pem") }), /TLS/);
    const realNow = Date.now;
    try { Date.now = () => realNow() + 8 * 24 * 60 * 60_000; await assert.rejects(preparePilotStart(pilot, options), /TLS/); } finally { Date.now = realNow; }
    await preparePilotStart(pilot, options);
    child = spawn(process.execPath, ["scripts/coluvi-pilot.mjs", "start", pilot, "--tls-cert", options.tlsCert, "--tls-key", options.tlsKey], { stdio: ["ignore", "pipe", "pipe"] }); child.stderr.resume();
    await new Promise<void>((resolve, reject) => {
      let output = ""; const timer = setTimeout(() => reject(new Error("TLS launcher timeout")), 8_000);
      child!.stdout.on("data", chunk => { output += chunk; if (output.includes("Emergency Map:")) { clearTimeout(timer); resolve(); } }); child!.once("error", reject);
      child!.once("exit", () => { clearTimeout(timer); reject(new Error("TLS launcher exited before ready")); });
    });
    const status = await new Promise<number | undefined>((resolve, reject) => { const request = httpsGet(origin + "/health", { ca: readFileSync(join(tls, "ca-cert.pem")) }, response => { response.resume(); resolve(response.statusCode); }); request.once("error", reject); });
    assert.equal(status, 200);
    const checked = await preflightPilot(pilot, { ...options, caCert: join(tls, "ca-cert.pem"), probe: true });
    assert.equal(checked.status, "PENDING_PHYSICAL_TESTS");
    for (const id of ["runtime", "configuration", "certificate", "privateKey", "server", "servedCertificate"]) assert.equal(checked.checks.find(check => check.id === id)?.status, "PASS", id);
    assert.equal(checked.checks.find(check => check.id === "android")?.status, "PENDING");
    const untrusted = await preflightPilot(pilot, { ...options, probe: true });
    assert.equal(untrusted.checks.find(check => check.id === "server")?.code, "SERVER_TLS_REJECTED");
    const mismatch = await preflightPilot(pilot, { ...options, tlsKey: join(tls, "ca-key.pem") });
    assert.equal(mismatch.checks.find(check => check.id === "privateKey")?.status, "FAIL");
    const expiredNow = Date.now;
    try {
      Date.now = () => expiredNow() + 8 * 24 * 60 * 60_000;
      const expired = await preflightPilot(pilot, options);
      assert.equal(expired.checks.find(check => check.id === "certificate")?.status, "FAIL");
    } finally { Date.now = expiredNow; }
    for (const file of [options.tlsKey, join(tls, "ca-key.pem")]) assert.equal(JSON.stringify(checked).includes(readFileSync(file, "utf8")), false);
    await assert.rejects(fetch(origin + "/health")); // No global TLS bypass or CA installation.
  } finally { await stop(child); rmSync(root, { recursive: true, force: true }); }
});

test("preflight is opt-in, bounded, rejects redirects and never includes server errors or secrets", { timeout: 15_000 }, async () => {
  let mode = "ok"; let requests = 0;
  const server = createHttpServer((request, response) => {
    requests++;
    if (mode === "stall") return;
    if (mode === "redirect") { response.writeHead(302, { location: "http://127.0.0.1:1/private" }); response.end("secret-server-error"); return; }
    if (mode === "large") { response.end("secret-server-error".repeat(1000)); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(mode === "invalid" ? { secret: "secret-server-error" } : { status: "ok", protocolVersion: "0.1", storage: "sqlite", https: false }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { root, pilot, material } = await fixture(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const original = readFileSync(join(pilot, "operator-config.json"));
  try {
    const offline = await preflightPilot(pilot);
    assert.equal(requests, 0); assert.equal(offline.checks.find(check => check.id === "server")?.status, "PENDING");
    for (const [scenario, code] of [["ok", "SERVER_HEALTHY_FROM_UBUNTU"], ["redirect", "HEALTH_HTTP_STATUS"], ["large", "HEALTH_RESPONSE_TOO_LARGE"], ["invalid", "HEALTH_CONTRACT_MISMATCH"], ["stall", "SERVER_TIMEOUT"]]) {
      mode = scenario;
      const result = await preflightPilot(pilot, { probe: true, timeoutMs: 250 });
      assert.equal(result.checks.find(check => check.id === "server")?.code, code);
      for (const secret of ["secret-server-error", material.operatorPassword, material.enrollmentCode, material.configuration.privateKeyPem]) assert.equal(JSON.stringify(result).includes(secret), false);
    }
    assert.equal(requests, 5, "redirect was not followed");
    assert.deepEqual(readFileSync(join(pilot, "operator-config.json")), original);
    assert.equal(existsSync(join(pilot, "pilot.sqlite")), false);
    await assert.rejects(preflightPilot(pilot, { probe: true, timeoutMs: 60_000 }));
    const bad = await cli(["preflight", pilot, "--probe", "--probe"]); assert.equal(bad.code, 1);
    const missing = await preflightPilot(join(root, "missing"), { probe: true });
    assert.equal(missing.checks.find(check => check.id === "server")?.code, "NETWORK_NOT_PROBED_INVALID_CONFIGURATION");
    assert.equal(requests, 5);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
