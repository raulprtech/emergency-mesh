import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateClientInput } from "../src/mobile-client/core.js";
import { formatMessage, getCatalog, normalizeLocale, SUPPORTED_LOCALES } from "../src/mobile-client/i18n.js";

function leafPaths(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" ? leafPaths(child, path) : [path];
  }).sort();
}

test("Spanish and English catalogs expose the same complete message shape", () => {
  assert.deepEqual(SUPPORTED_LOCALES, ["es", "en"]);
  assert.deepEqual(leafPaths(getCatalog("es")), leafPaths(getCatalog("en")));
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("fr-FR"), "es");
});

test("message formatting substitutes bounded named values", () => {
  assert.equal(formatMessage("Location ±{meters} m", { meters: 125 }), "Location ±125 m");
  assert.equal(formatMessage("Missing {value}"), "Missing {value}");
});

test("input validation accepts the active locale error catalog", () => {
  const errors = validateClientInput({ action: "RESOURCE_REQUEST", needs: [] }, getCatalog("en").errors);
  assert.deepEqual(errors, ["Select at least one need"]);
});

test("mobile shell contains keyboard and assistive-technology landmarks", () => {
  const html = readFileSync(new URL("../src/mobile-client/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/mobile-client/styles.css", import.meta.url), "utf8");
  assert.match(html, /class="skip-link"/);
  assert.match(html, /<main id="main-content">/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /role="alert"/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-contrast/);
});
