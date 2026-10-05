import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

// Reproducible data transformation; no network dependency exists at application runtime.
const revision = "f1890d9f152c896d250a77557a5751a93d494776";
const source = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${revision}/geojson/ne_110m_admin_0_countries.geojson`;
const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Natural Earth source returned HTTP ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
if (bytes.length > 5_000_000) throw new Error("Unexpected basemap source size");
if (createHash("sha256").update(bytes).digest("hex") !== "6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f") throw new Error("Basemap source differs from pinned content");
const original = JSON.parse(new TextDecoder().decode(bytes));
if (original.type !== "FeatureCollection" || !Array.isArray(original.features)) throw new Error("Invalid basemap source");
const round = (coordinates) => coordinates.map(value => Array.isArray(value) ? round(value) : Number(value.toFixed(3)));
const features = original.features.map(feature => {
  if (!["Polygon", "MultiPolygon"].includes(feature.geometry?.type)) throw new Error("Unexpected geometry");
  return { type: "Feature", properties: { name: feature.properties.NAME_ES ?? feature.properties.NAME ?? "" }, geometry: { type: feature.geometry.type, coordinates: round(feature.geometry.coordinates) } };
});
const data = { type: "FeatureCollection", source, revision, sourceSha256: createHash("sha256").update(bytes).digest("hex"), attribution: "Made with Natural Earth", license: "Public domain", licenseUrl: "https://www.naturalearthdata.com/about/terms-of-use/", scale: "1:110m", features };
const directory = new URL("../src/web/public-map/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL("basemap.json", directory), JSON.stringify(data) + "\n");
console.log(JSON.stringify({ features: features.length, sourceSha256: data.sourceSha256, output: "src/web/public-map/basemap.json", bytes: Buffer.byteLength(JSON.stringify(data)) }));
