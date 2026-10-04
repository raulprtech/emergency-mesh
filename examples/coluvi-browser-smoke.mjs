import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeviceIdentity, signReport } from "../src/protocol/identity.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { canonicalCbor } from "../src/mobile-client/crypto.js";
import { createColuviConfiguration } from "../src/commands/config.ts";
import { authorityFor, createCheckinCommand } from "../src/commands/authority.ts";
import { reloadDocument } from "./browser-fixture.mjs";

// Owns only fresh fixture processes/files. No TLS bypass, real participant or pilot DB.
const executable = process.env.COLUVI_CHROMIUM_PATH;
if (!executable) throw new Error("Set COLUVI_CHROMIUM_PATH to an installed Chromium executable");
const repository = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync("/tmp/coluvi-browser-smoke-");
const connections = [];
let browser;
let server;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited; clearTimeout(timer);
}
async function freePort() {
  const probe = createServer(); await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve)); return port;
}
async function regression(script, args) {
  const child = spawn(process.execPath, [script, ...args], { cwd: repository, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let errors = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-131072); });
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-4096); });
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Regression ${script} timed out`)), 120_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); resolve(code); });
    });
    if (code !== 0) throw new Error(`Regression ${script} failed: ${errors || output}`);
    return JSON.parse(output);
  } finally { await stop(child); }
}
async function ready(child, stream, match) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Fixture exited before ready (${code})`)); });
    stream.setEncoding("utf8"); stream.on("data", (chunk) => { buffer = (buffer + chunk).slice(-8192); const value = match(buffer); if (value) { clearTimeout(timer); resolve(value); } });
  });
}
async function connect(debugOrigin, url) {
  const target = await (await fetch(`${debugOrigin}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl); const pending = new Map(); let sequence = 0; const diagnostics = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(`CDP ${item.method}: ${message.error.message}`)) : item.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") diagnostics.push(message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) diagnostics.push(message.params.type);
  });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20_000);
    pending.set(id, { resolve, reject, timer, method }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    let result;
    try { result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); }
    catch (error) { throw new Error("Browser evaluation transport failed", { cause: error }); }
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text}`);
    return result.result.value;
  };
  const until = async (expression, label, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await wait(100); }
    throw new Error(`Browser condition timed out: ${label}`);
  };
  const result = { socket, send, evaluate, until, diagnostics, targetId: target.id };
  connections.push(result);
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  return result;
}

