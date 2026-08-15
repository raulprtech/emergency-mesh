import assert from "node:assert/strict";

const debuggingPort = Number(process.argv[2] ?? 9222);
const targetUrl = process.argv[3] ?? "http://127.0.0.1:8787/mobile/";
const debuggingHost = process.argv[4] ?? "127.0.0.1";
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
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") diagnostics.push(message.params.exceptionDetails.text);
  if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
    diagnostics.push(message.params.args.map((item) => item.value ?? item.description).join(" "));
  }
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Accessibility.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-reduced-motion", value: "reduce" },
    { name: "prefers-contrast", value: "more" },
  ] });
  await send("Page.navigate", { url: targetUrl });
  await wait(2_000);
  await evaluate(`(() => {
    const language = document.querySelector('#language');
    language.value = 'en';
    language.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await wait(500);

  const visual = await evaluate(`(async () => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const actions = [...document.querySelectorAll('[data-action]')].filter(visible);
    const skip = document.querySelector('.skip-link');
    skip.focus();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const skipRect = skip.getBoundingClientRect();
    const skipLinkFocused = document.activeElement === skip;
    const skipLinkVisibleWhenFocused = skipRect.top >= 0 && skipRect.bottom <= innerHeight && getComputedStyle(skip).visibility === "visible";
    const sos = document.querySelector('[data-action="SOS"]');
    sos.click();
    const composerFocusOnOpen = document.activeElement?.id === "short-message";
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const escapeClosesComposer = document.querySelector("#composer").classList.contains("hidden");
    const escapeRestoresTriggerFocus = document.activeElement === sos;
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      increasedContrast: matchMedia('(prefers-contrast: more)').matches,
      reducedAnimationDuration: getComputedStyle(document.body).animationDuration,
      warningBorderWidth: getComputedStyle(document.querySelector('.warning')).borderLeftWidth,
      skipLinkFocused,
      skipLinkBounds: { top: skipRect.top, bottom: skipRect.bottom },
      skipLinkVisibility: getComputedStyle(skip).visibility,
      skipLinkTransform: getComputedStyle(skip).transform,
      skipLinkVisibleWhenFocused,
      composerFocusOnOpen,
      escapeClosesComposer,
      escapeRestoresTriggerFocus,
      undersizedButtons: buttons.filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width < 44 || rect.height < 44;
      }).map((button) => button.textContent.trim()),
      actionColumnCount: new Set(actions.map((button) => Math.round(button.getBoundingClientRect().left))).size,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);

  const accessibility = await send("Accessibility.getFullAXTree");
  const exposed = accessibility.nodes.filter((node) => !node.ignored);
  const nodes = exposed.map((node) => ({ role: node.role?.value, name: node.name?.value ?? "" }));
  const namesForRole = (role) => nodes.filter((node) => node.role === role).map((node) => node.name);
  const interactiveRoles = new Set(["button", "checkbox", "combobox", "link", "textbox"]);
  const unnamedInteractive = nodes.filter((node) => interactiveRoles.has(node.role) && !node.name.trim());
  const buttons = namesForRole("button");
  const headings = namesForRole("heading");
  const regions = namesForRole("region");

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(unnamedInteractive, []);
  assert.equal(namesForRole("RootWebArea").includes("Emergency Mesh"), true);
  assert.equal(namesForRole("main").length, 1);
  for (const heading of ["What do you need to communicate?", "Saved reports"]) assert.equal(headings.includes(heading), true);
  for (const region of ["Important notice", "Primary actions", "Reports about other people"]) assert.equal(regions.includes(region), true);
  for (const button of ["I am safe", "I need resources", "I need assistance", "Critical emergency", "Try to synchronize"]) {
    assert.equal(buttons.includes(button), true);
  }
  assert.equal(visual.viewport.width, 360);
  assert.equal(visual.reducedMotion, true);
  assert.equal(visual.increasedContrast, true);
  assert.equal(visual.skipLinkFocused, true);
  assert.equal(visual.skipLinkVisibleWhenFocused, true, JSON.stringify(visual));
  assert.equal(visual.composerFocusOnOpen, true);
  assert.equal(visual.escapeClosesComposer, true);
  assert.equal(visual.escapeRestoresTriggerFocus, true);
  assert.deepEqual(visual.undersizedButtons, []);
  assert.equal(visual.actionColumnCount, 1);
  assert.equal(visual.horizontalOverflow, false);

  console.log(JSON.stringify({
    success: true,
    profile: { viewport: visual.viewport, cpuThrottlingRate: 4, touchPoints: 5 },
    preferences: { reducedMotion: visual.reducedMotion, increasedContrast: visual.increasedContrast },
    accessibility: {
      exposedNodes: nodes.length,
      headings,
      namedButtons: buttons.length,
      regions,
      unnamedInteractive: unnamedInteractive.length,
    },
    layout: {
      minimumButtonTargetCssPixels: 44,
      actionColumnCount: visual.actionColumnCount,
      horizontalOverflow: visual.horizontalOverflow,
      skipLinkVisibleWhenFocused: visual.skipLinkVisibleWhenFocused,
      composerFocusOnOpen: visual.composerFocusOnOpen,
      escapeClosesComposer: visual.escapeClosesComposer,
      escapeRestoresTriggerFocus: visual.escapeRestoresTriggerFocus,
    },
    diagnostics,
  }, null, 2));
} finally {
  await send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
  socket.close();
}
