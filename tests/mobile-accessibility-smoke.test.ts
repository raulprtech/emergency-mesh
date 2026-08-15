import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/mobile-client/app.js", import.meta.url), "utf8");
const smoke = readFileSync(new URL("../examples/accessibility-smoke.mjs", import.meta.url), "utf8");

test("composer restores focus and supports keyboard dismissal", () => {
  assert.match(app, /composerTrigger = trigger/);
  assert.match(app, /event\.key !== "Escape"/);
  assert.match(app, /composerTrigger\?\.focus\(\)/);
});

test("accessibility smoke exercises Chromium AX and constrained mobile emulation", () => {
  assert.match(smoke, /Accessibility\.getFullAXTree/);
  assert.match(smoke, /Emulation\.setCPUThrottlingRate/);
  assert.match(smoke, /prefers-reduced-motion/);
  assert.match(smoke, /prefers-contrast/);
  assert.match(smoke, /unnamedInteractive/);
  assert.match(smoke, /undersizedButtons/);
  assert.match(smoke, /escapeRestoresTriggerFocus/);
});