try {
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  const material = await createColuviConfiguration(createDeviceIdentity(), origin, ["refugio-ficticio"], ["CHECKIN_REQUEST", "OPERATIONAL_NOTICE"]);
  const configPath = join(directory, "config.json"); const databasePath = join(directory, "fixture.sqlite");
  writeFileSync(configPath, JSON.stringify(material.configuration), { mode: 0o600 });
  const startServer = async () => {
    server = spawn(process.execPath, ["src/server.ts"], { cwd: repository, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, PORT: String(port), EMERGENCY_MESH_HOST: "127.0.0.1", EMERGENCY_MESH_DATABASE_PATH: databasePath,
      EMERGENCY_MESH_COLUVI_CONFIG_PATH: configPath, EMERGENCY_MESH_TLS_CERT_PATH: "", EMERGENCY_MESH_TLS_KEY_PATH: "", EMERGENCY_MESH_ENABLE_DEBUG_EVENTS: "0",
      EMERGENCY_MESH_PUBLIC_MIN_GROUP_SIZE: "3",
    } });
    server.stderr.resume(); await ready(server, server.stdout, (text) => text.includes("Emergency Map:"));
  };
  await startServer();
  // Public, coarse fictional reports are independent of the private check-in cycle.
  for (let index = 0; index < 6; index++) {
    const identity = createDeviceIdentity(); const now = Date.now();
    const report = signReport({ ...makeReport({ identity, eventType: index < 3 ? "SOS" : "SAFE", createdAt: now }),
      location: { zoneId: "refugio-norte", source: "ZONE", timestamp: now },
      needs: [], shortMessage: "SIMULACRO: este texto no es público",
    }, identity);
    const response = await fetch(origin + "/api/packets", { method: "POST", body: canonicalCbor({ packetId: report.eventId, report, expiresAt: report.validUntil, hopCount: 0, hopLimit: 12 }) });
    assert.equal(response.status, 202); assert.equal((await response.json()).status, "ACCEPTED");
  }
  const initialPublicAreas = (await (await fetch(origin + "/api/areas")).json()).areas;
  assert.equal(initialPublicAreas.length, 1); assert.equal(initialPublicAreas[0].total, 6);
  browser = spawn(executable, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const debuggerUrl = await ready(browser, browser.stderr, (text) => text.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]);
  const debugOrigin = `http://${new URL(debuggerUrl).host}`;
  const map = await connect(debugOrigin, origin + "/map/");
  await map.until("document.querySelectorAll('#areas .area').length === 1 && document.querySelector('#saved-status').textContent.includes('Vista pública guardada')", "integrated public map persisted");
  await map.until("Boolean(navigator.serviceWorker.controller)", "map worker ready before outage");
  assert.equal(await map.evaluate("document.body.textContent.includes('este texto no es público')"), false);
  const mapSnapshot = `(async () => { const { openPublicMapStore } = await import('/map/storage.js'); const store = await openPublicMapStore(); try { return (await store.read()).areas; } finally { store.close(); } })()`;
  assert.deepEqual(await map.evaluate(mapSnapshot), initialPublicAreas);
  const mapOffline = async offline => {
    const conditions = { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: offline ? "none" : "wifi" };
    await map.send("Network.emulateNetworkConditions", conditions); await map.send("Network.overrideNetworkState", conditions);
  };
  let mobile = await connect(debugOrigin, origin + "/health");
  await mobile.until("location.pathname === '/health' && document.readyState === 'complete'", "seed origin");
  // Seed the real old schema before loading the upgraded application.
  const originalId = await mobile.evaluate(`(async () => {
    const { createBrowserIdentity } = await import('/mobile/crypto.js');
    const { createOutboxItem } = await import('/mobile/core.js');
    const identity = await createBrowserIdentity();
    const item = await createOutboxItem({ action: 'SAFE', shortMessage: 'SIMULACRO anterior a migración' }, identity);
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('emergency-mesh-client', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('outbox', { keyPath: 'eventId' }); request.result.createObjectStore('settings', { keyPath: 'key' }); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result; const tx = database.transaction(['outbox', 'settings'], 'readwrite');
        tx.objectStore('outbox').put(item); tx.objectStore('settings').put({ key: 'identity', value: identity }); tx.objectStore('settings').put({ key: 'locale', value: 'es' });
        tx.oncomplete = () => { database.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    });
    return identity.anonymousDeviceId;
  })()`);
  await mobile.send("Page.navigate", { url: origin + "/mobile/" });
  await mobile.until("Boolean(document.querySelector('#identity-status')?.textContent)", "mobile startup");
  await mobile.until("Boolean(navigator.serviceWorker.controller)", "worker v10 control");
  const migration = await mobile.evaluate(`(async () => {
    const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase();
    try { return { preservedIdentity: (await db.getSetting('identity')).anonymousDeviceId === ${JSON.stringify(originalId)}, preservedReport: (await db.list()).some(item => item.envelope.report.shortMessage === 'SIMULACRO anterior a migración'), missingIsUndefined: (await db.getSetting('missing')) === undefined }; }
    finally { db.close(); }
  })()`);
  assert.deepEqual(migration, { preservedIdentity: true, preservedReport: true, missingIsUndefined: true });
  // A second loopback origin exercises the existing v2 inbox/receipt migration independently.
  const legacyV2 = await connect(debugOrigin, `http://localhost:${port}/health`);
  await legacyV2.until("location.pathname === '/health' && document.readyState === 'complete'", "v2 migration origin");
  await legacyV2.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('emergency-mesh-client', 2);
    request.onupgradeneeded = () => { for (const [name, keyPath] of [['outbox','eventId'],['settings','key'],['inbox','commandId'],['receipts','eventId']]) request.result.createObjectStore(name, { keyPath }); };
    request.onerror = () => reject(request.error); request.onsuccess = () => {
      const db = request.result; const tx = db.transaction(['inbox','receipts'], 'readwrite');
      tx.objectStore('inbox').put({ commandId: 'v2-sentinel-command', deviceId: 'v2-sentinel', retained: true });
      tx.objectStore('receipts').put({ eventId: 'v2-sentinel-receipt', retained: true });
      tx.oncomplete = () => { db.close(); resolve(true); }; tx.onerror = () => { db.close(); reject(tx.error); };
    };
  })`);
  const migrationV2 = await legacyV2.evaluate(`(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try { return { preservedCommand: (await db.getCommand('v2-sentinel-command')).retained, preservedReceipt: (await db.listReceipts())[0].retained, emptyNotices: (await db.listNotices()).length === 0, version: (await indexedDB.databases()).find(row => row.name === 'emergency-mesh-client').version }; } finally { db.close(); } })()`);
  assert.deepEqual(migrationV2, { preservedCommand: true, preservedReceipt: true, emptyNotices: true, version: 3 });
  const casIssuer = createDeviceIdentity(); const casTime = Date.now();
  const casCommand = createCheckinCommand(casIssuer, authorityFor(casIssuer, ["cas-zone"]), { commandId: "cas-command", zoneId: "cas-zone", incidentRef: "storage-test", nonce: "cas-nonce", issuedAt: casTime, promptUntil: casTime + 60_000, responseUntil: casTime + 120_000 });
  const indexedDbConcurrency = await legacyV2.evaluate(`(async () => {
    const { openClientDatabase } = await import('/mobile/idb.js'); const { createBrowserIdentity } = await import('/mobile/crypto.js');
    const { createCheckinResponse, createCheckinUpdate, createCheckinNeeds, createCheckinReceipt } = await import('/mobile/commands.js');
    const a = await openClientDatabase(); const b = await openClientDatabase();
    try {
      const identity = await createBrowserIdentity(); const id = identity.anonymousDeviceId; const command = ${JSON.stringify(casCommand)}; const now = ${casTime};
      await a.setSetting('identity', identity); await a.saveEnrollment({ deviceId: id, token: 'cas-test-token' });
      const receipt = await createCheckinReceipt(command, 'RECEIVED', identity, now);
      await a.receiveCommand({ commandId: command.eventId, deviceId: id, report: command, receivedAt: now }, { eventId: receipt.eventId, report: receipt });
      const first = await createCheckinResponse(command, 'NEEDS_HELP', identity, now);
      await a.queueCommandResponse(command.eventId, id, first, null, 'cas-test-token');
      const updates = await Promise.all([createCheckinUpdate(command, 'NEEDS_HELP', identity, first.envelope.report, now + 1), createCheckinUpdate(command, 'NEEDS_HELP', identity, first.envelope.report, now + 1)]);
      const states = await Promise.all([a.queueCommandResponse(command.eventId, id, updates[0], first.eventId, 'cas-test-token'), b.queueCommandResponse(command.eventId, id, updates[1], first.eventId, 'cas-test-token')]);
      const current = await a.getCommand(command.eventId);
      const details = await Promise.all([createCheckinNeeds(command, current.responseReport, { categories: ['WATER'] }, identity, null, now + 2), createCheckinNeeds(command, current.responseReport, { categories: ['FOOD'] }, identity, null, now + 2)]);
      const needs = await Promise.all([a.queueCommandNeeds(command.eventId, id, details[0], current.responseEventId, null, 'cas-test-token'), b.queueCommandNeeds(command.eventId, id, details[1], current.responseEventId, null, 'cas-test-token')]);
      const final = await a.getCommand(command.eventId);
      return { stateWinners: states.filter(Boolean).length, needsWinners: needs.filter(Boolean).length, states: final.responseHistory.length, needs: final.needsHistory.length, outbox: (await a.list()).length, firstPreserved: (await a.get(first.eventId)).envelope.report.signature.value === first.envelope.report.signature.value };
    } finally { a.close(); b.close(); }
  })()`);
  assert.deepEqual(indexedDbConcurrency, { stateWinners: 1, needsWinners: 1, states: 2, needs: 1, outbox: 3, firstPreserved: true });
  await mobile.send("Page.bringToFront");
  await mobile.evaluate(`(() => {
    document.querySelector('#pilot-setup').open = true;
    const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(JSON.stringify(material.mobileTrust))}], 'mobile-trust.json', { type: 'application/json' }));
    document.querySelector('#pilot-trust-file').files = transfer.files;
    document.querySelector('#pilot-fingerprint').value = ${JSON.stringify(material.mobileTrust.fingerprint)};
    document.querySelector('#pilot-zone').value = 'refugio-ficticio';
    document.querySelector('#pilot-code').value = ${JSON.stringify(material.enrollmentCode)};
    document.querySelector('#pilot-consent').checked = true;
    document.querySelector('#pilot-enrollment-form').requestSubmit();
  })()`);
  await mobile.until("document.querySelector('#pilot-status').textContent.includes('refugio-ficticio')", "enrollment");
  const operator = await connect(debugOrigin, origin + "/command-center/");
  await operator.until("document.querySelector('#login-panel')?.hidden === false", "operator login screen");
  assert.equal(await operator.evaluate("document.querySelector('#workspace').hidden && !document.querySelector('#requests').textContent"), true);
  const loginOperator = async () => {
    await operator.evaluate(`(() => { document.querySelector('#password').value = ${JSON.stringify(material.operatorPassword)}; document.querySelector('#login-form').requestSubmit(); })()`);
    await operator.until("document.querySelector('#workspace')?.hidden === false && document.querySelector('#zone').options.length === 1 && !document.querySelector('#refresh').disabled && !document.querySelector('#login').disabled", "operator session and initial refresh complete");
  };
  await loginOperator();
  // Hold a real GET while checking that visible command buttons cannot silently drop clicks.
  await operator.evaluate(`(() => {
    window.operatorOriginalFetch = window.fetch;
    const held = new Promise(resolve => { window.releaseOperatorRead = resolve; });
    window.fetch = async (...args) => { if (args[0] === '/api/operator/checkins' && args[1]?.method === 'GET') await held; return window.operatorOriginalFetch(...args); };
    document.querySelector('#refresh').click();
  })()`);
  await operator.until("document.querySelector('#refresh').disabled && document.querySelector('#create').disabled && document.querySelector('#notice-create').disabled", "command controls disabled during polling");
  await operator.evaluate("window.releaseOperatorRead(); window.fetch = window.operatorOriginalFetch; true");
  await operator.until("!document.querySelector('#refresh').disabled && !document.querySelector('#create').disabled && !document.querySelector('#notice-create').disabled", "command controls restored after polling");
  await operator.evaluate(`(() => {
    document.querySelector('#notice-title').value = 'SIMULACRO: revisión de enlace';
    document.querySelector('#notice-message').value = 'SIMULACRO: texto <b>sin HTML</b> para la prueba de conectividad.';
    document.querySelector('#notice-consent').checked = true;
    document.querySelector('#notice-form').requestSubmit();
  })()`);
  await operator.until("document.querySelector('#notices [data-notice-id]') && !document.querySelector('#notice-create').disabled", "notice issued through operator form");
  const noticeId = await operator.evaluate("document.querySelector('#notices [data-notice-id]').dataset.noticeId");
  await operator.evaluate("document.querySelector('#drill-consent').checked = true; document.querySelector('#checkin-form').requestSubmit()");
  await operator.until("document.querySelector('#requests [data-command-id]') && !document.querySelector('#create').disabled", "issued check-in");
  const commandId = await operator.evaluate("document.querySelector('#requests [data-command-id]').dataset.commandId");
  assert.equal(await operator.evaluate("document.querySelector('#password').value === '' && !document.cookie.includes('coluvi_operator')"), true);
  await mobile.send("Page.bringToFront");
  await mobile.until("document.querySelector('#pilot-refresh').disabled === false", "foreground inbox ready for explicit refresh");
  await mobile.evaluate("document.querySelector('#pilot-refresh').click()");
  await mobile.until("document.querySelector('[data-checkin-status=NEEDS_HELP]') !== null", "verified prompt");
  await mobile.evaluate("document.querySelector('.checkin-item').scrollIntoView()");
  await mobile.until(`(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try { return (await db.listCommands()).some(row => row.shownAt !== undefined); } finally { db.close(); } })()`, "shown evidence");
  await mobile.until("Boolean(document.querySelector('.notice-item'))", "verified notice presentation");
  await mobile.evaluate("document.querySelector('.notice-item').scrollIntoView()");
  await mobile.until(`(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try { return (await db.listNotices()).some(row => row.shownAt !== undefined); } finally { db.close(); } })()`, "notice shown evidence");
  assert.equal(await mobile.evaluate("document.querySelector('.notice-item').textContent.includes('Equipo del simulacro') && document.querySelector('.notice-item').textContent.includes('Caduca:') && document.querySelector('.notice-message').textContent.includes('<b>sin HTML</b>') && !document.querySelector('.notice-message b')"), true);
  const setOffline = async (offline) => {
    const conditions = { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: offline ? "none" : "wifi" };
    await mobile.send("Network.emulateNetworkConditions", conditions); await mobile.send("Network.overrideNetworkState", conditions);
  };
  await stop(server); server = undefined; await setOffline(true);
  assert.equal(await map.evaluate("caches.open('coluvi-public-map-v1').then(cache => cache.match('/map/')).then(Boolean)"), true, "Map shell must remain cached alongside mobile shell");
  await map.send("Page.bringToFront");
  await mapOffline(true); await reloadDocument(map, "offline map reload");
  try {
    await map.until("document.querySelector('#status')?.textContent.includes('Sin actualización del servidor. Vista anterior') && document.querySelectorAll('#areas .area').length === 1", "same outage preserves dated map snapshot");
  } catch (error) {
    const state = await map.evaluate("({ url: location.href, ready: document.readyState, hidden: document.hidden, status: document.querySelector('#status')?.textContent, areas: document.querySelectorAll('#areas .area').length })");
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  assert.deepEqual(await map.evaluate(mapSnapshot), initialPublicAreas);
  await mobile.send("Page.bringToFront");
  await reloadDocument(mobile, "offline mobile reload");
  await mobile.until("Boolean(document.querySelector('[data-checkin-status=NEEDS_HELP]'))", "offline saved prompt");
  await mobile.until("document.querySelector('.notice-item')?.dataset.expired === 'false'", "saved notice survives offline reload");
  await mobile.evaluate("window.savedPromptNode = document.querySelector('.checkin-item'); document.querySelector('#pilot-refresh').click()");
  await wait(300);
  assert.equal(await mobile.evaluate("window.savedPromptNode === document.querySelector('.checkin-item')"), true);
  await mobile.evaluate("Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline')); document.querySelector('[data-checkin-status=NEEDS_HELP]').click()");
  const responseState = `(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try { const rows = (await db.list()).filter(item => item.envelope.report.eventType === 'x-coluvi-checkin-response'); return { count: rows.length, state: rows[0]?.state, evidence: rows[0]?.evidence?.at(-1)?.level }; } finally { db.close(); } })()`;
  await mobile.until(`(${responseState}).then(value => value.count === 1 && value.state === 'QUEUED')`, "offline persisted response");
  await mobile.until("Boolean(document.querySelector('[data-needs-form]'))", "optional enrichment after minimal custody");
  await mobile.evaluate("document.querySelector('.checkin-needs').open = true; const form = document.querySelector('[data-needs-form]'); form.querySelector('[value=WATER]').checked = true; form.querySelector('[value=TRANSPORT]').checked = true; form.elements.people.value = '3'; form.requestSubmit(); true");
  const needsState = `(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try { const record = (await db.listCommands())[0]; const item = record.needsEventId ? await db.get(record.needsEventId) : undefined; return { count: record.needsHistory?.length, state: item?.state, categories: item?.envelope.report.extensions.coluvi.categories }; } finally { db.close(); } })()`;
  await mobile.until(`(${needsState}).then(value => value.count === 1 && value.state === 'QUEUED')`, "independent offline needs custody");
  assert.equal((await mobile.evaluate(responseState)).state, "QUEUED");
  // Close the actual client window, then open a new offline one with the same profile.
  await fetch(`${debugOrigin}/json/close/${mobile.targetId}`);
  mobile.socket.close();
  mobile = await connect(debugOrigin, "about:blank");
  await setOffline(true);
  await mobile.send("Page.navigate", { url: origin + "/mobile/" });
  await mobile.until("Boolean(document.querySelector('[data-needs-form]')) && Boolean(document.querySelector('[data-checkin-status=SAFE]')) && !document.querySelector('[data-checkin-status=NEEDS_HELP]')", "reopened answered prompt with update option");
  await mobile.until("Boolean(document.querySelector('.notice-item'))", "notice survives closing and reopening the window");
  const queued = await mobile.evaluate(responseState); assert.equal(queued.count, 1); assert.equal(queued.state, "QUEUED");
  assert.deepEqual((await mobile.evaluate(needsState)).categories, ["WATER", "TRANSPORT"]);
  await startServer(); await setOffline(false);
  await mobile.evaluate("Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); document.querySelector('#sync').click()");
  await mobile.until(`(${responseState}).then(value => value.count === 1 && value.state === 'SYNCED')`, "correlated backend custody");
  assert.equal((await mobile.evaluate(responseState)).evidence, "BACKEND");
  await mobile.until(`(${needsState}).then(value => value.state === 'SYNCED')`, "needs backend custody");
  await mobile.evaluate("document.querySelector('#pilot-refresh').click()");
  await mobile.until(`(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try { return (await db.listReceipts()).length === 4 && (await db.listReceipts()).every(row => row.state === 'SYNCED'); } finally { db.close(); } })()`, "check-in and notice receipt recovery");
  await operator.send("Page.bringToFront");
  await operator.evaluate("document.querySelector('#refresh').click()");
  await operator.until("document.querySelector('#login-panel').hidden === false", "restart invalidates operator session");
  await loginOperator();
  await operator.until("Boolean(document.querySelector('[data-detail]'))", "restored command list");
  await operator.evaluate("document.querySelector('[data-detail]').click()");
  await operator.until("document.querySelector('#detail-panel').hidden === false && document.querySelector('#recipients').textContent.includes('Necesito ayuda')", "private response detail");
  const privateEvidence = await operator.evaluate(`(async () => { const response = await fetch('/api/operator/checkins/${commandId}?limit=10', { cache: 'no-store' }); const detail = await response.json(); return { counts: detail.counts, histories: detail.recipients.map(row => row.history.length) }; })()`);
  assert.equal(privateEvidence.counts.requested, 1); assert.equal(privateEvidence.counts.received, 1); assert.equal(privateEvidence.counts.shown, 1);
  assert.equal(privateEvidence.counts.responded, 1); assert.equal(privateEvidence.counts.needsHelp, 1); assert.deepEqual(privateEvidence.histories, [1]);
  const needsEvidence = await operator.evaluate(`fetch('/api/operator/checkins/${commandId}?limit=10', { cache: 'no-store' }).then(response => response.json()).then(detail => ({ counts: detail.needsCounts, current: detail.recipients[0].needs, history: detail.recipients[0].needsHistory.length }))`);
  assert.equal(needsEvidence.counts.WATER, 1); assert.equal(needsEvidence.counts.TRANSPORT, 1); assert.equal(needsEvidence.current.peopleAffected, 3); assert.equal(needsEvidence.history, 1);
  assert.equal(await operator.evaluate("document.querySelector('[data-current-needs]').textContent.includes('Transporte')"), true);
  const noticeEvidence = await operator.evaluate(`fetch('/api/operator/notices/${noticeId}?limit=10', { cache: 'no-store' }).then(response => response.json()).then(detail => detail.counts)`);
  assert.deepEqual(noticeEvidence, { requested: 1, received: 1, shown: 1 });
  // Check the populated private UI, not merely the login page.
  await operator.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  assert.equal(await operator.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await operator.send("Accessibility.enable");
  const tree = await operator.send("Accessibility.getFullAXTree");
  const interactive = new Set(["button", "checkbox", "combobox", "link", "textbox"]);
  assert.equal(tree.nodes.filter(node => !node.ignored && interactive.has(node.role?.value) && !node.name?.value?.trim()).length, 0);
  await mobile.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  assert.equal(await mobile.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await mobile.send("Page.bringToFront"); await setOffline(true);
  await mobile.evaluate("Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }); document.querySelector('[data-checkin-status=SAFE]').click()");
  await mobile.until(`(${responseState}).then(value => value.count === 2 && value.state === 'QUEUED')`, "offline status update preserves initial response");
  await reloadDocument(mobile, "offline updated mobile reload");
  await mobile.until("Boolean(document.querySelector('[data-checkin-status=NEEDS_HELP]')) && !document.querySelector('[data-checkin-status=SAFE]')", "updated safe state survives offline reload");
  await setOffline(false);
  await mobile.evaluate("Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); document.querySelector('#sync').click()");
  await mobile.until(`(${responseState}).then(value => value.count === 2 && value.state === 'SYNCED')`, "updated safe state reaches backend");
  const updateEvidence = await operator.evaluate(`fetch('/api/operator/checkins/${commandId}?limit=10', { cache: 'no-store' }).then(response => response.json()).then(detail => ({ counts: detail.counts, needs: detail.recipients[0].needs, needsCounts: detail.needsCounts, history: detail.recipients[0].history.length, needsHistory: detail.recipients[0].needsHistory.length, link: detail.recipients[0].history.at(-1).link }))`);
  assert.equal(updateEvidence.counts.requested, 1); assert.equal(updateEvidence.counts.responded, 1); assert.equal(updateEvidence.counts.safe, 1); assert.equal(updateEvidence.counts.needsHelp, 0);
  assert.equal(updateEvidence.needs, null); assert.equal(updateEvidence.needsCounts.WATER, 0); assert.equal(updateEvidence.history, 2); assert.equal(updateEvidence.needsHistory, 1); assert.equal(updateEvidence.link, "LINKED");
  await map.send("Page.bringToFront"); await mapOffline(false); await reloadDocument(map, "reconnected map reload");
  await map.until("document.querySelector('#status')?.textContent.startsWith('Vista consultada:') && document.querySelector('#saved-status')?.textContent.includes('Vista pública guardada') && document.querySelectorAll('#areas .area').length === 1", "map reconnects after private resolution");
  assert.deepEqual(await map.evaluate(mapSnapshot), initialPublicAreas);
  const integratedMapEvidence = { sameBackendAndOrigin: true, ordinaryPublicReports: 6, publicGroups: 1,
    offlineSnapshotDuringPrivateResponse: true, privateUpdatesDoNotChangePublicCounts: true, reloadsRequireNewDocument: true, commandControlsBlockedDuringPolling: true };
  // Resend the exact signed packet: duplicate does not grow history.
  await mobile.evaluate(`(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const { canonicalCbor } = await import('/mobile/crypto.js'); const db = await openClientDatabase(); try { const item = (await db.list()).find(row => row.envelope.report.eventType === 'x-coluvi-checkin-response'); const response = await fetch('/api/packets', { method: 'POST', body: canonicalCbor(item.envelope) }); const result = await response.json(); if (result.status !== 'DUPLICATE') throw new Error('Duplicate not preserved'); } finally { db.close(); } })()`);
  const cacheSafe = await mobile.evaluate(`(async () => { for (const name of await caches.keys()) { for (const request of await (await caches.open(name)).keys()) { const url = new URL(request.url); if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/command-center/')) return false; } } return true; })()`);
  assert.equal(cacheSafe, true);
  const finalPublicAreas = await operator.evaluate("fetch('/api/areas', { cache: 'no-store' }).then(response => response.json()).then(data => data.areas)");
  assert.deepEqual(finalPublicAreas, initialPublicAreas); const publicPrivacy = true;
  await operator.send("Page.bringToFront");
  await operator.until("!document.querySelector('#refresh').disabled && Boolean(document.querySelector('[data-revoke]'))", "participant administration ready");
  await operator.evaluate("document.querySelector('[data-revoke]').click()");
  await operator.until("document.querySelector('#revoke-dialog').open", "explicit revoke confirmation");
  assert.equal(await operator.evaluate("document.querySelector('#revoke-target').textContent.includes(document.querySelector('[data-participant-id]').dataset.participantId) && !document.querySelector('#revoke-consent').checked"), true);
  assert.equal(await operator.evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('#revoke-dialog').getBoundingClientRect().width <= innerWidth"), true);
  await operator.evaluate("document.querySelector('#revoke-cancel').click()");
  await operator.until("!document.querySelector('#revoke-dialog').open", "revocation can be canceled");
  assert.equal(await operator.evaluate("fetch('/api/operator/participants').then(response => response.json()).then(data => data.counts.active === 1)"), true);
  await operator.evaluate("document.querySelector('[data-revoke]').click(); document.querySelector('#revoke-consent').checked = true; document.querySelector('#revoke-form').requestSubmit()");
  await operator.until("!document.querySelector('#revoke-dialog').open && document.querySelector('#participants').textContent.includes('Revocado') && !document.querySelector('[data-revoke]')", "participant revoked through UI");
  const revocationEvidence = await mobile.evaluate(`(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const { canonicalCbor } = await import('/mobile/crypto.js'); const db = await openClientDatabase(); try { const enrollment = await db.getSetting('coluviEnrollment'); const inbox = await fetch('/api/mobile/inbox', { headers: { authorization: 'Bearer ' + enrollment.token } }); const item = (await db.list()).find(row => row.envelope.report.eventType === 'x-coluvi-checkin-response'); const ingest = await fetch('/api/packets', { method: 'POST', body: canonicalCbor(item.envelope) }); return { inboxStatus: inbox.status, packetStatus: ingest.status, noFalseEvidence: !(await ingest.json()).evidence }; } finally { db.close(); } })()`);
  assert.deepEqual(revocationEvidence, { inboxStatus: 401, packetStatus: 400, noFalseEvidence: true });
  const retained = await operator.evaluate(`fetch('/api/operator/checkins/${commandId}?limit=10').then(response => response.json()).then(detail => ({ requested: detail.counts.requested, history: detail.recipients[0].history.length }))`);
  assert.deepEqual(retained, { requested: 1, history: 2 });
  await operator.evaluate("document.querySelector('#logout').click()");
  await operator.until("document.querySelector('#workspace').hidden && document.querySelector('#requests').children.length === 0 && document.querySelector('#notices').children.length === 0 && document.querySelector('#notice-message').value === '' && document.querySelector('#participants').children.length === 0 && document.querySelector('#revoke-target').textContent === ''", "logout clears private view and drafts");
  await wait(200);
  const loggedOut = await operator.evaluate("fetch('/api/operator/session', { cache: 'no-store' }).then(response => response.status === 401)");
  assert.equal(loggedOut, true);
  await mobile.send("Page.bringToFront");
  await mobile.until("document.querySelector('#pilot-refresh').disabled === false", "mobile foreground polling ready");
  await mobile.evaluate(`(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try { window.actualNow = Date.now; const expiresAt = (await db.listNotices())[0].report.validUntil; Date.now = () => expiresAt + 1; Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }); } finally { db.close(); } document.querySelector('#pilot-refresh').click(); })()`);
  await mobile.until("document.querySelector('.notice-item')?.dataset.expired === 'true' && document.querySelector('.notice-item').textContent.includes('CADUCADO')", "expired historical notice clearly labeled");
  await mobile.evaluate("Date.now = window.actualNow; Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true }); true");
  const diagnostics = connections.flatMap(connection => connection.diagnostics); assert.deepEqual(diagnostics, []);
  const legacyPort = await freePort();
  const legacy = await regression("examples/browser-smoke.mjs", [String(new URL(debugOrigin).port), `http://127.0.0.1:${legacyPort}/mobile/`, "127.0.0.1", "--managed-server"]);
  assert.equal(legacy.queuedMarker.state, "QUEUED"); assert.equal(legacy.syncedMarker.state, "SYNCED");
  const accessibility = await regression("examples/accessibility-smoke.mjs", [String(new URL(debugOrigin).port), origin + "/mobile/", "127.0.0.1"]);
  assert.equal(accessibility.success, true);
  console.log(JSON.stringify({ scenario: "SIMULACRO ficticio · Chromium loopback, no Android ni mesh físico", integratedMapEvidence, migration, migrationV2, indexedDbConcurrency, enrolledThroughUi: true, issuedThroughUi: true, noticeIssuedThroughUi: true, noticeEvidence, needsEvidence, updateEvidence, revocationEvidence, revocationPreservedHistory: retained, noticeSurvivedOfflineReopen: true, noticeTextNotHtml: true, expiredNoticeLabeled: true, backendStoppedWhileOffline: true, repeatedPollPreservesPromptDom: true, offlineQueued: queued.state, survivedWindowCloseAndReopen: true, reconnectedState: (await mobile.evaluate(responseState)).state, backendEvidence: "BACKEND", privateEvidence, duplicatePreserved: true, cacheSafe, publicPrivacy, logoutCleared: true, constrained360px: true, unnamedOperatorControls: 0, legacyOfflineRegression: true, mobileAccessibilityRegression: accessibility.success, diagnostics }, null, 2));
} finally {
  for (const connection of connections) connection.socket.close();
  await stop(browser); await stop(server);
  rmSync(directory, { recursive: true, force: true });
}
