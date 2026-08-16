import { readFileSync } from "node:fs";

const files = new Map<string, { file: string; contentType: string }>([
  ["/mobile/", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/mobile/app.js", { file: "app.js", contentType: "text/javascript; charset=utf-8" }],
  ["/mobile/core.js", { file: "core.js", contentType: "text/javascript; charset=utf-8" }],
  ["/mobile/background-sync.js", { file: "background-sync.js", contentType: "text/javascript; charset=utf-8" }],
  ["/mobile/crypto.js", { file: "crypto.js", contentType: "text/javascript; charset=utf-8" }],
  ["/mobile/idb.js", { file: "idb.js", contentType: "text/javascript; charset=utf-8" }],
  ["/mobile/i18n.js", { file: "i18n.js", contentType: "text/javascript; charset=utf-8" }],
  ["/mobile/protected.js", { file: "protected.js", contentType: "text/javascript; charset=utf-8" }],
  ["/mobile/sw.js", { file: "sw.js", contentType: "text/javascript; charset=utf-8" }],
  ["/mobile/styles.css", { file: "styles.css", contentType: "text/css; charset=utf-8" }],
  ["/mobile/manifest.webmanifest", { file: "manifest.webmanifest", contentType: "application/manifest+json; charset=utf-8" }],
  ["/mobile/icon.svg", { file: "icon.svg", contentType: "image/svg+xml" }],
]);

export function mobileAsset(path: string): { body: Buffer; contentType: string } | undefined {
  const asset = files.get(path);
  if (!asset) return undefined;
  return { body: readFileSync(new URL(asset.file, import.meta.url)), contentType: asset.contentType };
}
