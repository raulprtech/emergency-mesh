import { readFileSync } from "node:fs";

const files = new Map([
  ["/command-center/", ["index.html", "text/html; charset=utf-8"]],
  ["/command-center/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/command-center/view.js", ["view.js", "text/javascript; charset=utf-8"]],
  ["/command-center/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
export function operatorAsset(path: string) {
  const asset = files.get(path);
  return asset ? { body: readFileSync(new URL(asset[0], import.meta.url)), contentType: asset[1] } : undefined;
}
