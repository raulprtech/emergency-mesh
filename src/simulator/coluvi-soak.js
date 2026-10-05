import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { createDeviceIdentityFromSeed } from "../protocol/identity.ts";
import { createColuviConfiguration } from "../commands/config.ts";
import { ColuviStore } from "../commands/store.ts";
import { createCheckinResponse, createCheckinUpdate, createCheckinNeeds, createCheckinReceipt } from "../mobile-client/commands.js";
import { createNoticeReceipt } from "../mobile-client/notices.js";
import { canonicalCbor } from "../mobile-client/crypto.js";
import { validBackendEvidence } from "../mobile-client/core.js";
import { freePort, ready, stop } from "../../examples/browser-fixture.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const zones = ["soak-north", "soak-center", "soak-south"];
const fixtureIdentity = (seed, label) => createDeviceIdentityFromSeed(createHash("sha256").update(`COLUVI-SOAK-FIXTURE:${seed}:${label}`).digest());
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1] ?? null, p95: sorted[Math.ceil(sorted.length * .95) - 1] ?? null, max: sorted.at(-1) ?? null };
};

/** Continuous real-time local HTTP workload. Short tests cannot claim three-hour qualification. */
export async function runSoak({ durationMs = 3 * 60 * 60_000, intervalMs = 30_000, devices = 30, restartEvery = 20, seed = 20261005, signal, progress = () => {} } = {}) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > 6 * 60 * 60_000) throw new Error("Duration must be from one second to six hours");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000 || Math.ceil(durationMs / intervalMs) > 1000) throw new Error("Invalid interval or excessive round count");
  if (!Number.isSafeInteger(devices) || devices < 3 || devices > 90 || devices % 3) throw new Error("Use 3 to 90 devices in balanced zones");
  if (!Number.isSafeInteger(restartEvery) || restartEvery < 1 || restartEvery > 100) throw new Error("Invalid restart interval");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Invalid seed");
  signal?.throwIfAborted();
  const directory = mkdtempSync("/tmp/coluvi-soak-fixture-"); const databasePath = join(directory, "fixture.sqlite"); const configPath = join(directory, "config.json");
  const acknowledged = new Map(); const endpointMetrics = new Map(); const audits = []; const roundSamples = [];
  const serverMetrics = { samples: 0, maxRssBytes: 0, maxHeapUsedBytes: 0, maxEventLoopDelayMs: 0, cpuUserMs: 0, cpuSystemMs: 0 };
  const counts = { rounds: 0, commands: 0, notices: 0, receiptAcknowledgements: 0, packetAcknowledgements: 0, duplicates: 0, heartbeats: 0, rateLimited: 0, restarts: 0 };
  let child; let activeStart; let cookie; let csrf; let lastRound = []; let phase = "SETUP";
  const snapshot = () => ({ phase, counts: { ...counts }, acknowledgedPackets: acknowledged.size,
    observedMs: activeStart === undefined ? 0 : performance.now() - activeStart, server: { ...serverMetrics } });
  try {
    const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
    const material = await createColuviConfiguration(fixtureIdentity(seed, "issuer"), origin, zones, ["CHECKIN_REQUEST", "OPERATIONAL_NOTICE"]);
    writeFileSync(configPath, JSON.stringify(material.configuration), { flag: "wx", mode: 0o600 });
    const clients = []; const store = new ColuviStore(databasePath, material.mobileTrust.authorities);
    try {
      for (let index = 0; index < devices; index++) {
        const identity = fixtureIdentity(seed, index); const mobile = { mode: "ED25519", anonymousDeviceId: identity.anonymousDeviceId,
          publicKey: identity.publicKey.export({ type: "spki", format: "der" }).toString("base64url"), privateKeyJwk: identity.privateKey.export({ format: "jwk" }) };
        store.enroll(mobile.publicKey, zones[index % 3]);
        clients.push({ index, mobile, token: store.grantCredential(mobile.anonymousDeviceId).token });
      }
    } finally { store.close(); }
    const start = async () => {
      child = spawn(process.execPath, ["examples/instrumented-server.mjs"], { cwd: repository, stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
        ...process.env, PORT: String(port), EMERGENCY_MESH_HOST: "127.0.0.1", EMERGENCY_MESH_DATABASE_PATH: databasePath,
        EMERGENCY_MESH_COLUVI_CONFIG_PATH: configPath, EMERGENCY_MESH_TLS_CERT_PATH: "", EMERGENCY_MESH_TLS_KEY_PATH: "", EMERGENCY_MESH_ENABLE_DEBUG_EVENTS: "0",
        EMERGENCY_MESH_INGEST_WINDOW_SECONDS: "60", EMERGENCY_MESH_INGEST_GLOBAL_REQUESTS: "600", EMERGENCY_MESH_INGEST_IDENTITY_REQUESTS: "60", EMERGENCY_MESH_INGEST_MAX_IDENTITIES: "10000",
      } });
      child.stderr.resume(); child.on("message", sample => {
        if (sample?.type !== "COLUVI_FIXTURE_METRICS") return;
        if (![sample.rssBytes, sample.heapUsedBytes, sample.eventLoopMaxMs, sample.cpuUserMs, sample.cpuSystemMs].every(value => Number.isFinite(value) && value >= 0)) return;
        serverMetrics.samples++; serverMetrics.maxRssBytes = Math.max(serverMetrics.maxRssBytes, sample.rssBytes);
        serverMetrics.maxHeapUsedBytes = Math.max(serverMetrics.maxHeapUsedBytes, sample.heapUsedBytes); serverMetrics.maxEventLoopDelayMs = Math.max(serverMetrics.maxEventLoopDelayMs, sample.eventLoopMaxMs);
        serverMetrics.cpuUserMs += sample.cpuUserMs; serverMetrics.cpuSystemMs += sample.cpuSystemMs;
      });
      await ready(child, child.stdout, text => text.includes("Emergency Map:"));
    };
    const request = async (path, init = {}, expected = 200) => {
      signal?.throwIfAborted(); const started = performance.now(); const route = path.replace(/(\/api\/operator\/(?:checkins|notices))\/[^?]+/, "$1/:id").split("?")[0];
      const key = `${init.method ?? "GET"} ${route}`;
      if (!endpointMetrics.has(key)) endpointMetrics.set(key, { times: [], statuses: {}, failures: 0 }); const metric = endpointMetrics.get(key);
      try {
        const response = await fetch(origin + path, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
        const body = await response.json(); metric.statuses[response.status] = (metric.statuses[response.status] ?? 0) + 1;
        if (response.status === 429) {
          counts.rateLimited++; assert.equal(body.evidence, undefined);
          const pause = Math.max(Number(response.headers.get("retry-after")) * 1000, body.retryAfterMs ?? 0);
          assert.ok(Number.isFinite(pause) && pause > 0 && pause <= 61_000);
          await delay(pause, undefined, { signal }); return request(path, init, expected);
        }
        assert.equal(response.status, expected, `Unexpected status for ${key}`); metric.times.push(performance.now() - started);
        return { body, headers: response.headers };
      } catch (error) { metric.failures++; throw error; }
    };
    const login = async () => {
      const result = await request("/api/operator/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password: material.operatorPassword }) });
      cookie = result.headers.get("set-cookie").split(";")[0]; csrf = result.body.csrf;
    };
    const operatorPost = (path, body) => request(path, { method: "POST", headers: { cookie, origin, "x-coluvi-csrf": csrf, "content-type": "application/json" }, body: JSON.stringify(body) }, 201);
    const sendPacket = async (item, replay = false) => {
      const result = await request("/api/packets", { method: "POST", headers: { "content-type": "application/cbor" }, body: canonicalCbor(item.envelope) }, 202);
      assert.ok(validBackendEvidence(result.body.evidence, item, result.body.status));
      if (replay) assert.equal(result.body.status, "DUPLICATE");
      counts.packetAcknowledgements++; if (result.body.status === "DUPLICATE") counts.duplicates++;
      acknowledged.set(item.eventId, item.envelope.report);
    };
    const heartbeat = async () => {
      const [health, map] = await Promise.all([request("/health"), request("/api/areas")]);
      assert.equal(health.body.status, "ok"); assert.deepEqual(map.body.areas, []); counts.heartbeats++;
    };
    const audit = label => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        const rows = db.prepare("SELECT event_id, report_json FROM coluvi_responses UNION ALL SELECT event_id, report_json FROM coluvi_needs").all();
        assert.equal(rows.length, acknowledged.size);
        for (const row of rows) assert.deepEqual(JSON.parse(row.report_json), acknowledged.get(row.event_id));
        audits.push({ label, round: counts.rounds, acknowledgedPacketsVerified: acknowledged.size, integrity: "ok", foreignKeyViolations: 0 });
      } finally { db.close(); }
    };
    await start(); await login(); activeStart = performance.now(); const startedAt = new Date().toISOString();
    progress({ type: "STARTED", startedAt, durationMs, devices });
    while (performance.now() - activeStart < durationMs) {
      signal?.throwIfAborted(); phase = "ROUND"; const roundBegan = performance.now(); const commands = []; const notices = []; lastRound = [];
      // Refresh explicitly before the one-hour operator session can expire.
      if (counts.rounds && counts.rounds % 20 === 0) await login();
      for (const zoneId of zones) {
        commands.push((await operatorPost("/api/operator/checkins", { incidentRef: `SIMULACRO-soak-${counts.rounds}`, zoneId, promptMs: 15 * 60_000, lateMs: 15 * 60_000 })).body.command); counts.commands++;
        notices.push((await operatorPost("/api/operator/notices", { incidentRef: `SIMULACRO-soak-${counts.rounds}`, zoneId, simulation: true, sourceLabel: "Fixture sostenido",
          title: "Prueba sostenida", message: "SIMULACRO sin instrucciones reales", level: "INFORMATION", validMs: 15 * 60_000 })).body.notice); counts.notices++;
      }
      let next = 0;
      const workerOutcomes = await Promise.allSettled(Array.from({ length: Math.min(6, devices) }, async () => {
        while (next < clients.length) {
          const client = clients[next++]; const zoneIndex = client.index % 3; const command = commands[zoneIndex]; const notice = notices[zoneIndex];
          const headers = { authorization: `Bearer ${client.token}` };
          const inbox = await request("/api/mobile/inbox", { headers }); const bulletin = await request("/api/mobile/notices", { headers });
          assert.ok(inbox.body.commands.some(value => value.eventId === command.eventId)); assert.ok(bulletin.body.notices.some(value => value.eventId === notice.eventId));
          if (client.index % 10 === 0) continue;
          for (const report of [await createCheckinReceipt(command, "RECEIVED", client.mobile), await createNoticeReceipt(notice, "RECEIVED", client.mobile)]) {
            const result = await request("/api/mobile/receipts", { method: "POST", headers: { ...headers, origin, "content-type": "application/json" }, body: JSON.stringify({ report }) }, 202);
            assert.equal(result.body.status, "ACCEPTED"); counts.receiptAcknowledgements++;
          }
          const first = await createCheckinResponse(command, "NEEDS_HELP", client.mobile);
          const update = await createCheckinUpdate(command, client.index % 2 ? "NEEDS_HELP" : "SAFE", client.mobile, first.envelope.report);
          const needs = await createCheckinNeeds(command, (client.index % 2 ? update : first).envelope.report, { categories: ["WATER"] }, client.mobile);
          const items = counts.rounds % 2 ? [update, needs, first] : [first, update, needs];
          for (const item of items) { await sendPacket(item); lastRound.push(item); }
        }
      }));
      const workerFailure = workerOutcomes.find(result => result.status === "rejected"); if (workerFailure) throw workerFailure.reason;
      for (let index = 0; index < zones.length; index++) {
        const scoped = clients.filter(client => client.index % 3 === index); const responders = scoped.filter(client => client.index % 10 !== 0);
        const projection = (await request(`/api/operator/checkins/${commands[index].eventId}?limit=100`, { headers: { cookie } })).body;
        assert.equal(projection.counts.requested, scoped.length); assert.equal(projection.counts.responded, responders.length);
        assert.equal(projection.counts.safe, responders.filter(client => client.index % 2 === 0).length);
        assert.equal(projection.counts.needsHelp, responders.filter(client => client.index % 2 === 1).length);
        assert.equal(projection.needsCounts.WATER, projection.counts.needsHelp);
        const noticeProjection = (await request(`/api/operator/notices/${notices[index].eventId}`, { headers: { cookie } })).body;
        assert.equal(noticeProjection.counts.received, responders.length); assert.equal(noticeProjection.counts.shown, 0);
      }
      counts.rounds++; await heartbeat();
      if (counts.rounds % restartEvery === 0) {
        phase = "RESTART"; const oldCookie = cookie; await stop(child, "SIGKILL"); audit("AFTER_SIGKILL"); counts.restarts++;
        await start(); await request("/api/operator/session", { headers: { cookie: oldCookie } }, 401); await login();
        for (const item of lastRound) await sendPacket(item, true);
        await heartbeat();
      }
      roundSamples.push(performance.now() - roundBegan); phase = "OBSERVING";
      const databaseBytes = [databasePath, databasePath + "-wal"].reduce((sum, path) => sum + (existsSync(path) ? statSync(path).size : 0), 0);
      progress({ type: "ROUND", ...snapshot(), roundMs: roundSamples.at(-1), databaseBytes });
      const nextRound = Math.min(activeStart + durationMs, roundBegan + intervalMs);
      while (performance.now() < nextRound) {
        await delay(Math.min(5000, Math.max(0, nextRound - performance.now())), undefined, { signal }); await heartbeat();
      }
    }
    phase = "FINAL_AUDIT"; audit("FINAL"); const observedMs = performance.now() - activeStart;
    return { version: 1, status: "PASS", evidence: "SUSTAINED_LOCAL_HTTP_REAL_TIME", startedAt, completedAt: new Date().toISOString(), observedMs,
      qualifiesThreeHours: observedMs >= 3 * 60 * 60_000, configuration: { durationMs, intervalMs, devices, restartEvery, seed }, counts, audits,
      acknowledgedPackets: acknowledged.size, server: serverMetrics, roundMs: stats(roundSamples),
      endpoints: Object.fromEntries([...endpointMetrics].map(([key, value]) => [key, { requestMs: stats(value.times), statuses: value.statuses, failures: value.failures }])),
      limitations: ["Synthetic Node clients and local HTTP, no Android, browser, TLS, radio or battery evidence", "Client ledger in parent memory, not a client-crash test", "Planned backend SIGKILLs between rounds, not in-flight or physical power loss", "Silence means no response, never danger", "No SHOWN or human-attention claim", "Fixed fixture keys are not pilot keys"] };
  } catch (error) { error.soakEvidence = snapshot(); throw error; }
  finally { await stop(child); rmSync(directory, { recursive: true, force: true }); }
}
