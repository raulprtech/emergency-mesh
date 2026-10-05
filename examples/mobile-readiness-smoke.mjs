import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, freePort, ready, stop } from "./browser-fixture.mjs";
import { sourceProvenance } from "../src/operations/source-provenance.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "linux" || process.env.WSL_DISTRO_NAME !== "Ubuntu") throw new Error("Use Ubuntu WSL, never UbuntuPreview");
if (process.argv.length !== 3 || !process.env.COLUVI_CHROMIUM_PATH) throw new Error("Usage: COLUVI_CHROMIUM_PATH=/installed/chromium node examples/mobile-readiness-smoke.mjs NEW_DIRECTORY");
const destination = resolve(process.argv[2]);
mkdirSync(destination, { mode: 0o700 });
const fixture = mkdtempSync("/tmp/coluvi-mobile-readiness-");
const provenance = sourceProvenance(repository);
const startedAt = new Date().toISOString(); const cases = [];
let server; let browser; let client;
const save = (name, value) => writeFileSync(join(destination, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
try {
  const port = await freePort();
  server = spawn(process.execPath, ["src/server.ts"], { cwd: repository, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, PORT: String(port), EMERGENCY_MESH_HOST: "127.0.0.1", EMERGENCY_MESH_DATABASE_PATH: join(fixture, "server.sqlite"),
    EMERGENCY_MESH_COLUVI_CONFIG_PATH: "", EMERGENCY_MESH_TLS_CERT_PATH: "", EMERGENCY_MESH_TLS_KEY_PATH: "", EMERGENCY_MESH_ENABLE_DEBUG_EVENTS: "0",
  } });
  server.stderr.resume(); await ready(server, server.stdout, text => text.includes("Emergency Map:"));
  browser = spawn(process.env.COLUVI_CHROMIUM_PATH, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${join(fixture, "profile")}`, "about:blank"], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  const websocket = await ready(browser, browser.stderr, text => text.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]);
  client = await connect(`http://${new URL(websocket).host}`, "about:blank");
  await client.send("Accessibility.enable");
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-contrast", value: "more" }] });
  await client.send("Page.navigate", { url: `http://127.0.0.1:${port}/mobile/` });
  await client.until("Boolean(document.querySelector('#identity-status')?.textContent) && Boolean(navigator.serviceWorker.controller)", "application initialized");
  for (const width of [320, 360, 412]) for (const textScale of [1, 2]) for (const language of ["es", "en"]) {
    await client.send("Emulation.setDeviceMetricsOverride", { width, height: 915, deviceScaleFactor: 1, mobile: true });
    await client.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await client.evaluate("globalThis.__readinessDocument = true; true");
    await client.send("Page.navigate", { url: `http://127.0.0.1:${port}/mobile/` });
    await client.until("globalThis.__readinessDocument !== true && document.readyState === 'complete'", "independent viewport document");
    await client.until("Boolean(document.querySelector('#identity-status')?.textContent) && Boolean(navigator.serviceWorker.controller)", "case initialized and worker controlled");
    await client.evaluate(`document.documentElement.style.fontSize = '${textScale * 100}%'; document.querySelector('#language').value = '${language}'; document.querySelector('#language').dispatchEvent(new Event('change')); document.querySelector('#pilot-setup').open = true; document.querySelector('#diagnostics-panel').open = true; document.querySelector('[data-action=RESOURCE_REQUEST]').click(); true`);
    await client.until("document.querySelectorAll('#diagnostics-values dt').length === 16", "local diagnostics ready");
    await client.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const layout = await client.evaluate(`(() => {
      const visible = element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
      const bounds = element => { const r = element.getBoundingClientRect(); return { tag: element.tagName, id: element.id, width: Math.round(r.width), right: Math.round(r.right), left: Math.round(r.left) }; };
      const buttons = [...document.querySelectorAll('button, summary')].filter(visible);
      const overflow = [...document.querySelectorAll('main *, header *')].filter(visible).filter(element => { const r = element.getBoundingClientRect(); return r.right + scrollX > document.documentElement.clientWidth + 1 || r.left + scrollX < -1; }).map(bounds);
      const focus = document.activeElement?.id;
      return { width: innerWidth, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        overflowingContent: [...document.querySelectorAll('body *')].filter(visible).filter(element => element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).overflowX === 'visible').map(element => ({...bounds(element), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })),
        overflow, undersized: buttons.filter(element => { const r = element.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map(bounds),
        composerFocused: focus === 'short-message',
        diagnosticPairs: document.querySelectorAll('#diagnostics-values dt').length, language: document.documentElement.lang };
    })()`);
    const tree = await client.send("Accessibility.getFullAXTree");
    const interactiveRoles = new Set(["button", "checkbox", "combobox", "link", "textbox", "DisclosureTriangle"]);
    const unnamed = tree.nodes.filter(node => !node.ignored && interactiveRoles.has(node.role?.value) && !node.name?.value?.trim()).map(node => ({ role: node.role?.value, backendDOMNodeId: node.backendDOMNodeId }));
    layout.focusRestored = await client.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })); document.activeElement === document.querySelector('[data-action=RESOURCE_REQUEST]')");
    const result = { width, textScale, language, layout, unnamedInteractive: unnamed, status: "PASS" };
    const problems = [];
    if (layout.width !== width || layout.horizontalOverflow || layout.overflow.length) problems.push("HORIZONTAL_OVERFLOW");
    if (layout.undersized.length) problems.push("SMALL_BUTTON_OR_SUMMARY");
    if (!layout.composerFocused || !layout.focusRestored) problems.push("COMPOSER_FOCUS");
    if (layout.language !== language || unnamed.length) problems.push("LANGUAGE_OR_ACCESSIBLE_NAME");
    if (problems.length) { result.status = "FAIL"; result.problems = problems; }
    cases.push(result);
    process.stderr.write(`[readiness] ${width}px text=${textScale} language=${language} ${result.status}\n`);
    if (language === "es" && ((width === 412 && textScale === 1) || (width === 320 && textScale === 2))) {
      await client.evaluate("document.querySelector('#diagnostics-panel').scrollIntoView(); window.scrollTo(0, scrollY); true");
      await client.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
      await client.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const shot = await client.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(destination, `diagnostics-${width}-text${textScale}-es.png`), Buffer.from(shot.data, "base64"), { flag: "wx", mode: 0o600 });
    }
  }
  assert.deepEqual(client.diagnostics, []);
  assert.equal(cases.length, 12);
  assert.ok(cases.every(item => item.status === "PASS"), "Small-screen checks failed; inspect case evidence");
  assert.equal(sourceProvenance(repository).sourceSha256, provenance.sourceSha256, "Source changed during checks");
  const report = { version: 1, status: "PASS", startedAt, completedAt: new Date().toISOString(), provenance, sourceUnchanged: true, cases,
    limitations: ["Chromium emulation, not Samsung hardware or TalkBack", "Root font scaling, not Android system font scaling or pinch zoom", "Checks names, layout, button targets and composer focus; not a complete WCAG audit", "Unenrolled local fixture: populated operational cards are covered by other browser tests"] };
  save("readiness.json", report);
  console.log(JSON.stringify({ status: "PASS", cases: cases.length, report: join(destination, "readiness.json") }));
} catch (error) {
  save("readiness-failed.json", { version: 1, status: "FAIL", startedAt, completedAt: new Date().toISOString(), provenance, cases, message: error.message });
  throw error;
} finally {
  client?.socket.close();
  if (browser?.pid) { try { process.kill(-browser.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  await stop(browser); await stop(server);
  rmSync(fixture, { recursive: true, force: true });
}
