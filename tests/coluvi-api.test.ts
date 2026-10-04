import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDeviceIdentity } from "../src/protocol/identity.ts";
import { createColuviConfiguration, loadColuviConfiguration, validatePilotOrigin } from "../src/commands/config.ts";
import { enrollmentProofBytes } from "../src/commands/auth.ts";
import { canonicalCbor, createBrowserIdentity } from "../src/mobile-client/crypto.js";
import { createCheckinResponse, createCheckinReceipt, verifyCommandForDevice } from "../src/mobile-client/commands.js";
import { createOutboxItem } from "../src/mobile-client/core.js";
import { DatabaseSync } from "node:sqlite";

const repository = fileURLToPath(new URL("../", import.meta.url));
async function availablePort() {
  const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => probe.close(() => resolve())); return address.port;
}
async function start(port: number, configPath: string, databasePath: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: repository, env: {
    ...process.env, PORT: String(port), EMERGENCY_MESH_HOST: "127.0.0.1", EMERGENCY_MESH_DATABASE_PATH: databasePath,
    EMERGENCY_MESH_COLUVI_CONFIG_PATH: configPath, EMERGENCY_MESH_TLS_CERT_PATH: "", EMERGENCY_MESH_TLS_KEY_PATH: "", EMERGENCY_MESH_ENABLE_DEBUG_EVENTS: "0",
  }, stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = ""; child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timed out: ${diagnostics}`)), 5_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Exited (${code}): ${diagnostics}`)); });
      child.stdout.on("data", (chunk) => { if (chunk.toString().includes("Emergency Map:")) { clearTimeout(timer); resolve(); } });
    });
  } catch (error) { await stop(child); throw error; }
  return child;
}
async function stop(child?: ChildProcessWithoutNullStreams) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited; clearTimeout(timer);
}
function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers, timeout: 5_000 }, (response) => { response.resume(); resolve(response.statusCode!); });
    request.once("error", reject); request.once("timeout", () => request.destroy(new Error("Request timed out"))); request.end();
  });
}

