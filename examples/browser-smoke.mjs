const debuggingPort = Number(process.argv[2] ?? 9222);
const debuggingHost = process.argv[4] ?? "127.0.0.1";
const targetUrl = process.argv[3] ?? "http://127.0.0.1:8787/mobile/";
const marker = `offline-smoke-${Date.now()}`;
const target = await fetch(`http://${debuggingHost}:${debuggingPort}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" }).then((response) => response.json());
const debuggerUrl = new URL(target.webSocketDebuggerUrl);
debuggerUrl.hostname = debuggingHost;
const socket = new WebSocket(debuggerUrl);
const pending = new Map();
const diagnostics = [];
let sequence = 0;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") diagnostics.push(message.params.exceptionDetails.text);
  if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) diagnostics.push(message.params.args.map((item) => item.value ?? item.description).join(" "));
});
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const setOffline = async (offline) => {
  const conditions = { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: offline ? "none" : "wifi" };
  await send("Network.emulateNetworkConditions", conditions);
  await send("Network.overrideNetworkState", conditions);
};
const stored = () => evaluate(`new Promise((resolve, reject) => {
  const request = indexedDB.open('emergency-mesh-client', 1);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const tx = request.result.transaction('outbox', 'readonly');
    const all = tx.objectStore('outbox').getAll();
    all.onsuccess = () => resolve(all.result.map((item) => ({ state: item.state, attempts: item.attempts, message: item.envelope.report.shortMessage })));
  };
})`);

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await send("Page.navigate", { url: targetUrl });
await wait(2_000);
await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
await evaluate(`(() => { const select = document.querySelector('#language'); select.value = 'en'; select.dispatchEvent(new Event('change')); return true; })()`);
await wait(500);
const online = await evaluate(`({
  title: document.title,
  language: document.documentElement.lang,
  heading: document.querySelector('h1')?.textContent,
  network: document.querySelector('#network')?.textContent,
  identity: document.querySelector('#identity-status')?.textContent,
  actions: document.querySelectorAll('[data-action]').length,
  serviceWorker: Boolean(navigator.serviceWorker.controller)
})`);

const backgroundSyncSupported = await evaluate(`navigator.serviceWorker.ready.then((registration) => "sync" in registration)`);
await setOffline(true);
await send("Page.reload", { ignoreCache: true });
await wait(2_000);
await evaluate(`(() => { Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => false }); window.dispatchEvent(new Event("offline")); })()`);
const offlineShell = await evaluate(`(async () => ({
  language: document.documentElement.lang,
  heading: document.querySelector('h1')?.textContent,
  network: document.querySelector('#network')?.textContent,
  actions: document.querySelectorAll('[data-action]').length,
  serviceWorker: Boolean(navigator.serviceWorker.controller)
}))()`);
await send("Network.setBypassServiceWorker", { bypass: true });
offlineShell.transportOffline = await evaluate(`fetch("/health?offline-probe", { cache: "no-store" }).then(() => false, () => true)`);
await send("Network.setBypassServiceWorker", { bypass: false });
await evaluate(`(() => {
  document.querySelector('[data-action="SAFE"]').click();
  document.querySelector('#short-message').value = ${JSON.stringify(marker)};
  document.querySelector('#report-form').requestSubmit();
  return true;
})()`);
await wait(1_000);
const queuedOffline = await stored();

await setOffline(false);
await evaluate(`(() => { Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => true }); window.dispatchEvent(new Event("online")); })()`);
await wait(500);
await evaluate(`document.querySelector("#sync").click()`);
await wait(2_500);
const afterReconnect = await evaluate(`({
  network: document.querySelector('#network')?.textContent,
  states: [...document.querySelectorAll('.outbox-item .state')].map((item) => item.textContent),
  formError: document.querySelector('#form-error')?.textContent
})`);
const storedAfterReconnect = await stored();
const queuedMarker = queuedOffline.find((item) => item.message === marker);
const syncedMarker = storedAfterReconnect.find((item) => item.message === marker);

console.log(JSON.stringify({ online, backgroundSyncSupported, offlineShell, queuedMarker, afterReconnect, syncedMarker, diagnostics }, null, 2));
socket.close();
if (
  diagnostics.length || online.actions !== 7 || online.language !== "en" || online.heading !== "What do you need to communicate?" || !online.serviceWorker ||
  offlineShell.actions !== 7 || offlineShell.language !== "en" || offlineShell.network !== "No Internet · offline mode" || !offlineShell.serviceWorker || !offlineShell.transportOffline ||
  !["QUEUED", ...(backgroundSyncSupported ? ["SYNCED"] : [])].includes(queuedMarker?.state) || syncedMarker?.state !== "SYNCED" || afterReconnect.formError
) process.exitCode = 1;
