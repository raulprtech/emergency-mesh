import { readFileSync } from "node:fs";

const assets = new Map([
  ["/map/", ["index.html", "text/html; charset=utf-8"]],
  ["/map/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/map/model.js", ["model.js", "text/javascript; charset=utf-8"]],
  ["/map/storage.js", ["storage.js", "text/javascript; charset=utf-8"]],
  ["/map/sw.js", ["sw.js", "text/javascript; charset=utf-8"]],
  ["/map/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/map/basemap.json", ["basemap.json", "application/geo+json"]],
  ["/map/zones.json", ["zones.json", "application/json"]],
]);

export function mapAsset(path: string): { body: Buffer; contentType: string } | undefined {
  const asset = assets.get(path);
  return asset ? { body: readFileSync(new URL(asset[0], import.meta.url)), contentType: asset[1] } : undefined;
}
