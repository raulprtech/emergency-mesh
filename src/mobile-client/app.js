import { ACTIONS, createOutboxItem, validateClientInput } from "./core.js";
import { OUTBOX_SYNC_TAG, synchronizeOutboxExclusively } from "./background-sync.js";
import { createBrowserIdentity, createUnsignedIdentity } from "./crypto.js";
import { openClientDatabase } from "./idb.js";
import { formatMessage, getCatalog, normalizeLocale } from "./i18n.js";
import { currentEnrollment, enrollPilot, markCheckinShown, pollInbox, respondToCheckin, synchronizeReceipts } from "./inbox.js";
import { verifyCommandForDevice } from "./commands.js";

window.addEventListener("CLIENT_DATABASE_BLOCKED", () => {
  document.getElementById("pilot-status").textContent = getCatalog(navigator.language).databaseBlocked;
});
const db = await openClientDatabase();
let identity = await db.getSetting("identity");
let locale = normalizeLocale(await db.getSetting("locale") ?? navigator.language);
let catalog = getCatalog(locale);
let pendingLocation;
let serviceWorkerRegistration;
let composerTrigger;
let pilotBusy = false;
let pilotTimer;
let shownObserver;
let inboxRenderedKey;

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
  await renderInbox();
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
  identity = await newIdentity(); await db.replaceIdentity(identity); await render();
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
void refreshPilot();

async function requirePrivateSafeWorker() {
  if (!("serviceWorker" in navigator)) return;
  const worker = navigator.serviceWorker.controller ?? serviceWorkerRegistration?.active;
  if (!worker) throw new Error(catalog.pilotWorkerUpdate);
  await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error(catalog.pilotWorkerUpdate)); }, 3_000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer); channel.port1.close();
      event.data?.cache === "emergency-mesh-mobile-v8" && event.data?.privateApiCache === false ? resolve() : reject(new Error(catalog.pilotWorkerUpdate));
    };
    worker.postMessage({ type: "COLUVI_CACHE_VERSION" }, [channel.port2]);
  });
}

async function renderInbox() {
  const enrollment = await currentEnrollment(db, identity);
  const list = byId("inbox-list");
  const focused = document.activeElement;
  const focusCommand = focused?.closest?.("[data-command-id]")?.dataset.commandId;
  const focusStatus = focused?.dataset?.checkinStatus;
  byId("pilot-refresh").disabled = pilotBusy || !enrollment;
  const label = !enrollment ? (identity.mode === "ED25519" ? catalog.pilotNotEnrolled : catalog.pilotUnsigned)
    : !navigator.onLine ? catalog.pilotOffline : formatMessage(catalog.pilotEnrolled, { zone: enrollment.zoneId });
  if (byId("pilot-status").textContent !== label) byId("pilot-status").textContent = label;
  if (!enrollment) { shownObserver?.disconnect(); inboxRenderedKey = undefined; if (list.children.length) list.replaceChildren(); return; }
  const now = Date.now();
  const records = [];
  for (const record of await db.listCommands()) {
    if (record.deviceId !== identity.anonymousDeviceId || record.report.createdAt > now
      || !await verifyCommandForDevice(record.report, enrollment.trust.authorities, enrollment.zoneId, record.report.createdAt, true)) continue;
    records.push({ record, saved: record.responseEventId ? await db.get(record.responseEventId) : undefined });
  }
  const key = JSON.stringify([locale, identity.anonymousDeviceId, enrollment.trust, records.map(({ record, saved }) => [record.commandId, record.report.signature.value, record.responseEventId, record.responseStatus, saved?.state, record.report.extensions.coluvi.promptUntil <= now])]);
  // Keep stable DOM/focus and avoid repeated aria-live prompt announcements on polling.
  if (inboxRenderedKey === key) return;
  inboxRenderedKey = key;
  shownObserver?.disconnect(); list.replaceChildren();
  shownObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || document.visibilityState !== "visible") continue;
      shownObserver.unobserve(entry.target);
      void markCheckinShown(db, identity, entry.target.dataset.commandId).catch(() => {});
    }
  }, { threshold: 0.25 }) : undefined;
  for (const { record, saved } of records) {
    const command = record.report.extensions.coluvi;
    const article = document.createElement("article"); article.className = "checkin-item"; article.dataset.commandId = record.commandId; article.tabIndex = -1;
    const title = document.createElement("h3"); title.textContent = catalog.pilotQuestion;
    const detail = document.createElement("p"); detail.textContent = `${command.incidentRef} · ${command.zoneId}`;
    const deadline = document.createElement("p"); deadline.className = "meta";
    deadline.textContent = formatMessage(catalog.pilotDeadline, { time: new Date(command.promptUntil).toLocaleString(locale === "es" ? "es-MX" : "en") });
    article.append(title, detail, deadline);
    if (record.responseEventId) {
      const state = document.createElement("p");
      state.textContent = formatMessage(catalog.pilotSaved, { status: record.responseStatus === "SAFE" ? catalog.pilotSafe : catalog.pilotNeedsHelp, delivery: catalog.states[saved?.state] ?? catalog.states.QUEUED });
      article.append(state);
    } else if (command.promptUntil <= now) {
      const expired = document.createElement("p"); expired.textContent = catalog.pilotExpired; article.append(expired);
    } else {
      const actions = document.createElement("div"); actions.className = "checkin-actions";
      for (const status of ["SAFE", "NEEDS_HELP"]) {
        const button = document.createElement("button"); button.type = "button"; button.dataset.checkinStatus = status;
        button.className = status === "SAFE" ? "safe" : "assistance"; button.textContent = status === "SAFE" ? catalog.pilotSafe : catalog.pilotNeedsHelp;
        button.setAttribute("aria-label", `${button.textContent} · ${command.incidentRef}`);
        button.addEventListener("click", async () => {
          actions.querySelectorAll("button").forEach((item) => { item.disabled = true; });
          try {
            await respondToCheckin(db, identity, record.commandId, status);
            await scheduleBackgroundSync(); await render();
            [...list.children].find((item) => item.dataset.commandId === record.commandId)?.focus();
            if (navigator.onLine) { await sync(); await refreshPilot(); }
          } catch { byId("pilot-status").textContent = catalog.pilotResponseFailed; actions.querySelectorAll("button").forEach((item) => { item.disabled = false; }); }
        });
        actions.append(button);
      }
      article.append(actions);
    }
    list.append(article);
    if (record.shownAt === undefined && command.promptUntil > now) shownObserver?.observe(article);
    if (focusCommand === record.commandId && focusStatus) article.querySelector(`[data-checkin-status="${focusStatus}"]`)?.focus();
  }
  if (!list.children.length) { const empty = document.createElement("p"); empty.textContent = catalog.pilotEmpty; list.append(empty); }
}