test("configured HTTP cycle authenticates operator and participant, preserves private state across restart", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync("/tmp/coluvi-api-"); const port = await availablePort(); const endpoint = `http://127.0.0.1:${port}`;
  const material = await createColuviConfiguration(createDeviceIdentity(), endpoint, ["north", "south"]);
  const configPath = join(directory, "config.json"); const databasePath = join(directory, "pilot.sqlite");
  writeFileSync(configPath, JSON.stringify(material.configuration), { mode: 0o600 });
  let child: ChildProcessWithoutNullStreams | undefined;
  const post = async (path: string, data: unknown, extra: Record<string, string> = {}) => fetch(endpoint + path, {
    method: "POST", headers: { "content-type": "application/json", origin: endpoint, ...extra }, body: JSON.stringify(data), signal: AbortSignal.timeout(5_000),
  });
  try {
    child = await start(port, configPath, databasePath);
    const panel = await fetch(endpoint + "/command-center/");
    assert.equal(panel.status, 200); assert.equal(panel.headers.get("cache-control"), "no-store");
    assert.match(panel.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.match(await panel.text(), /id="workspace" hidden/);
    for (const path of ["/command-center/app.js", "/command-center/view.js", "/command-center/styles.css"]) {
      const asset = await fetch(endpoint + path); assert.equal(asset.status, 200); assert.equal(asset.headers.get("cache-control"), "no-store");
    }
    assert.equal((await fetch(endpoint + "/command-center/config.json")).status, 404);
    assert.equal((await fetch(endpoint + "/api/operator/checkins")).status, 401);
    assert.equal((await post("/api/operator/login", { password: material.operatorPassword }, { origin: "https://evil.test" })).status, 403);
    assert.equal((await post("/api/operator/login", { password: "wrong-password-long-enough" })).status, 401);
    const logged = await post("/api/operator/login", { password: material.operatorPassword }); assert.equal(logged.status, 200);
    const setCookie = logged.headers.get("set-cookie")!; assert.match(setCookie, /Secure/); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";")[0]; const login = await logged.json();
    const sessionResponse = await fetch(endpoint + "/api/operator/session", { headers: { cookie } });
    assert.equal(sessionResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual((await sessionResponse.json()).zones, ["north", "south"]);
    const opHeaders = { cookie, "x-coluvi-csrf": login.csrf };
    const requestBody = { incidentRef: "flood-drill", zoneId: "north", promptMs: 60_000, lateMs: 60_000 };
    assert.equal((await post("/api/operator/checkins", requestBody, { cookie })).status, 403);
    assert.equal((await post("/api/operator/checkins", requestBody, { ...opHeaders, "x-coluvi-csrf": "wrong" })).status, 403);
    // fetch normalizes Host; use an actual raw HTTP request to test DNS-rebinding rejection.
    assert.equal(await rawStatus(endpoint + "/api/operator/session", { cookie, host: "rebound.test" }), 403);
    assert.equal((await fetch(endpoint + "/api/operator/session", { headers: { cookie, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(endpoint + "/api/operator/checkins", { method: "PUT", headers: { cookie, origin: endpoint } })).status, 405);
    assert.equal((await post("/api/operator/checkins", { ...requestBody, unexpected: true }, opHeaders)).status, 400);
    assert.equal((await fetch(endpoint + "/api/operator/checkins", { method: "POST", headers: { ...opHeaders, origin: endpoint, "content-type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await fetch(endpoint + "/api/operator/checkins", { method: "POST", headers: { ...opHeaders, origin: endpoint, "content-type": "application/json" }, body: "{" })).status, 400);
    assert.equal((await fetch(endpoint + "/api/operator/checkins", { method: "POST", headers: { ...opHeaders, origin: endpoint, "content-type": "application/json" }, body: JSON.stringify({ oversized: "x".repeat(16_384) }) })).status, 413);
    assert.equal((await post("/api/operator/checkins", { ...requestBody, zoneId: "elsewhere" }, opHeaders)).status, 403);
    assert.equal((await post("/api/operator/checkins", { ...requestBody, promptMs: 25 * 60 * 60_000 }, opHeaders)).status, 400);
    const browserIdentity = await createBrowserIdentity();
    assert.equal((await post("/api/mobile/enrollment/challenge", { code: "wrong", publicKey: browserIdentity.publicKey, zoneId: "north" })).status, 403);
    const challengeResponse = await post("/api/mobile/enrollment/challenge", { code: material.enrollmentCode, publicKey: browserIdentity.publicKey, zoneId: "north" });
    assert.equal(challengeResponse.status, 200); const challenge = await challengeResponse.json();
    const key = await crypto.subtle.importKey("jwk", browserIdentity.privateKeyJwk, { name: "Ed25519" }, false, ["sign"]);
    const proof = Buffer.from(await crypto.subtle.sign("Ed25519", key, enrollmentProofBytes(challenge))).toString("base64url");
    const enrolled = await post("/api/mobile/enrollment", { challengeId: challenge.challengeId, signature: proof }); assert.equal(enrolled.status, 201);
    const participant = await enrolled.json(); assert.equal(participant.deviceId, browserIdentity.anonymousDeviceId);
    assert.equal((await post("/api/mobile/enrollment", { challengeId: challenge.challengeId, signature: proof })).status, 400);
    const mobileHeaders = { authorization: `Bearer ${participant.token}` };
    assert.equal((await fetch(endpoint + "/api/mobile/inbox", { headers: { authorization: "Bearer fictitious" } })).status, 401);
    const created = await post("/api/operator/checkins", requestBody, opHeaders); assert.equal(created.status, 201);
    const projection = await created.json(); assert.equal(projection.counts.requested, 1); assert.equal(projection.counts.pending, 1);
    const command = projection.command;
    assert.equal((await fetch(endpoint + "/api/operator/checkins/" + command.eventId + "?limit=101", { headers: { cookie } })).status, 400);
    assert.equal((await fetch(endpoint + "/api/operator/checkins/" + command.eventId + "?offset=-1", { headers: { cookie } })).status, 400);
    assert.equal(await verifyCommandForDevice(command, material.mobileTrust.authorities, "north"), true);
    assert.equal((await fetch(endpoint + "/api/mobile/inbox")).status, 401);
    assert.equal((await fetch(endpoint + "/api/mobile/inbox?deviceId=another", { headers: mobileHeaders })).status, 400);
    assert.equal((await fetch(endpoint + "/api/mobile/inbox?limit=101", { headers: mobileHeaders })).status, 400);
    const inbox = await fetch(endpoint + "/api/mobile/inbox", { headers: mobileHeaders }); assert.equal(inbox.headers.get("cache-control"), "no-store");
    assert.equal((await inbox.json()).commands[0].eventId, command.eventId);
    const southIdentity = await createBrowserIdentity();
    const southChallenge = await (await post("/api/mobile/enrollment/challenge", { code: material.enrollmentCode, publicKey: southIdentity.publicKey, zoneId: "south" })).json();
    const southKey = await crypto.subtle.importKey("jwk", southIdentity.privateKeyJwk, { name: "Ed25519" }, false, ["sign"]);
    const southProof = Buffer.from(await crypto.subtle.sign("Ed25519", southKey, enrollmentProofBytes(southChallenge))).toString("base64url");
    const southParticipant = await (await post("/api/mobile/enrollment", { challengeId: southChallenge.challengeId, signature: southProof })).json();
    const southHeaders = { authorization: `Bearer ${southParticipant.token}` };
    assert.deepEqual((await (await fetch(endpoint + "/api/mobile/inbox", { headers: southHeaders })).json()).commands, []);
    const received = await createCheckinReceipt(command, "RECEIVED", browserIdentity);
    assert.equal((await post("/api/mobile/receipts", { report: received })).status, 401);
    assert.equal((await post("/api/mobile/receipts", { report: received }, southHeaders)).status, 403);
    assert.equal((await post("/api/mobile/receipts", { report: received }, mobileHeaders)).status, 202);
    const shown = await createCheckinReceipt(command, "SHOWN", browserIdentity);
    assert.equal((await post("/api/mobile/receipts", { report: shown }, mobileHeaders)).status, 202);
    const item = await createCheckinResponse(command, "NEEDS_HELP", browserIdentity);
    const outsider = await createCheckinResponse(command, "SAFE", await createBrowserIdentity());
    const rejected = await fetch(endpoint + "/api/packets", { method: "POST", body: canonicalCbor(outsider.envelope) });
    assert.equal(rejected.status, 400); assert.equal((await rejected.json()).evidence, undefined);
    const reply = await fetch(endpoint + "/api/packets", { method: "POST", body: canonicalCbor(item.envelope) });
    const outcome = await reply.json(); assert.equal(reply.status, 202); assert.equal(outcome.evidence.level, "BACKEND");
    const detail = await (await fetch(endpoint + "/api/operator/checkins/" + command.eventId, { headers: { cookie } })).json();
    assert.equal(detail.counts.needsHelp, 1); assert.equal(detail.counts.responded, 1); assert.equal(detail.counts.received, 1); assert.equal(detail.counts.shown, 1);
    assert.deepEqual((await (await fetch(endpoint + "/api/areas")).json()).areas, []);
    assert.equal((await fetch(endpoint + "/api/events")).status, 404);
    // Ordinary reports remain compatible and separate from the private check-in response.
    const oldReport = await createOutboxItem({ action: "SAFE", eventId: "ordinary-report" }, browserIdentity);
    assert.equal((await fetch(endpoint + "/api/packets", { method: "POST", body: canonicalCbor(oldReport.envelope) })).status, 202);
    await stop(child); child = undefined;
    child = await start(port, configPath, databasePath);
    assert.equal((await fetch(endpoint + "/api/operator/session", { headers: { cookie } })).status, 401);
    assert.equal((await fetch(endpoint + "/api/mobile/inbox", { headers: mobileHeaders })).status, 200);
    const duplicate = await (await fetch(endpoint + "/api/packets", { method: "POST", body: canonicalCbor(item.envelope) })).json(); assert.equal(duplicate.status, "DUPLICATE");
    const nextLogged = await post("/api/operator/login", { password: material.operatorPassword }); const nextLogin = await nextLogged.json();
    const nextCookie = nextLogged.headers.get("set-cookie")!.split(";")[0];
    const afterRestart = await (await fetch(endpoint + "/api/operator/checkins/" + command.eventId, { headers: { cookie: nextCookie } })).json();
    assert.deepEqual(afterRestart, detail);
    assert.equal((await post("/api/operator/logout", {}, { cookie: nextCookie, "x-coluvi-csrf": nextLogin.csrf })).status, 200);
    assert.equal((await fetch(endpoint + "/api/operator/session", { headers: { cookie: nextCookie } })).status, 401);
    await stop(child); child = undefined;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM reports").get()?.n, 1);
    const savedHash = database.prepare("SELECT token_hash FROM coluvi_credentials").get()?.token_hash;
    assert.equal(typeof savedHash, "string"); assert.notEqual(savedHash, participant.token);
    assert.ok(Number(database.prepare("SELECT COUNT(*) AS n FROM coluvi_audit WHERE action='OPERATOR_LOGIN'").get()?.n) >= 2);
    database.close();
  } finally { await stop(child); rmSync(directory, { recursive: true, force: true }); }
});

test("configuration requires owned private keys, valid origin, matching authority and secure network binding", async () => {
  const directory = mkdtempSync("/tmp/coluvi-config-"); const path = join(directory, "config.json");
  try {
    const material = await createColuviConfiguration(createDeviceIdentity(), "http://127.0.0.1:8797", ["north"]);
    writeFileSync(path, JSON.stringify(material.configuration), { mode: 0o600 });
    assert.equal(loadColuviConfiguration(path, "127.0.0.1", false).authority.issuerId, material.configuration.authority.issuerId);
    assert.throws(() => loadColuviConfiguration(path, "0.0.0.0", false), /loopback/);
    assert.throws(() => loadColuviConfiguration(path, "127.0.0.1", true), /scheme/);
    chmodSync(path, 0o644); assert.throws(() => loadColuviConfiguration(path, "127.0.0.1", false), /private/); chmodSync(path, 0o600);
    const wrongKey = { ...material.configuration, authority: { ...material.configuration.authority, publicKey: "other" } };
    writeFileSync(path, JSON.stringify(wrongKey)); assert.throws(() => loadColuviConfiguration(path, "127.0.0.1", false), /authority/);
    const https = { ...material.configuration, origin: "https://192.168.1.252:8797" };
    writeFileSync(path, JSON.stringify(https)); assert.throws(() => loadColuviConfiguration(path, "127.0.0.1", false), /TLS/);
    assert.equal(loadColuviConfiguration(path, "0.0.0.0", true).origin, https.origin);
    for (const origin of ["http://192.168.1.252:8797", "https://user:password@pilot.test", "https://pilot.test/path", "https://pilot.test/"]) assert.throws(() => validatePilotOrigin(origin));
    assert.equal(readFileSync(path, "utf8").includes(material.operatorPassword), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("pilot material generator never overwrites existing secrets or prints them", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync("/tmp/coluvi-generator-"); const target = join(directory, "new-pilot");
  const run = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/create-coluvi-pilot.mjs", "http://127.0.0.1:8797", target, "north"], { cwd: repository });
    let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject); child.once("exit", (code) => resolve({ code, output }));
  });
  try {
    const first = await run(); assert.equal(first.code, 0);
    const secret = readFileSync(join(target, "operator-secrets.txt"), "utf8");
    assert.equal(first.output.includes(secret.split("Operator password: ")[1].split("\n")[0]), false);
    const config = readFileSync(join(target, "operator-config.json"), "utf8");
    const second = await run(); assert.notEqual(second.code, 0);
    assert.equal(readFileSync(join(target, "operator-config.json"), "utf8"), config);
    assert.equal(readFileSync(join(target, "operator-secrets.txt"), "utf8"), secret);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
