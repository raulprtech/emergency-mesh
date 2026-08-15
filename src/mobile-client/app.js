import { ACTIONS, createOutboxItem, validateClientInput } from "./core.js";
import { OUTBOX_SYNC_TAG, synchronizeOutboxExclusively } from "./background-sync.js";
import { createBrowserIdentity, createUnsignedIdentity } from "./crypto.js";
import { openClientDatabase } from "./idb.js";
import { formatMessage, getCatalog, normalizeLocale } from "./i18n.js";

const db = await openClientDatabase();
let identity = await db.getSetting("identity");
let locale = normalizeLocale(await db.getSetting("locale") ?? navigator.language);
let catalog = getCatalog(locale);
let pendingLocation;
let serviceWorkerRegistration;
let composerTrigger;

async function newIdentity() {
  try { return await createBrowserIdentity(); }
  catch { return createUnsignedIdentity(); }
}
if (!identity) { identity = await newIdentity(); await db.setSetting("identity", identity); }

const byId = (id) => document.getElementById(id);
const composer = byId("composer");
const form = byId("report-form");

function networkStatus() {
  byId("network").textContent = navigator.onLine ? catalog.online : catalog.offline;
}

function locationStatus() {
  byId("location-status").textContent = pendingLocation
    ? formatMessage(catalog.approximateLocation, { meters: Math.max(100, Math.round(pendingLocation.accuracyMeters ?? 100)) })
    : catalog.noLocation;
}

function applyLocale() {
  catalog = getCatalog(locale);
  document.documentElement.lang = locale;
  byId("language").value = locale;
  byId("language").setAttribute("aria-label", catalog.language);
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = catalog[node.dataset.i18n];
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) node.placeholder = catalog[node.dataset.i18nPlaceholder];
  for (const node of document.querySelectorAll("[data-i18n-aria-label]")) node.setAttribute("aria-label", catalog[node.dataset.i18nAriaLabel]);
  for (const button of document.querySelectorAll("[data-action]")) {
    const label = button.querySelector("[data-action-label]");
    if (label) label.textContent = catalog.actions[button.dataset.action];
    else button.textContent = catalog.actions[button.dataset.action];
  }
  for (const node of document.querySelectorAll("[data-need-label]")) node.textContent = catalog.needNames[node.dataset.needLabel];
  const action = byId("action").value;
  if (action) byId("composer-title").textContent = catalog.actions[action];
  networkStatus();
  locationStatus();
}

function configureForm(action, trigger) {
  composerTrigger = trigger;
  byId("action").value = action;
  byId("composer-title").textContent = catalog.actions[action];
  byId("subject-field").classList.toggle("hidden", !["THIRD_PARTY", "LAST_SEEN", "PERSON_FOUND"].includes(action));
  byId("related-field").classList.toggle("hidden", action !== "PERSON_FOUND");
  byId("observed-field").classList.toggle("hidden", action !== "LAST_SEEN");
  byId("needs-field").classList.toggle("hidden", action !== "RESOURCE_REQUEST");
  byId("observed-at").value = action === "LAST_SEEN" ? new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
  byId("form-error").textContent = "";
  pendingLocation = undefined;
  locationStatus();
  composer.classList.remove("hidden");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  composer.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  byId("short-message").focus();
}

function closeComposer() {
  composer.classList.add("hidden");
  composerTrigger?.focus();
}

document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", (event) => configureForm(button.dataset.action, event.currentTarget)));
byId("close-composer").addEventListener("click", closeComposer);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || composer.classList.contains("hidden")) return;
  event.preventDefault();
  closeComposer();
});
byId("language").addEventListener("change", async (event) => {
  locale = normalizeLocale(event.target.value);
  await db.setSetting("locale", locale);
  applyLocale();
  await render();
});
byId("get-location").addEventListener("click", () => {
  if (!navigator.geolocation) { byId("location-status").textContent = catalog.unavailableLocation; return; }
  byId("location-status").textContent = catalog.gettingLocation;
  navigator.geolocation.getCurrentPosition((position) => {
    pendingLocation = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyMeters: position.coords.accuracy, timestamp: position.timestamp };
    locationStatus();
  }, () => { byId("location-status").textContent = catalog.locationFailed; }, { enableHighAccuracy: false, timeout: 8_000, maximumAge: 5 * 60_000 });
});

async function scheduleBackgroundSync() {
  if (!("serviceWorker" in navigator)) return false;
  try {
    const registration = serviceWorkerRegistration ?? await navigator.serviceWorker.ready;
    if (!("sync" in registration)) return false;
    await registration.sync.register(OUTBOX_SYNC_TAG);
    return true;
  } catch { return false; }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  byId("form-error").textContent = "";
  const input = {
    action: byId("action").value,
    shortMessage: byId("short-message").value,
    subjectId: byId("subject-id").value.trim() || undefined,
    relatedEventId: byId("related-event-id").value.trim() || undefined,
    observedAt: byId("observed-at").value ? new Date(byId("observed-at").value).getTime() : undefined,
    needs: [...document.querySelectorAll('input[name="need"]:checked')].map((element) => element.value),
    location: pendingLocation,
  };
  try {
    const errors = validateClientInput(input, catalog.errors);
    if (errors.length) throw new Error(errors.join("; "));
    const item = await createOutboxItem(input, identity);
    await db.put(item);
    await scheduleBackgroundSync();
    form.reset(); closeComposer(); pendingLocation = undefined; await render();
    if (navigator.onLine) await sync();
  } catch (error) { byId("form-error").textContent = error instanceof Error ? error.message : catalog.createFailed; }
});

async function render() {
  const items = await db.list();
  byId("identity-status").textContent = identity.mode === "ED25519"
    ? formatMessage(catalog.localIdentity, { id: identity.anonymousDeviceId })
    : catalog.unsignedIdentity;
  const list = byId("outbox-list"); list.replaceChildren();
  if (!items.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = catalog.emptyOutbox; list.append(empty); return; }
  for (const item of items) {
    const article = document.createElement("article"); article.className = "outbox-item";
    const action = Object.keys(ACTIONS).find((key) => ACTIONS[key].eventType === item.envelope.report.eventType && ACTIONS[key].reportMode === item.envelope.report.reportMode);
    const title = document.createElement("strong"); title.textContent = catalog.actions[action] ?? item.envelope.report.eventType;
    const state = document.createElement("p"); state.className = "state"; state.textContent = catalog.states[item.state];
    if (item.lastError) state.textContent += ` · ${formatMessage(catalog.lastAttempt, { error: item.lastError })}`;
    const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = `${new Date(item.createdAt).toLocaleString(locale === "es" ? "es-MX" : "en")} · ${item.eventId}`;
    article.append(title, state, meta); list.append(article);
  }
}

async function sync() {
  byId("sync").disabled = true;
  try {
    const results = await synchronizeOutboxExclusively(db);
    if (results.some((item) => item.state === "QUEUED")) await scheduleBackgroundSync();
  }
  finally { byId("sync").disabled = false; await render(); }
}
byId("sync").addEventListener("click", sync);
byId("rotate-identity").addEventListener("click", async () => {
  if (!confirm(catalog.rotateWarning)) return;
  identity = await newIdentity(); await db.setSetting("identity", identity); await render();
});
window.addEventListener("online", () => { networkStatus(); sync(); });
window.addEventListener("offline", networkStatus);
if ("serviceWorker" in navigator) {
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register("/mobile/sw.js", { type: "module" });
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "OUTBOX_UPDATED") void render();
    });
  } catch { /* Offline reporting still works without service-worker support. */ }
}
applyLocale(); await render(); if (navigator.onLine) await sync();
