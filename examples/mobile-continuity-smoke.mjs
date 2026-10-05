import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mobileAsset } from "../src/mobile-client/assets.ts";
import { connect, freePort, ready, stop, reloadDocument } from "./browser-fixture.mjs";

const executable = process.env.COLUVI_CHROMIUM_PATH;
if (!executable) throw new Error("Set COLUVI_CHROMIUM_PATH to an installed Chromium");
if (process.env.WSL_DISTRO_NAME !== "Ubuntu") throw new Error("Use Ubuntu WSL");
const repository = fileURLToPath(new URL("../", import.meta.url));
const baseline = "coluvi-simulacro-20261004-rc1";
const git = args => execFileSync("git", args, { cwd: repository, maxBuffer: 2 * 1024 * 1024 });
const baselineCommit = git(["rev-parse", `${baseline}^{commit}`]).toString().trim();
const oldFiles = new Map(git(["ls-tree", "--name-only", baseline, "src/mobile-client/"]).toString().trim().split("\n").map(path => [
  "/mobile/" + (path.endsWith("/index.html") ? "" : path.split("/").at(-1)), git(["show", `${baseline}:${path}`]),
]));
const directory = mkdtempSync("/tmp/coluvi-client-continuity-"); const connections = [];
let server; let browser; let proxy; let client; let serveBaseline = true; let allowPackets = false; let packetRequests = 0;
async function stopBrowser(signal = "SIGTERM") {
  if (!browser) return;
  const stopping = stop(browser, signal);
  try { process.kill(-browser.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await stopping;
}
const sourceWitness = `(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try {
  return (await db.list()).map(item => ({ eventId: item.eventId, envelope: item.envelope })).sort((a,b) => a.eventId.localeCompare(b.eventId));
} finally { db.close(); } })()`;
const states = `(async () => { const { openClientDatabase } = await import('/mobile/idb.js'); const db = await openClientDatabase(); try { return (await db.list()).map(item => item.state); } finally { db.close(); } })()`;
const workerVersion = `new Promise((resolve,reject) => { const channel = new MessageChannel(); const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Worker timeout')); }, 3000);
  channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data.cache); }; navigator.serviceWorker.controller.postMessage({type:'COLUVI_CACHE_VERSION'}, [channel.port2]); })`;
try {
  const backendPort = await freePort(); const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  const databasePath = join(directory, "server.sqlite");
  server = spawn(process.execPath, ["src/server.ts"], { cwd: repository, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, PORT: String(backendPort), EMERGENCY_MESH_HOST: "127.0.0.1", EMERGENCY_MESH_DATABASE_PATH: databasePath,
    EMERGENCY_MESH_COLUVI_CONFIG_PATH: "", EMERGENCY_MESH_TLS_CERT_PATH: "", EMERGENCY_MESH_TLS_KEY_PATH: "", EMERGENCY_MESH_ENABLE_DEBUG_EVENTS: "0",
  } });
  server.stderr.resume(); await ready(server, server.stdout, text => text.includes("Emergency Map:"));
  const startProxy = async () => {
    proxy = createServer((request, response) => {
      if (serveBaseline && oldFiles.has(request.url)) {
        response.writeHead(200, { "content-type": mobileAsset(request.url)?.contentType ?? "text/javascript", "cache-control": "no-cache" });
        response.end(oldFiles.get(request.url)); return;
      }
      if (request.url === "/api/packets") {
        packetRequests++;
        if (!allowPackets) { request.resume(); response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"SIMULATED_UNAVAILABLE"}'); return; }
      }
      const upstream = httpRequest({ hostname: "127.0.0.1", port: backendPort, path: request.url, method: request.method, headers: request.headers }, result => {
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.on("aborted", () => upstream.destroy()); request.pipe(upstream);
    });
    await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(port, "127.0.0.1", resolve); });
  };
  const stopProxy = async () => { if (!proxy) return; proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); proxy = undefined; };
  const startBrowser = async () => {
    browser = spawn(executable, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`, "about:blank"], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    const websocket = await ready(browser, browser.stderr, text => text.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]);
    client = await connect(`http://${new URL(websocket).host}`, "about:blank"); connections.push(client);
    // Explicit manual-send actor prevents background work from racing injected failures.
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(Navigator.prototype, 'onLine', { configurable:true, get:()=>false });
      if (typeof ServiceWorkerRegistration !== 'undefined') Object.defineProperty(ServiceWorkerRegistration.prototype, 'sync', { configurable:true, get:()=>undefined });` });
    await client.send("Page.navigate", { url: origin + "/mobile/" });
    await client.until("Boolean(document.querySelector('#identity-status')?.textContent)", "client started");
    await client.evaluate("document.querySelector('#language').value = 'es'; document.querySelector('#language').dispatchEvent(new Event('change')); true");
    await client.until("document.documentElement.lang === 'es'", "Spanish UI ready");
    await client.until("Boolean(navigator.serviceWorker.controller)", "worker controls client");
  };
  const createReport = async text => {
    await client.evaluate(`document.querySelector('[data-action=SAFE]').click(); document.querySelector('#short-message').value = ${JSON.stringify(text)}; document.querySelector('#report-form').requestSubmit(); true`);
  };
  await startProxy(); await startBrowser();
  assert.equal(await client.evaluate(workerVersion), "emergency-mesh-mobile-v10");
  await createReport("SIMULACRO pendiente antes de actualizar");
  await client.until(`(${states}).then(rows => rows.length === 1 && rows[0] === 'QUEUED')`, "RC1 packet persisted");
  const before = await client.evaluate(sourceWitness);
  await stopProxy();
  await stopBrowser("SIGKILL"); browser = undefined; // Actual browser process group, not just a tab.
  await startBrowser();
  assert.deepEqual(await client.evaluate(sourceWitness), before);
  assert.deepEqual(await client.evaluate(states), ["QUEUED"]);
  assert.equal(await client.evaluate(workerVersion), "emergency-mesh-mobile-v10");
  serveBaseline = false; await startProxy();
  await client.evaluate("navigator.serviceWorker.getRegistration('/mobile/').then(registration => registration.update())");
  await client.until(`(${workerVersion}).then(version => version === 'emergency-mesh-mobile-v11')`, "current worker activated");
  await reloadDocument(client, "upgraded client document");
  await client.until("Boolean(document.querySelector('#diagnostics-panel')) && Boolean(document.querySelector('#identity-status')?.textContent)", "new application assets active");
  assert.deepEqual(await client.evaluate(sourceWitness), before);
  assert.deepEqual(await client.evaluate(states), ["QUEUED"]);
  const faultEvidence = [];
  for (const mode of ["QUOTA", "ABORT"]) {
    await client.evaluate(`window.originalPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(...args) {
      if (this.name === 'outbox') { ${mode === "QUOTA" ? "throw new DOMException('Injected quota failure', 'QuotaExceededError');" : "const result = window.originalPut.apply(this,args); this.transaction.abort(); return result;"} }
      return window.originalPut.apply(this,args);
    }; true`);
    await createReport(`SIMULACRO fallo ${mode}`);
    await client.until("document.querySelector('#form-error').textContent.length > 0 && !document.querySelector('#report-form [type=submit]').disabled", "failed save is visible and retry enabled");
    assert.equal(await client.evaluate("document.querySelector('#composer').classList.contains('hidden')"), false);
    assert.equal(await client.evaluate("document.querySelector('#short-message').value"), `SIMULACRO fallo ${mode}`);
    await client.evaluate("IDBObjectStore.prototype.put = window.originalPut; true");
    assert.deepEqual(await client.evaluate(sourceWitness), before);
    faultEvidence.push({ mode, originalPreserved: true, noFalseSavedReport: true, draftPreserved: true });
  }
  await client.evaluate(`window.originalGetAll = IDBObjectStore.prototype.getAll; IDBObjectStore.prototype.getAll = function(...args) {
    if (this.name === 'outbox') { IDBObjectStore.prototype.getAll = window.originalGetAll; throw new DOMException('Injected post-save read failure', 'UnknownError'); }
    return window.originalGetAll.apply(this,args);
  }; true`);
  await createReport("SIMULACRO guardado con fallo de vista");
  await client.until("document.querySelector('#client-problem').textContent.startsWith('El guardado local terminó')", "post-commit failure does not claim missing custody");
  assert.equal((await client.evaluate(sourceWitness)).length, 2);
  const allSaved = await client.evaluate(sourceWitness);
  allowPackets = true;
  await client.evaluate(`window.originalPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(...args) {
    if (this.name === 'outbox' && args[0]?.state === 'SYNCED') { IDBObjectStore.prototype.put = window.originalPut; throw new DOMException('Injected ACK write failure', 'QuotaExceededError'); }
    return window.originalPut.apply(this,args);
  }; document.querySelector('#sync').click(); true`);
  await client.until("document.querySelector('#client-problem').textContent.startsWith('No se pudo actualizar') && !document.querySelector('#sync').disabled", "ACK persistence failure surfaced");
  assert.ok((await client.evaluate(states)).includes("FORWARDED"));
  assert.deepEqual(await client.evaluate(sourceWitness), allSaved);
  await client.evaluate("document.querySelector('#sync').click(); true");
  await client.until(`(${states}).then(rows => rows.length === 2 && rows.every(state => state === 'SYNCED'))`, "duplicate replay repairs local confirmation");
  await client.until("document.querySelector('#client-problem').textContent === '' && !document.querySelector('#sync').disabled", "recovered storage clears obsolete warning");
  assert.deepEqual(await client.evaluate(sourceWitness), allSaved);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reports").get().n, 2); assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); } finally { db.close(); }
  assert.ok(packetRequests >= 3);
  assert.deepEqual(connections.flatMap(connection => connection.diagnostics), []);
  if (process.env.COLUVI_CONTINUITY_SCREENSHOT) {
    await client.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
    await client.evaluate("document.querySelector('#diagnostics-panel').open = true; document.querySelector('#diagnostics-panel').scrollIntoView(); true");
    await client.until("document.querySelectorAll('#diagnostics-values dt').length === 16", "diagnostic screenshot ready");
    const shot = await client.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.COLUVI_CONTINUITY_SCREENSHOT, Buffer.from(shot.data, "base64"), { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ version: 1, status: "PASS", baselineCommit, baselineTag: baseline, evidence: "CHROMIUM_LOOPBACK_REAL_INDEXEDDB",
    browserKilledWithSIGKILL: true, reopenedWithoutServer: true, signedPacketUnchangedAfterCrash: true, workerUpgrade: "v10 to v11", actualRC1AssetsUsed: true,
    pendingPacketUnchangedAfterUpgrade: true, faultEvidence, postCommitReadFailureDistinguished: true, failedLocalAckRetriedAsDuplicate: true,
    backendUniqueReports: 2, packetRequests, diagnostics: [], limitations: ["Injected browser API failures, not a physical full disk", "Browser SIGKILL, not OS or power failure", "Manual synchronization actor disables browser background sync", "No Android or radio evidence"] }, null, 2));
  await stopProxy();
} finally {
  for (const connection of connections) connection.socket.close();
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  await stopBrowser(); await stop(server); rmSync(directory, { recursive: true, force: true });
}