async function refreshPilot() {
  clearTimeout(pilotTimer);
  if (pilotBusy) return;
  // Acquire before the first IndexedDB await: online/manual/timer calls can overlap.
  pilotBusy = true;
  let nextDelay = 10_000;
  let enrolled = false;
  try {
    const enrollment = await currentEnrollment(db, identity);
    enrolled = Boolean(enrollment);
    byId("pilot-refresh").disabled = true;
    if (enrollment && navigator.onLine && document.visibilityState === "visible") {
      await requirePrivateSafeWorker();
      await db.pruneInbox();
      const result = await pollInbox(db, identity);
      await synchronizeReceipts(db, identity);
      await render();
      if (result.rejected) byId("pilot-status").textContent = formatMessage(catalog.pilotRejected, { count: result.rejected });
      if (result.hasMore) nextDelay = 1_000;
    } else if (document.visibilityState === "visible") await renderInbox();
  } catch (error) {
    nextDelay = error.retryAfterMs ?? 30_000;
    byId("pilot-status").textContent = navigator.onLine ? catalog.pilotFailed : catalog.pilotOffline;
  } finally {
    pilotBusy = false;
    byId("pilot-refresh").disabled = !enrolled;
    pilotTimer = setTimeout(() => { void refreshPilot(); }, nextDelay);
  }
}

byId("pilot-enrollment-form").addEventListener("submit", async (event) => {
  event.preventDefault(); byId("pilot-enroll").disabled = true;
  try {
    await requirePrivateSafeWorker();
    const file = byId("pilot-trust-file").files[0];
    if (!file || file.size > 16_384) throw new Error("Invalid trust file");
    await enrollPilot(db, identity, { trust: JSON.parse(await file.text()), fingerprint: byId("pilot-fingerprint").value.trim(), zoneId: byId("pilot-zone").value.trim(), code: byId("pilot-code").value }, location.origin);
    event.target.reset(); byId("pilot-setup").open = false; await render(); await refreshPilot();
  } catch (error) { byId("pilot-status").textContent = error.message === catalog.pilotWorkerUpdate ? catalog.pilotWorkerUpdate : catalog.pilotEnrollmentFailed; }
  finally { byId("pilot-code").value = ""; byId("pilot-enroll").disabled = false; }
});
byId("pilot-refresh").addEventListener("click", () => { void refreshPilot(); });
window.addEventListener("online", () => { void refreshPilot(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { void renderInbox(); void refreshPilot(); } });
