import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mobileAsset } from "../src/mobile-client/assets.ts";

test("mobile manifest exposes a same-origin standalone identity and maskable icon", () => {
  const manifestAsset = mobileAsset("/mobile/manifest.webmanifest");
  assert.ok(manifestAsset);
  const manifest = JSON.parse(manifestAsset.body.toString("utf8"));
  assert.equal(manifest.id, "/mobile/");
  assert.equal(manifest.start_url, "/mobile/");
  assert.equal(manifest.scope, "/mobile/");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon: { src?: string; purpose?: string }) =>
    icon.src === "/mobile/icon.svg" && icon.purpose?.split(" ").includes("maskable")));

  const icon = mobileAsset("/mobile/icon.svg");
  assert.ok(icon);
  assert.equal(icon.contentType, "image/svg+xml");
  assert.match(icon.body.toString("utf8"), /viewBox="0 0 512 512"/);
  const worker = readFileSync(new URL("../src/mobile-client/sw.js", import.meta.url), "utf8");
  assert.match(worker, /"\/mobile\/icon\.svg"/);
});
