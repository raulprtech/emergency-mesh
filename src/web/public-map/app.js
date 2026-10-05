import { NEED_NAMES, HOME_BOUNDS, MEXICO_BOUNDS, publicSnapshot, publicZones, filteredAreas, mergeAreas, areaBounds, boundsPath, viewBox, geometryPath, reportClass } from "./model.js";
import { openPublicMapStore } from "./storage.js";

const $ = selector => document.querySelector(selector);
const svgNS = "http://www.w3.org/2000/svg";
const date = value => new Date(value).toLocaleString("es-MX");
let snapshot; let store; let zones = []; let selected = ""; let listLimit = 40;
let currentBox = viewBox(HOME_BOUNDS); let busy = false; let timer; let persisted = false;
let generation = 0; let autoRefresh = true; let renderKey = "";

function node(tag, text, className) {
  const element = document.createElement(tag); if (text !== undefined) element.textContent = text;
  if (className) element.className = className; return element;
}
async function resource(path, maximumBytes = 4 * 1024 * 1024) {
  const response = await fetch(path, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error("Recurso no disponible");
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length;
      if (size > maximumBytes) throw new Error("Recurso demasiado grande"); chunks.push(value); }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function setBox(box) {
  if (!box.every(Number.isFinite) || box[2] < 1 || box[3] < 1 || box[2] > 34_000 || box[3] > 18_000) return;
  currentBox = box; $("#map").setAttribute("viewBox", box.join(" "));
}
function focusBounds(bounds) {
  if (!bounds.length) return;
  const extent = [Math.min(...bounds.map(b => b[0])), Math.min(...bounds.map(b => b[1])), Math.max(...bounds.map(b => b[2])), Math.max(...bounds.map(b => b[3]))];
  const [x, y, w, h] = viewBox(extent); const width = Math.max(8, w * 1.4); const height = Math.max(8, h * 1.4);
  setBox([x + w / 2 - width / 2, y + h / 2 - height / 2, width, height]);
}
function zoom(factor) { const [x, y, w, h] = currentBox; setBox([x + w * (1 - factor) / 2, y + h * (1 - factor) / 2, w * factor, h * factor]); }
function nameFor(id) {
  if (id === "unknown") return "Área no especificada";
  if (id.startsWith("zone:")) return zones.find(zone => zone.id === id.slice(5))?.label ?? `Zona ${id.slice(5)} (sin geometría)`;
  return `Celda aproximada ${id.slice(5)}`;
}
function options(select, values, firstLabel) {
  const previous = select.value; const next = JSON.stringify(values);
  if (select.dataset.options === next) return;
  select.replaceChildren(new Option(firstLabel, ""), ...values.map(([value, label]) => new Option(label, value)));
  if (values.some(([value]) => value === previous)) select.value = previous;
  select.dataset.options = next;
}
function visibleAreas() { return snapshot ? filteredAreas(snapshot, { need: $("#need").value, bucket: $("#bucket").value, zone: $("#zone").value }) : []; }
function path(d, title, className) {
  const element = document.createElementNS(svgNS, "path"); element.setAttribute("d", d);
  if (className) element.setAttribute("class", className);
  const label = document.createElementNS(svgNS, "title"); label.textContent = title; element.append(label); return element;
}
function render() {
  if (snapshot) { try { snapshot = publicSnapshot(snapshot); } catch { snapshot = undefined; persisted = false; void store?.clear().catch(() => {}); } }
  const policy = snapshot?.privacy;
  const areas = snapshot?.areas ?? [];
  options($("#zone"), [...new Set(areas.map(area => area.areaId))].sort().map(id => [id, nameFor(id)]), "Todas");
  options($("#bucket"), [...new Set(areas.map(area => area.timeBucketStart).filter(Number.isFinite))].sort((a, b) => b - a).map(value => [String(value), date(value)]), "Todos");
  $("#privacy").textContent = policy ? `Mínimo ${policy.minimumGroupSize} reportes por grupo · coordenadas redondeadas a ${policy.spatialPrecisionDecimals} decimal(es) · ${policy.suppressedGroups} grupo(s) no publicado(s). Los reportes no equivalen a personas únicas.` : "Sin una vista pública vigente. No se muestran datos privados.";
  const visible = visibleAreas(); const merged = mergeAreas(visible); let mapped = 0;
  const key = JSON.stringify([visible, listLimit, selected, zones]);
  if (key !== renderKey) {
    renderKey = key;
    const focusId = document.activeElement?.dataset.focusArea;
    $("#cells").replaceChildren(); $("#areas").replaceChildren();
    for (const area of merged) {
      const bounds = areaBounds(area.areaId, policy.spatialPrecisionDecimals, zones); if (!bounds) continue; mapped++;
      const cell = path(boundsPath(bounds), `${nameFor(area.areaId)}: ${area.total} reportes publicados`, `${reportClass(area)}${selected === area.areaId ? " selected" : ""}`);
      cell.dataset.area = area.areaId; $("#cells").append(cell);
    }
    for (const area of visible.slice(0, listLimit)) {
      const card = node("article", undefined, "area"); card.dataset.area = area.areaId;
      card.append(node("div", `${area.total} reportes`, "count"), node("h3", nameFor(area.areaId)));
      const count = n => n === null ? "No publicado" : String(n);
      card.append(node("p", `SOS: ${count(area.sos)} · Críticos: ${count(area.critical)}`));
      const needs = Object.entries(area.needs).filter(([, n]) => typeof n === "number" && n > 0).map(([key, n]) => `${NEED_NAMES[key]}: ${n}`).join(" · ");
      card.append(node("p", needs || (Object.values(area.needs).includes(null) ? "Desglose de necesidades no publicado por privacidad." : "Sin necesidades en estos reportes.")));
      if (area.timeBucketStart !== undefined) card.append(node("p", `Intervalo: ${date(area.timeBucketStart)} – ${date(area.timeBucketEnd)}`, "muted"));
      card.append(node("p", `Observación más reciente: ${date(area.newestObservedAt)}`, "muted"));
      const bounds = areaBounds(area.areaId, policy.spatialPrecisionDecimals, zones);
      if (bounds) {
        const button = node("button", "Ver esta área en el mapa"); button.type = "button"; button.dataset.focusArea = `${area.areaId}|${area.timeBucketStart ?? "all"}`;
        button.setAttribute("aria-label", `Ver ${nameFor(area.areaId)} en el mapa`);
        button.addEventListener("click", () => { selected = area.areaId; focusBounds([bounds]); $("#map-selection").textContent = `Área seleccionada: ${nameFor(area.areaId)}. Consulte la lista para ver los intervalos.`; render(); }); card.append(button);
      } else card.append(node("p", "Solo en lista: no hay geometría pública para esta área.", "muted"));
      $("#areas").append(card);
    }
    if (!visible.length) $("#areas").append(node("p", "No hay grupos publicables con estos filtros. Esto no demuestra ausencia de necesidades o emergencias."));
    if (focusId) [...document.querySelectorAll("[data-focus-area]")].find(button => button.dataset.focusArea === focusId)?.focus({ preventScroll: true });
  } else mapped = $("#cells").children.length;
  $("#map-summary").textContent = `${mapped} área(s) con geometría · ${merged.length - mapped} solo en lista. Los intervalos visibles se suman por área en el mapa.`;
  $("#list-summary").textContent = `${visible.length} grupo(s) área–intervalo · ${visible.reduce((total, area) => total + area.total, 0)} reportes publicados.`;
  $("#more").hidden = visible.length <= listLimit;
  $("#saved-status").textContent = persisted && snapshot ? `Vista pública guardada: ${date(snapshot.privacy.generatedAt)}. Se descarta como máximo a las 24 horas; las observaciones antiguas pueden desaparecer antes.` : "No hay una vista pública guardada disponible.";
}
function schedule() { clearTimeout(timer); if (autoRefresh && !document.hidden) timer = setTimeout(refresh, 30_000); }
async function refresh() {
  if (busy) return; busy = true; const epoch = generation; $("#refresh").disabled = true;
  try {
    const result = publicSnapshot(await resource("/api/areas"));
    if (epoch !== generation) return;
    snapshot = result; persisted = false;
    if (store) { try { await store.save(result); if (epoch === generation) persisted = true; } catch { /* Live map remains usable without local storage. */ } }
    if (epoch !== generation) return;
    $("#status").textContent = `Vista consultada: ${date(result.privacy.generatedAt)}. Actualización automática cada 30 segundos mientras esta página está visible.`;
    $(".connection").classList.remove("offline");
  } catch {
    if (epoch !== generation) return;
    if (!snapshot && store) { try { const saved = await store.read(); if (epoch !== generation) return; snapshot = saved; persisted = Boolean(saved); } catch { /* Storage unavailable. */ } }
    $(".connection").classList.add("offline");
    if (snapshot) { try { snapshot = publicSnapshot(snapshot); } catch { snapshot = undefined; persisted = false; } }
    $("#status").textContent = snapshot ? `Sin actualización del servidor. Vista anterior del ${date(snapshot.privacy.generatedAt)}; no representa el estado actual.` : "Sin actualización del servidor ni una vista guardada vigente. La cartografía disponible no confirma ausencia de reportes.";
  } finally {
    busy = false; $("#refresh").disabled = false; render(); if (epoch === generation) schedule();
  }
}

$("#refresh").addEventListener("click", () => { autoRefresh = true; void refresh(); });
for (const id of ["need", "bucket", "zone"]) $(`#${id}`).addEventListener("change", () => { listLimit = 40; render(); });
$("#home").addEventListener("click", () => setBox(viewBox(HOME_BOUNDS)));
$("#mexico").addEventListener("click", () => setBox(viewBox(MEXICO_BOUNDS)));
$("#fit").addEventListener("click", () => focusBounds(visibleAreas().map(area => areaBounds(area.areaId, snapshot.privacy.spatialPrecisionDecimals, zones)).filter(Boolean)));
$("#zoom-in").addEventListener("click", () => zoom(.65)); $("#zoom-out").addEventListener("click", () => zoom(1 / .65));
for (const button of document.querySelectorAll("[data-pan]")) button.addEventListener("click", () => {
  const [x, y, w, h] = currentBox; const direction = button.dataset.pan;
  setBox([x + (direction === "west" ? -.25 : direction === "east" ? .25 : 0) * w, y + (direction === "north" ? -.25 : direction === "south" ? .25 : 0) * h, w, h]);
});
$("#more").addEventListener("click", () => { listLimit += 40; render(); });
$("#clear-snapshot").addEventListener("click", async () => {
  generation++; autoRefresh = false; clearTimeout(timer); snapshot = undefined; persisted = false; render();
  try { await store?.clear(); $("#status").textContent = "Vista guardada borrada. Pulse Actualizar para consultar y guardar una nueva."; }
  catch { $("#status").textContent = "No se pudo borrar el almacenamiento local. Cierre otras ventanas del mapa y vuelva a intentar."; }
});
document.addEventListener("visibilitychange", () => { clearTimeout(timer); if (!document.hidden && autoRefresh) void refresh(); });
window.addEventListener("online", () => { if (autoRefresh) void refresh(); });
window.addEventListener("offline", () => { if (autoRefresh) void refresh(); });
options($("#need"), Object.entries(NEED_NAMES), "Todas"); setBox(currentBox);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/map/sw.js", { scope: "/map/" }).catch(() => { $("#basemap-status").append(" No se pudo preparar la recarga sin conexión."); });
const setup = await Promise.allSettled([resource("/map/basemap.json", 1024 * 1024), resource("/map/zones.json", 64 * 1024), openPublicMapStore()]);
if (setup[0].status === "fulfilled") {
  for (const feature of setup[0].value.features) $("#land").append(path(geometryPath(feature.geometry), feature.properties.name));
} else $("#basemap-status").prepend("Cartografía de fondo no disponible; utilice la lista de áreas. ");
if (setup[1].status === "fulfilled") {
  try { zones = publicZones(setup[1].value); for (const zone of zones) $("#drill-zones").append(path(boundsPath(zone.bounds), zone.label)); }
  catch { $("#basemap-status").append(" Geometrías de simulacro no disponibles."); }
}
if (setup[2].status === "fulfilled") store = setup[2].value;
render(); await refresh();
