import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/mobile-client/sw.js", import.meta.url), "utf8");

test("service worker precaches every module required by the offline shell", () => {
  for (const asset of ["/mobile/", "/mobile/app.js", "/mobile/core.js", "/mobile/crypto.js", "/mobile/idb.js", "/mobile/i18n.js", "/mobile/protected.js", "/mobile/styles.css"]) {
    assert.match(source, new RegExp(asset.replaceAll("/", "\\/")));
  }
});

test("offline shell fallback is restricted to same-origin mobile navigations", () => {
  assert.match(source, /event\.request\.mode === "navigate"/);
  assert.match(source, /url\.origin === self\.location\.origin/);
  assert.match(source, /url\.pathname\.startsWith\("\/mobile\/"\)/);
  assert.match(source, /throw new TypeError\("Offline and resource is not cached"\)/);
  assert.doesNotMatch(source, /cached \?\? caches\.match\("\/mobile\/"\)/);
});
