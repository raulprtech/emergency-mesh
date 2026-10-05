export const NEED_NAMES = Object.freeze({ WATER: "Agua", FOOD: "Alimentos", MEDICATION: "Medicamentos", MEDICAL_CARE: "Atención médica", EXTRACTION: "Extracción", SHELTER: "Refugio", ENERGY: "Energía", TRANSPORT: "Transporte", COMMUNICATION: "Comunicación" });
export const HOME_BOUNDS = [-93, 17.5, -86, 22.5];
export const MEXICO_BOUNDS = [-118, 14, -86, 33];
export const MAX_SNAPSHOT_AGE = 24 * 60 * 60_000;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const count = (value, total) => value === null || (integer(value) && value <= total);

export function publicSnapshot(value, now = Date.now()) {
  const policy = value?.privacy;
  if (!policy || !integer(policy.generatedAt) || policy.generatedAt > now + 5 * 60_000 || policy.generatedAt + MAX_SNAPSHOT_AGE <= now
    || !integer(policy.maximumAgeMs) || !integer(policy.timeBucketMs) || !integer(policy.minimumGroupSize) || policy.minimumGroupSize < 1
    || !integer(policy.spatialPrecisionDecimals) || policy.spatialPrecisionDecimals > 3 || !integer(policy.suppressedGroups)
    || !Array.isArray(value.areas) || value.areas.length > 5_000) throw new Error("Vista pública inválida o caducada");
  const areas = value.areas.map(area => {
    if (!area || typeof area.areaId !== "string" || !/^(?:unknown|zone:[A-Za-z0-9_-]{1,80}|grid:-?\d{1,2}(?:\.\d{1,3})?,-?\d{1,3}(?:\.\d{1,3})?)$/.test(area.areaId)
      || !integer(area.total) || area.total < policy.minimumGroupSize || !count(area.critical, area.total) || !count(area.sos, area.total)
      || !integer(area.newestObservedAt) || area.newestObservedAt > policy.generatedAt + 5 * 60_000 || !area.needs || typeof area.needs !== "object" || Array.isArray(area.needs)
      || Object.entries(area.needs).some(([key, n]) => !Object.hasOwn(NEED_NAMES, key) || !count(n, area.total))) throw new Error("Agregado público inválido");
    if (policy.timeBucketMs > 0 && (!integer(area.timeBucketStart) || area.timeBucketStart % policy.timeBucketMs !== 0 || area.timeBucketEnd !== area.timeBucketStart + policy.timeBucketMs)) throw new Error("Intervalo público inválido");
    // Whitelist the public projection before any local persistence; discard unknown fields.
    return { areaId: area.areaId, total: area.total, critical: area.critical, sos: area.sos, needs: { ...area.needs }, newestObservedAt: area.newestObservedAt,
      ...(policy.timeBucketMs > 0 ? { timeBucketStart: area.timeBucketStart, timeBucketEnd: area.timeBucketEnd } : {}) };
  }).filter(area => area.newestObservedAt + Math.min(policy.maximumAgeMs, MAX_SNAPSHOT_AGE) > now);
  return { areas, privacy: { generatedAt: policy.generatedAt, maximumAgeMs: Math.min(policy.maximumAgeMs, MAX_SNAPSHOT_AGE), timeBucketMs: policy.timeBucketMs, minimumGroupSize: policy.minimumGroupSize, spatialPrecisionDecimals: policy.spatialPrecisionDecimals, suppressedGroups: policy.suppressedGroups, breakdownProtection: policy.breakdownProtection === true } };
}

export function areaBounds(areaId, precision, zones) {
  if (areaId.startsWith("zone:")) return zones.find(zone => zone.id === areaId.slice(5))?.bounds;
  const match = areaId.match(/^grid:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match || !Number.isInteger(precision) || precision < 0 || precision > 3) return undefined;
  const latitude = Number(match[1]); const longitude = Number(match[2]); const half = 10 ** -precision / 2;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return [Math.max(-180, longitude - half), Math.max(-90, latitude - half), Math.min(180, longitude + half), Math.min(90, latitude + half)];
}

export function publicZones(value) {
  if (value?.version !== 1 || !Array.isArray(value.zones) || value.zones.length > 100) throw new Error("Geometría de zonas inválida");
  const seen = new Set();
  return value.zones.map(zone => {
    const bounds = zone.bounds;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(zone.id) || seen.has(zone.id) || typeof zone.label !== "string" || zone.label.length > 120
      || !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
      || bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -85 || bounds[3] > 85 || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error("Zona pública inválida");
    seen.add(zone.id); return { id: zone.id, label: zone.label, bounds: [...bounds] };
  });
}

export function filteredAreas(snapshot, { need = "", bucket = "", zone = "" } = {}) {
  return snapshot.areas.filter(area => (!need || (typeof area.needs[need] === "number" && area.needs[need] > 0))
    && (!bucket || String(area.timeBucketStart) === bucket) && (!zone || area.areaId === zone));
}
export function mergeAreas(areas) {
  const merged = new Map();
  for (const area of areas) {
    const previous = merged.get(area.areaId);
    if (!previous) { merged.set(area.areaId, structuredClone(area)); continue; }
    previous.total += area.total; previous.newestObservedAt = Math.max(previous.newestObservedAt, area.newestObservedAt);
    for (const field of ["critical", "sos"]) previous[field] = previous[field] === null || area[field] === null ? null : previous[field] + area[field];
    for (const key of Object.keys(NEED_NAMES)) {
      const a = previous.needs[key] ?? (previous.needs[key] === null ? null : 0); const b = area.needs[key] ?? (area.needs[key] === null ? null : 0);
      previous.needs[key] = a === null || b === null ? null : a + b;
    }
  }
  return [...merged.values()];
}
// Local equirectangular overview. It is not a navigation or hazard model.
export const project = ([longitude, latitude]) => [longitude * Math.cos(20 * Math.PI / 180) * 100, -latitude * 100];
export function viewBox(bounds) {
  const [left, bottom] = project([bounds[0], bounds[1]]); const [right, top] = project([bounds[2], bounds[3]]);
  return [left, top, right - left, bottom - top];
}
export function boundsPath(bounds) {
  const [x, y, width, height] = viewBox(bounds); return `M${x},${y}h${width}v${height}h${-width}Z`;
}
export function geometryPath(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons.map(polygon => polygon.map(ring => ring.map((coordinate, index) => `${index ? "L" : "M"}${project(coordinate).map(n => n.toFixed(2)).join(",")}`).join("") + "Z").join("")).join("");
}
export function reportClass(area) { return area.total >= 20 ? "volume-high" : area.total >= 10 ? "volume-medium" : "volume-low"; }
