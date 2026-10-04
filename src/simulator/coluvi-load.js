import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDeviceIdentityFromSeed } from "../protocol/identity.ts";
import { createColuviConfiguration } from "../commands/config.ts";
import { createCheckinCommand } from "../commands/authority.ts";
import { ColuviStore } from "../commands/store.ts";
import { canonicalCbor } from "../mobile-client/crypto.js";
import { createCheckinResponse, createCheckinUpdate, createCheckinNeeds } from "../mobile-client/commands.js";
import { validBackendEvidence } from "../mobile-client/core.js";
import { SeededRandom } from "./random.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const zones = ["fictitious-north", "fictitious-center", "fictitious-south"];
const limits = { windowMs: 60_000, globalRequests: 600, identityRequests: 60, trackedIdentities: 10_000 };
function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * .95) - 1] ?? null, maximum: sorted.at(-1) ?? null };
}
function fixtureIdentity(seed, index) {
  // Public, reproducible test material. Never use these keys for a pilot.
  return createDeviceIdentityFromSeed(createHash("sha256").update(`COLUVI-LOAD-FIXTURE:${seed}:${index}`).digest());
}
async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}
async function stop(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function start(port, config, database) {
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: repository, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, PORT: String(port), EMERGENCY_MESH_HOST: "127.0.0.1", EMERGENCY_MESH_DATABASE_PATH: database,
    EMERGENCY_MESH_COLUVI_CONFIG_PATH: config, EMERGENCY_MESH_TLS_CERT_PATH: "", EMERGENCY_MESH_TLS_KEY_PATH: "",
    EMERGENCY_MESH_ENABLE_DEBUG_EVENTS: "0", EMERGENCY_MESH_INGEST_WINDOW_SECONDS: "60",
    EMERGENCY_MESH_INGEST_GLOBAL_REQUESTS: "600", EMERGENCY_MESH_INGEST_IDENTITY_REQUESTS: "60",
    EMERGENCY_MESH_INGEST_MAX_IDENTITIES: "10000",
  } });
  let output = ""; child.stderr.on("data", chunk => { output = (output + chunk).slice(-4_000); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Load fixture startup timeout: ${output}`)), 15_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Load fixture exited (${code}): ${output}`)); });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-4_000); if (stdout.includes("Emergency Map:")) { clearTimeout(timer); resolve(); } });
    });
    return child;
  } catch (error) { await stop(child); throw error; }
}

