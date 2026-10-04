import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteBackend } from "../src/backend/sqlite-backend.ts";
import { createDeviceIdentity, signReport } from "../src/protocol/identity.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { connect, freePort, ready, stop, wait } from "./browser-fixture.mjs";

const executable = process.env.COLUVI_CHROMIUM_PATH;
if (!executable) throw new Error("Set COLUVI_CHROMIUM_PATH to an installed Chromium executable");
const directory = mkdtempSync("/tmp/coluvi-map-smoke-");
const repository = fileURLToPath(new URL("../", import.meta.url));
const databasePath = join(directory, "map.sqlite");
let server; let browser; let client;
try {
  const backend = new SqliteBackend(databasePath); const now = Date.now() - 1_000; let eventCount = 0;
  try {
    for (const [zone, count] of [["refugio-norte", 12], ["refugio-sur", 3], ["unknown-geometry", 3], ["grid", 6]]) {
      for (let index = 0; index < count; index++) {
        const identity = createDeviceIdentity(); const sos = zone === "refugio-norte" && index < 6;
        const report = signReport({ ...makeReport({ identity, createdAt: now, eventId: `map-${eventCount++}`, eventType: sos ? "SOS" : "SAFE" }),
          location: zone === "grid" ? { latitude: 21.0123, longitude: -89.6123, timestamp: now, source: "APPROXIMATE" } : { zoneId: zone, timestamp: now, source: "ZONE" },
          needs: zone === "refugio-norte" && index < 3 ? [{ category: "WATER" }] : [], shortMessage: "SIMULACRO: no publicar este texto privado",
        }, identity);
        assert.equal(backend.ingest({ packetId: report.eventId, report, expiresAt: report.validUntil, hopCount: 0, hopLimit: 12 }).status, "ACCEPTED");
      }
    }
  } finally { backend.close(); }
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["src/server.ts"], { cwd: repository, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, PORT: String(port), EMERGENCY_MESH_HOST: "127.0.0.1", EMERGENCY_MESH_DATABASE_PATH: databasePath,
    EMERGENCY_MESH_COLUVI_CONFIG_PATH: "", EMERGENCY_MESH_TLS_CERT_PATH: "", EMERGENCY_MESH_TLS_KEY_PATH: "", EMERGENCY_MESH_ENABLE_DEBUG_EVENTS: "0",
    EMERGENCY_MESH_PUBLIC_MIN_GROUP_SIZE: "3", EMERGENCY_MESH_PUBLIC_SPATIAL_DECIMALS: "1", EMERGENCY_MESH_PUBLIC_BUCKET_MINUTES: "60", EMERGENCY_MESH_PUBLIC_MAX_AGE_HOURS: "24",
  } });
  server.stderr.resume(); await ready(server, server.stdout, text => text.includes("Emergency Map:"));
  const root = await fetch(origin, { redirect: "manual" }); assert.equal(root.status, 302); assert.equal(root.headers.get("location"), "/map/");
  const shell = await fetch(origin + "/map/"); assert.match(shell.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((await fetch(origin + "/map/not-an-asset.js")).status, 404);
  assert.equal((await fetch(origin + "/api/events")).status, 404);
  browser = spawn(executable, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const debuggerUrl = await ready(browser, browser.stderr, text => text.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]);
  client = await connect(`http://${new URL(debuggerUrl).host}`, origin + "/map/");
  await client.until("document.querySelector('#areas')?.children.length === 4 && document.querySelector('#saved-status').textContent.includes('Vista pública guardada')", "four persisted public groups");
  await client.until("Boolean(navigator.serviceWorker.controller)", "map service worker control");
  assert.equal(await client.evaluate("document.querySelectorAll('#land path').length"), 177);
  assert.equal(await client.evaluate("document.querySelectorAll('#cells path').length"), 3);
  assert.equal(await client.evaluate("document.querySelectorAll('#drill-zones path').length"), 3);
  assert.equal(await client.evaluate("document.body.textContent.includes('no publicar este texto privado')"), false);
  assert.equal(await client.evaluate("document.querySelector('[data-area=\"zone:refugio-sur\"].area').textContent.includes('No publicado')"), true);
  await client.evaluate("document.querySelector('#need').value = 'WATER'; document.querySelector('#need').dispatchEvent(new Event('change'))");
  assert.equal(await client.evaluate("document.querySelectorAll('#areas .area').length"), 1);
  assert.equal(await client.evaluate("document.querySelector('#areas .area').dataset.area"), "zone:refugio-norte");
  await client.evaluate("document.querySelector('#need').value = ''; document.querySelector('#need').dispatchEvent(new Event('change')); document.querySelector('#fit').click()");
  const fitted = await client.evaluate("document.querySelector('#map').getAttribute('viewBox').split(' ').map(Number)");
  assert.ok(fitted.every(Number.isFinite)); assert.ok(fitted[2] < 100);
  await client.evaluate("document.querySelector('#zoom-in').click()");
  assert.ok(await client.evaluate(`Number(document.querySelector('#map').getAttribute('viewBox').split(' ')[2]) < ${fitted[2]}`));
  await client.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  const layout = await client.evaluate(`({ overflow: document.documentElement.scrollWidth > innerWidth, smallControls: [...document.querySelectorAll('button,select')].filter(element => !element.hidden && element.getBoundingClientRect().height < 44).length })`);
  assert.deepEqual(layout, { overflow: false, smallControls: 0 });
  const accessibility = await client.send("Accessibility.getFullAXTree");
  const unnamed = accessibility.nodes.filter(item => !item.ignored && ["button", "combobox", "link", "img"].includes(item.role?.value) && !item.name?.value?.trim());
  assert.equal(unnamed.length, 0);
  if (process.env.COLUVI_MAP_SCREENSHOT) {
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1050, deviceScaleFactor: 1, mobile: false });
    await client.evaluate("document.querySelector('#home').click()"); await wait(100);
    const screenshot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(process.env.COLUVI_MAP_SCREENSHOT, Buffer.from(screenshot.data, "base64"), { flag: "wx" });
  }
  const cachePaths = await client.evaluate(`(async () => { const output = []; for (const key of await caches.keys()) { for (const request of await (await caches.open(key)).keys()) output.push(new URL(request.url).pathname); } return output.sort(); })()`);
  assert.deepEqual(cachePaths, ["/map/", "/map/app.js", "/map/basemap.json", "/map/model.js", "/map/storage.js", "/map/styles.css", "/map/zones.json"].sort());
  const saved = await client.evaluate(`(async () => { const { openPublicMapStore } = await import('/map/storage.js'); const store = await openPublicMapStore(); try { return await store.read(); } finally { store.close(); } })()`);
  assert.equal(saved.areas.length, 4); assert.ok(!JSON.stringify(saved).includes("shortMessage")); assert.ok(!JSON.stringify(saved).includes("anonymousDeviceId"));
  await stop(server, "SIGKILL"); server = undefined;
  const conditions = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "none" };
  await client.send("Network.emulateNetworkConditions", conditions); await client.send("Network.overrideNetworkState", conditions);
  await client.send("Page.reload", { ignoreCache: true });
  await client.until("document.querySelector('#status')?.textContent.includes('Sin actualización del servidor. Vista anterior') && document.querySelectorAll('#areas .area').length === 4", "offline saved public snapshot");
  assert.equal(await client.evaluate("document.querySelectorAll('#land path').length"), 177);
  assert.equal(await client.evaluate("document.querySelectorAll('#cells path').length"), 3);
  await client.evaluate(`(async () => { const request = indexedDB.open('coluvi-public-map', 1); const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { await new Promise((resolve, reject) => { const tx = db.transaction('snapshot', 'readwrite'); const store = tx.objectStore('snapshot'); const request = store.get('last'); request.onsuccess = () => store.put({ ...request.result, privacy: { ...request.result.privacy, generatedAt: Date.now() - 25 * 60 * 60_000 } }, 'last'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); } finally { db.close(); } })()`);
  await client.send("Page.reload", { ignoreCache: true });
  await client.until("document.querySelector('#status')?.textContent.includes('ni una vista guardada vigente')", "expired snapshot not presented");
  assert.equal(await client.evaluate("document.querySelectorAll('#areas .area').length"), 0);
  assert.equal(await client.evaluate("document.querySelectorAll('#land path').length"), 177);
  await client.evaluate("document.querySelector('#clear-snapshot').click()");
  await client.until("document.querySelector('#status').textContent.includes('Vista guardada borrada')", "forget map snapshot");
  assert.deepEqual(client.diagnostics, []);
  console.log(JSON.stringify({ status: "PASS", reports: eventCount, publicGroups: 4, mappedAreas: 3, basemapCountries: 177, offlineAfterAbruptStop: true, expiredSnapshotRejected: true, privateFieldsExcluded: true, cachedApiPaths: 0, mobileWidth: 360, unnamedControls: 0, screenshot: process.env.COLUVI_MAP_SCREENSHOT ?? null }, null, 2));
} finally {
  client?.socket.close(); await stop(browser); await stop(server); rmSync(directory, { recursive: true, force: true });
}
