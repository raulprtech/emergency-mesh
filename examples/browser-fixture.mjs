import { createServer } from "node:http";

export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function stop(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill(signal); const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited; clearTimeout(timer);
}
export async function freePort() {
  const probe = createServer(); await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
export async function ready(child, stream, match) {
  return new Promise((resolve, reject) => {
    let buffer = ""; let complete = false;
    const finish = (error, result) => { if (complete) return; complete = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error("Fixture startup timed out")), 10_000);
    child.once("error", error => finish(error)); child.once("exit", code => finish(new Error(`Fixture exited before ready (${code})`)));
    stream.setEncoding("utf8"); stream.on("data", chunk => { if (complete) return; buffer = (buffer + chunk).slice(-8192); const value = match(buffer); if (value) finish(undefined, value); });
  });
}
export async function connect(debugOrigin, url) {
  const target = await (await fetch(`${debugOrigin}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl); const pending = new Map(); let sequence = 0; const diagnostics = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") diagnostics.push(message.params.exceptionDetails);
  });
  socket.addEventListener("close", () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Browser target closed")); } pending.clear(); });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  };
  const until = async (expression, label, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await wait(100); }
    throw new Error(`Browser condition timed out: ${label}`);
  };
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  return { socket, send, evaluate, until, diagnostics, targetId: target.id };
}
