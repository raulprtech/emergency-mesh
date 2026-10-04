import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeviceIdentity } from "../src/protocol/identity.ts";
import { createColuviConfiguration } from "../src/commands/config.ts";

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
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") diagnostics.push(message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) diagnostics.push(message.params.type);
  });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
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
  const material = await createColuviConfiguration(createDeviceIdentity(), origin, ["refugio-ficticio"]);
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
  browser = spawn(executable, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const debuggerUrl = await ready(browser, browser.stderr, (text) => text.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]);
  const debugOrigin = `http://${new URL(debuggerUrl).host}`;
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
  await mobile.until("Boolean(navigator.serviceWorker.controller)", "worker v8 control");
  const migration = await mobile.evaluate(`(async () => {
    const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase();
    try { return { preservedIdentity: (await db.getSetting('identity')).anonymousDeviceId === ${JSON.stringify(originalId)}, preservedReport: (await db.list()).some(item => item.envelope.report.shortMessage === 'SIMULACRO anterior a migración'), missingIsUndefined: (await db.getSetting('missing')) === undefined }; }
    finally { db.close(); }
  })()`);
  assert.deepEqual(migration, { preservedIdentity: true, preservedReport: true, missingIsUndefined: true });
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
    await operator.until("document.querySelector('#workspace')?.hidden === false && document.querySelector('#zone').options.length === 1", "operator session");
  };
  await loginOperator();
  await operator.evaluate("document.querySelector('#drill-consent').checked = true; document.querySelector('#checkin-form').requestSubmit()");
  await operator.until("document.querySelector('#requests [data-command-id]') && !document.querySelector('#create').disabled", "issued check-in");
  const commandId = await operator.evaluate("document.querySelector('#requests [data-command-id]').dataset.commandId");
  assert.equal(await operator.evaluate("document.querySelector('#password').value === '' && !document.cookie.includes('coluvi_operator')"), true);
  await mobile.send("Page.bringToFront");
  await mobile.evaluate("document.querySelector('#pilot-refresh').click()");
  await mobile.until("document.querySelector('[data-checkin-status=NEEDS_HELP]') !== null", "verified prompt");
  await mobile.evaluate("document.querySelector('.checkin-item').scrollIntoView()");
  await mobile.until(`(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try { return (await db.listCommands()).some(row => row.shownAt !== undefined); } finally { db.close(); } })()`, "shown evidence");
  const setOffline = async (offline) => {
    const conditions = { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: offline ? "none" : "wifi" };
    await mobile.send("Network.emulateNetworkConditions", conditions); await mobile.send("Network.overrideNetworkState", conditions);
  };
  await stop(server); server = undefined; await setOffline(true);
  await mobile.send("Page.reload", { ignoreCache: true });
  await mobile.until("Boolean(document.querySelector('[data-checkin-status=NEEDS_HELP]'))", "offline saved prompt");
  await mobile.evaluate("window.savedPromptNode = document.querySelector('.checkin-item'); document.querySelector('#pilot-refresh').click()");
  await wait(300);
  assert.equal(await mobile.evaluate("window.savedPromptNode === document.querySelector('.checkin-item')"), true);
  await mobile.evaluate("Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline')); document.querySelector('[data-checkin-status=NEEDS_HELP]').click()");
  const responseState = `(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try { const rows = (await db.list()).filter(item => item.envelope.report.eventType === 'x-coluvi-checkin-response'); return { count: rows.length, state: rows[0]?.state, evidence: rows[0]?.evidence?.at(-1)?.level }; } finally { db.close(); } })()`;
  await mobile.until(`(${responseState}).then(value => value.count === 1 && value.state === 'QUEUED')`, "offline persisted response");
  // Close the actual client window, then open a new offline one with the same profile.
  await fetch(`${debugOrigin}/json/close/${mobile.targetId}`);
  mobile.socket.close();
  mobile = await connect(debugOrigin, "about:blank");
  await setOffline(true);
  await mobile.send("Page.navigate", { url: origin + "/mobile/" });
  await mobile.until("Boolean(document.querySelector('.checkin-item')) && !document.querySelector('[data-checkin-status]')", "reopened answered prompt");
  const queued = await mobile.evaluate(responseState); assert.equal(queued.count, 1); assert.equal(queued.state, "QUEUED");
  await startServer(); await setOffline(false);
  await mobile.evaluate("Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); document.querySelector('#sync').click()");
  await mobile.until(`(${responseState}).then(value => value.count === 1 && value.state === 'SYNCED')`, "correlated backend custody");
  assert.equal((await mobile.evaluate(responseState)).evidence, "BACKEND");
  await mobile.evaluate("document.querySelector('#pilot-refresh').click()");
  await mobile.until(`(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try { return (await db.listReceipts()).length === 2 && (await db.listReceipts()).every(row => row.state === 'SYNCED'); } finally { db.close(); } })()`, "receipt recovery");
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
  // Check the populated private UI, not merely the login page.
  await operator.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  assert.equal(await operator.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await operator.send("Accessibility.enable");
  const tree = await operator.send("Accessibility.getFullAXTree");
  const interactive = new Set(["button", "checkbox", "combobox", "link", "textbox"]);
  assert.equal(tree.nodes.filter(node => !node.ignored && interactive.has(node.role?.value) && !node.name?.value?.trim()).length, 0);
  await mobile.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  assert.equal(await mobile.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  // Resend the exact signed packet: duplicate does not grow history.
  await mobile.evaluate(`(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const { canonicalCbor } = await import('/mobile/crypto.js'); const db = await openClientDatabase(); try { const item = (await db.list()).find(row => row.envelope.report.eventType === 'x-coluvi-checkin-response'); const response = await fetch('/api/packets', { method: 'POST', body: canonicalCbor(item.envelope) }); const result = await response.json(); if (result.status !== 'DUPLICATE') throw new Error('Duplicate not preserved'); } finally { db.close(); } })()`);
  const cacheSafe = await mobile.evaluate(`(async () => { for (const name of await caches.keys()) { for (const request of await (await caches.open(name)).keys()) { const url = new URL(request.url); if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/command-center/')) return false; } } return true; })()`);
  assert.equal(cacheSafe, true);
  const publicPrivacy = await operator.evaluate("fetch('/api/areas', { cache: 'no-store' }).then(response => response.json()).then(data => data.areas.length === 0)");
  assert.equal(publicPrivacy, true); // One ordinary old report is suppressed; private reply is excluded.
  await operator.evaluate("document.querySelector('#logout').click()");
  await operator.until("document.querySelector('#workspace').hidden && document.querySelector('#requests').children.length === 0", "logout clears private view");
  await wait(200);
  const loggedOut = await operator.evaluate("fetch('/api/operator/session', { cache: 'no-store' }).then(response => response.status === 401)");
  assert.equal(loggedOut, true);
  const diagnostics = connections.flatMap(connection => connection.diagnostics); assert.deepEqual(diagnostics, []);
  const legacyPort = await freePort();
  const legacy = await regression("examples/browser-smoke.mjs", [String(new URL(debugOrigin).port), `http://127.0.0.1:${legacyPort}/mobile/`, "127.0.0.1", "--managed-server"]);
  assert.equal(legacy.queuedMarker.state, "QUEUED"); assert.equal(legacy.syncedMarker.state, "SYNCED");
  const accessibility = await regression("examples/accessibility-smoke.mjs", [String(new URL(debugOrigin).port), origin + "/mobile/", "127.0.0.1"]);
  assert.equal(accessibility.success, true);
  console.log(JSON.stringify({ scenario: "SIMULACRO ficticio · Chromium loopback, no Android ni mesh físico", migration, enrolledThroughUi: true, issuedThroughUi: true, backendStoppedWhileOffline: true, repeatedPollPreservesPromptDom: true, offlineQueued: queued.state, survivedWindowCloseAndReopen: true, reconnectedState: (await mobile.evaluate(responseState)).state, backendEvidence: "BACKEND", privateEvidence, duplicatePreserved: true, cacheSafe, publicPrivacy, logoutCleared: true, constrained360px: true, unnamedOperatorControls: 0, legacyOfflineRegression: true, mobileAccessibilityRegression: accessibility.success, diagnostics }, null, 2));
} finally {
  for (const connection of connections) connection.socket.close();
  await stop(browser); await stop(server);
  rmSync(directory, { recursive: true, force: true });
}