/** Actual local HTTP and SQLite timings; not a radio, handset, or enrollment benchmark. */
export async function runColuviLoad({ devices = 300, concurrency = 24, seed = 20261004, progress = () => {} } = {}) {
  if (!Number.isSafeInteger(devices) || devices < 30 || devices > 990 || devices % 30 !== 0) throw new Error("devices must be a multiple of 30 from 30 to 990");
  if (!Number.isSafeInteger(concurrency) || concurrency < 2 || concurrency > 64) throw new Error("concurrency must be from 2 to 64");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be uint32");
  if (process.env.WSL_DISTRO_NAME === "UbuntuPreview" || process.platform === "win32") throw new Error("Use Ubuntu WSL, not UbuntuPreview or Windows");
  const began = performance.now(); const deadline = Date.now() + 20 * 60_000;
  const directory = mkdtempSync(join(tmpdir(), "coluvi-load-"));
  const databasePath = join(directory, "fixture.sqlite"); const configPath = join(directory, "config.json");
  const acknowledged = new Map(); const timings = []; const crashes = [];
  const counters = { accepted: 0, duplicates: 0, rateLimited: 0, interruptedRequests: 0, maximumInFlight: 0 };
  const clients = []; const stages = [[], [], []]; let commands = []; let child;
  let resumeAt = 0; let inFlight = 0; let requestsAtKill = 0;
  const random = new SeededRandom(seed);
  const shuffle = items => { for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(random.next() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; } return items; };
  const checkDeadline = () => { if (Date.now() >= deadline) throw new Error("Load scenario exceeded twenty minutes"); };
  try {
    const port = await freePort(); const endpoint = `http://127.0.0.1:${port}`;
    const issuer = fixtureIdentity(seed, "issuer");
    const material = await createColuviConfiguration(issuer, endpoint, zones);
    writeFileSync(configPath, JSON.stringify(material.configuration), { mode: 0o600, flag: "wx" });
    const store = new ColuviStore(databasePath, [material.configuration.authority]);
    try {
      for (let index = 0; index < devices; index++) {
        checkDeadline(); const identity = fixtureIdentity(seed, index);
        const mobile = { mode: "ED25519", anonymousDeviceId: identity.anonymousDeviceId,
          publicKey: identity.publicKey.export({ type: "spki", format: "der" }).toString("base64url"), privateKeyJwk: identity.privateKey.export({ format: "jwk" }) };
        store.enroll(mobile.publicKey, zones[index % 3]);
        clients.push({ index, mobile, token: store.grantCredential(mobile.anonymousDeviceId).token });
        if ((index + 1) % 50 === 0) progress(`Provisioned ${index + 1}/${devices} fictional devices`);
      }
      const now = Date.now();
      commands = zones.map((zoneId, index) => createCheckinCommand(issuer, material.configuration.authority, {
        commandId: `load-${seed}-${index}`, incidentRef: "SIMULACRO-fictitious-flood", zoneId, nonce: `load-command-${index}`,
        issuedAt: now, promptUntil: now + 2 * 60 * 60_000, responseUntil: now + 3 * 60 * 60_000,
      }));
      for (const command of commands) store.issue(command);
      for (const { index, mobile } of clients) {
        if (index % 10 === 0) continue; // No answer is not a danger classification.
        const command = commands[index % 3]; const when = Date.now();
        const first = await createCheckinResponse(command, "NEEDS_HELP", mobile, when);
        const latest = await createCheckinUpdate(command, index % 2 === 0 ? "SAFE" : "NEEDS_HELP", mobile, first.envelope.report, when);
        const detail = await createCheckinNeeds(command, (index % 2 === 0 ? first : latest).envelope.report,
          { categories: ["WATER", "TRANSPORT"], peopleAffected: 3 }, mobile, null, when);
        stages[0].push(latest); stages[1].push(detail); stages[2].push(first);
      }
    } finally { store.close(); }
    for (const stage of stages) { shuffle(stage); for (const item of stage) item.bytes = canonicalCbor(item.envelope); }
    const all = stages.flat(); const setupMs = performance.now() - began;
    const fetchLocal = (path, init = {}) => fetch(endpoint + path, { ...init, signal: AbortSignal.timeout(10_000) });
    async function login() {
      const response = await fetchLocal("/api/operator/login", { method: "POST", headers: { "content-type": "application/json", origin: endpoint }, body: JSON.stringify({ password: material.operatorPassword }) });
      assert.equal(response.status, 200); await response.json(); return response.headers.get("set-cookie").split(";")[0];
    }
    async function checkCredentials() {
      for (const client of clients.slice(0, 3)) {
        const response = await fetchLocal("/api/mobile/inbox", { headers: { authorization: `Bearer ${client.token}` } });
        assert.equal(response.status, 200); const data = await response.json();
        assert.deepEqual(data.commands.map(value => value.eventId), [commands[client.index % 3].eventId]);
      }
    }
    async function rejectInvalidPackets() {
      const wrongZone = await createCheckinResponse(commands[1], "SAFE", clients[0].mobile);
      const altered = structuredClone(stages[0][0].envelope);
      altered.report.signature = "invalid-signature";
      for (const envelope of [wrongZone.envelope, altered]) {
        const response = await fetchLocal("/api/packets", { method: "POST", headers: { "content-type": "application/cbor" }, body: canonicalCbor(envelope) });
        assert.equal(response.status, 400); const data = await response.json(); assert.equal(data.evidence, undefined);
      }
    }
    async function checkMissingPredecessors(cookie, detailsArrived) {
      let checked = 0;
      for (const command of commands) {
        for (let offset = 0; offset < devices / 3; offset += 100) {
          const response = await fetchLocal(`/api/operator/checkins/${command.eventId}?offset=${offset}&limit=100`, { headers: { cookie } });
          assert.equal(response.status, 200); const page = await response.json();
          for (const recipient of page.recipients) {
            if (!recipient.history.length) continue;
            assert.equal(recipient.history.length, 1); assert.equal(recipient.history[0].link, "MISSING");
            assert.equal(recipient.needsHistory.length, detailsArrived ? 1 : 0);
            if (!detailsArrived || recipient.state === "SAFE") assert.equal(recipient.needs, null);
            else assert.deepEqual(recipient.needs.categories, ["WATER", "TRANSPORT"]);
            checked++;
          }
        }
      }
      assert.equal(checked, devices * .9);
    }
    function auditDurability(label) {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.deepEqual(db.prepare("PRAGMA integrity_check").all().map(row => row.integrity_check), ["ok"]);
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        const rows = db.prepare("SELECT event_id, report_json FROM coluvi_responses UNION ALL SELECT event_id, report_json FROM coluvi_needs").all();
        const persisted = new Map(rows.map(row => [row.event_id, JSON.parse(row.report_json)]));
        for (const [id, report] of acknowledged) assert.deepEqual(persisted.get(id), report, "Acknowledged signed report must survive SIGKILL");
        crashes.push({ label, signal: "SIGKILL", acknowledgedVerified: acknowledged.size, persisted: rows.length,
          committedWithoutObservedAck: rows.filter(row => !acknowledged.has(row.event_id)).length, integrity: "ok", foreignKeyViolations: 0 });
      } finally { db.close(); }
    }
    async function deliver(items, { killAfter = 0, replay = false } = {}) {
      let next = 0; let halted = false; let killPromise;
      const workers = Array.from({ length: concurrency }, async () => {
        while (!halted && next < items.length) {
          const item = items[next++];
          for (;;) {
            checkDeadline(); if (halted) return;
            while (Date.now() < resumeAt && !halted) { await delay(Math.min(1_000, resumeAt - Date.now())); checkDeadline(); }
            if (halted) return;
            const sent = performance.now(); inFlight++; counters.maximumInFlight = Math.max(counters.maximumInFlight, inFlight);
            let response; let data;
            try {
              response = await fetchLocal("/api/packets", { method: "POST", headers: { "content-type": "application/cbor" }, body: item.bytes });
              data = await response.json();
            } catch (error) {
              if (!halted) throw error;
              counters.interruptedRequests++; return;
            } finally { inFlight--; }
            if (response.status === 429) {
              assert.equal(data.evidence, undefined); counters.rateLimited++;
              assert.ok(Number.isSafeInteger(data.retryAfterMs) && data.retryAfterMs > 0);
              const waitMs = Math.max(data.retryAfterMs, Number(response.headers.get("retry-after")) * 1_000);
              assert.ok(Number.isFinite(waitMs) && waitMs <= 61_000);
              if (Date.now() >= resumeAt) progress(`Admission limit reached; honoring Retry-After (${Math.ceil(waitMs / 1_000)} s)`);
              resumeAt = Math.max(resumeAt, Date.now() + waitMs); continue;
            }
            assert.equal(response.status, 202, JSON.stringify(data));
            assert.ok(["ACCEPTED", "DUPLICATE"].includes(data.status));
            if (replay) assert.equal(data.status, "DUPLICATE");
            assert.ok(validBackendEvidence(data.evidence, item, data.status));
            counters[data.status === "ACCEPTED" ? "accepted" : "duplicates"]++;
            timings.push(performance.now() - sent); acknowledged.set(item.eventId, item.envelope.report);
            if (killAfter && !halted && acknowledged.size >= killAfter) {
              requestsAtKill = inFlight; halted = true; killPromise = stop(child, "SIGKILL");
            }
            if ((counters.accepted + counters.duplicates) % 100 === 0) progress(`Validated ${counters.accepted + counters.duplicates} HTTP acknowledgements`);
            break;
          }
        }
      });
      const outcomes = await Promise.allSettled(workers); if (killPromise) await killPromise;
      const failure = outcomes.find(outcome => outcome.status === "rejected"); if (failure) throw failure.reason;
      if (killAfter) { assert.ok(halted); assert.equal(child.signalCode, "SIGKILL"); assert.ok(requestsAtKill > 0, "Crash must overlap outstanding HTTP requests"); }
    }
    async function projection(cookie) {
      const result = [];
      for (const command of commands) {
        let value;
        for (let offset = 0; offset < devices / 3; offset += 100) {
          const response = await fetchLocal(`/api/operator/checkins/${command.eventId}?offset=${offset}&limit=100`, { headers: { cookie } });
          assert.equal(response.status, 200); const page = await response.json();
          if (!value) value = { counts: page.counts, needsCounts: page.needsCounts, recipients: [] };
          value.recipients.push(...page.recipients);
        }
        assert.equal(value.counts.requested, devices / 3); assert.equal(value.counts.responded, devices * .3);
        assert.equal(value.counts.safe, devices * 4 / 30); assert.equal(value.counts.needsHelp, devices / 6);
        assert.equal(value.counts.pending, devices / 30); assert.equal(value.counts.unknown, 0);
        assert.equal(value.needsCounts.WATER, devices / 6); assert.equal(value.needsCounts.TRANSPORT, devices / 6);
        assert.equal(value.recipients.length, devices / 3);
        for (const recipient of value.recipients) {
          if (!recipient.history.length) { assert.equal(recipient.state, "PENDING"); assert.equal(recipient.needsHistory.length, 0); continue; }
          assert.equal(recipient.history.length, 2); assert.equal(recipient.history[1].link, "LINKED");
          assert.equal(recipient.needsHistory.length, 1);
          if (recipient.state === "SAFE") assert.equal(recipient.needs, null);
          else { assert.equal(recipient.state, "NEEDS_HELP"); assert.deepEqual(recipient.needs.categories, ["WATER", "TRANSPORT"]); assert.equal(recipient.needs.peopleAffected, 3); }
        }
        result.push(value);
      }
      return result;
    }
    child = await start(port, configPath, databasePath); let cookie = await login(); await checkCredentials();
    await rejectInvalidPackets();
    progress(`Delivering ${all.length} unique signed packets, updates before their predecessors`);
    await deliver(stages[0], { killAfter: Math.min(12, concurrency) }); auditDurability("during-concurrent-updates");
    child = await start(port, configPath, databasePath);
    const staleSession = await fetchLocal("/api/operator/session", { headers: { cookie } }); assert.equal(staleSession.status, 401); await staleSession.text();
    await checkCredentials(); cookie = await login();
    for (const [index, stage] of stages.entries()) {
      await deliver(stage.filter(item => !acknowledged.has(item.eventId)));
      if (index < 2) await checkMissingPredecessors(cookie, index === 1);
    }
    assert.equal(acknowledged.size, all.length);
    const before = await projection(cookie);
    await stop(child, "SIGKILL"); assert.equal(child.signalCode, "SIGKILL"); auditDurability("after-all-confirmations");
    child = await start(port, configPath, databasePath); resumeAt = 0; cookie = await login(); await checkCredentials();
    const replayStarted = performance.now(); await deliver(all, { replay: true });
    const replayMs = performance.now() - replayStarted;
    assert.deepEqual(await projection(cookie), before, "Full replay must not change counts or immutable histories");
    const publicResponse = await fetchLocal("/api/areas"); assert.equal(publicResponse.status, 200); assert.deepEqual((await publicResponse.json()).areas, []);
    return { version: 1, recordedAt: new Date().toISOString(), evidence: "LOCAL_HTTP_SQLITE_ONLY", scenario: "SIMULACRO fictitious flood load and crash recovery",
      harnessSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
      environment: { node: process.version, platform: process.platform, distro: process.env.WSL_DISTRO_NAME ?? null },
      configuration: { devices, zones: 3, concurrency, seed, admissionLimits: limits, enrollment: "trusted fixture provisioning, not HTTP enrollment", silentDevices: devices / 10 },
      counts: { uniqueSignedPackets: all.length, stateEvents: stages[0].length + stages[2].length, needsEvents: stages[1].length,
        requested: devices, responded: devices * .9, safe: devices * .4, needsHelp: devices * .5, pending: devices * .1, activeWater: devices * .5, activeTransport: devices * .5 },
      http: { ...counters, requestsOutstandingAtKill: requestsAtKill, fullReplayDuplicates: all.length }, crashes,
      checks: { allAcknowledgedReportsDurable: true, immutableHistoryAfterReplay: true, allRecipientPagesVerified: true,
        missingPredecessorsExplicitBeforeArrival: true, independentlyArrivingNeedsVerified: true, invalidPacketsRejectedWithoutAck: 2,
        privateReportsExcludedFromPublicMap: true, sampledCredentialsSurviveRestarts: 3, operatorSessionInvalidated: true },
      timing: { wallMs: performance.now() - began, setupMs, replayMs, successfulRequestMs: statistics(timings) },
      limitations: ["Synthetic Node clients, not simultaneous PWA instances or physical Android phones", "Loopback HTTP; no LAN, Internet, TLS, radio, range or battery measurement",
        "SIGKILL of backend process, not host power loss or disk failure", "Client ledger remains in parent memory; not proof of client crash recovery",
        "Successful request timings exclude queue and Retry-After waiting; wall time includes them", "Seed fixes fixture identities and scheduling shuffle, not OS timing or the crash commit boundary", "No operational notices or HTTP enrollment throughput measured"] };
  } finally { await stop(child); rmSync(directory, { recursive: true, force: true }); }
}
