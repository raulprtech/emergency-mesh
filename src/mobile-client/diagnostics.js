const STATES = ["CREATED", "QUEUED", "FORWARDED", "GATEWAY_FOUND", "SYNCED", "EXPIRED"];
const countStates = items => Object.fromEntries([...STATES, "UNKNOWN"].map(state => [state,
  items.filter(item => state === "UNKNOWN" ? !STATES.includes(item.state) : item.state === state).length]));
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const megabytes = value => Number.isFinite(value) && value >= 0 ? Math.round(value / 1_048_576) : null;

/** Allowlisted aggregate output only. No payloads, identities, URLs, tokens or raw errors. */
export async function collectDiagnostics(store, options = {}) {
  const now = options.now ?? Date.now(); const nav = options.navigator ?? globalThis.navigator;
  const result = { version: 1, kind: "COLUVI_CLIENT_DIAGNOSTIC", generatedAt: now,
    secureContext: options.secureContext ?? globalThis.isSecureContext === true,
    browserNetworkHint: nav?.onLine === true ? "ONLINE_HINT" : nav?.onLine === false ? "OFFLINE_HINT" : "UNKNOWN",
    offlineShellControlled: Boolean(nav?.serviceWorker?.controller),
    storage: { database: "UNAVAILABLE", usageMiB: null, quotaMiB: null, persistent: null },
    server: { status: "NOT_PROBED", checkedAt: null },
    outbox: null, receipts: null, lastBackendConfirmationAt: null,
    limits: ["Browser online hint does not prove server reachability", "Confirmation does not mean human attention or help", "Storage estimates cover this origin, not only Coluvi", "Counts are a local snapshot; other tabs may change them"] };
  try {
    const [items, receipts] = await Promise.all([store.list(), store.listReceipts()]);
    result.storage.database = "READABLE";
    const confirmations = items.filter(item => item.state === "SYNCED" && validTime(item.updatedAt)).map(item => item.updatedAt);
    result.lastBackendConfirmationAt = confirmations.length ? Math.max(...confirmations) : null;
    result.outbox = { total: items.length, states: countStates(items),
      awaitingConfirmation: items.filter(item => !["SYNCED", "EXPIRED"].includes(item.state)).length,
      retryScheduled: items.filter(item => !["SYNCED", "EXPIRED"].includes(item.state) && validTime(item.nextAttemptAt) && item.nextAttemptAt > now).length,
      lastAttemptFailed: items.filter(item => item.state !== "SYNCED" && Boolean(item.lastError)).length };
    result.receipts = { total: receipts.length, states: countStates(receipts) };
  } catch { /* Unreadable is not an empty queue. Never export the exception. */ }
  try {
    if (typeof nav?.storage?.estimate === "function") {
      const estimate = await nav.storage.estimate(); result.storage.usageMiB = megabytes(estimate.usage); result.storage.quotaMiB = megabytes(estimate.quota);
    }
  } catch { /* Optional API; no write or permission request. */ }
  try { if (typeof nav?.storage?.persisted === "function") result.storage.persistent = Boolean(await nav.storage.persisted()); } catch { /* Unknown. */ }
  if (options.probe === true) {
    result.server.checkedAt = now;
    try {
      const response = await (options.fetcher ?? globalThis.fetch)("/health", { cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(3000) });
      const body = await response.json();
      result.server.status = response.ok && body.status === "ok" && body.protocolVersion === "0.1" ? "REACHABLE" : "UNEXPECTED_RESPONSE";
    } catch { result.server.status = "UNREACHABLE_OR_TLS_ERROR"; }
  }
  return result;
}

export function diagnosticRows(report, catalog, locale = "es") {
  const labels = catalog.diagnostics;
  const date = value => validTime(value) ? new Date(value).toLocaleString(locale === "es" ? "es-MX" : "en") : labels.unknown;
  return [
    [labels.generated, date(report.generatedAt)],
    [labels.network, labels[report.browserNetworkHint]],
    [labels.server, labels[report.server.status]],
    [labels.secure, report.secureContext ? labels.yes : labels.no],
    [labels.offlineShell, report.offlineShellControlled ? labels.yes : labels.no],
    [labels.database, report.storage.database === "READABLE" ? labels.readable : labels.unreadable],
    [labels.saved, report.outbox?.total ?? labels.unknown],
    [labels.pending, report.outbox?.awaitingConfirmation ?? labels.unknown],
    [labels.confirmed, report.outbox?.states.SYNCED ?? labels.unknown],
    [labels.expired, report.outbox?.states.EXPIRED ?? labels.unknown],
    [labels.retry, report.outbox?.retryScheduled ?? labels.unknown],
    [labels.failed, report.outbox?.lastAttemptFailed ?? labels.unknown],
    [labels.receipts, report.receipts ? report.receipts.total - report.receipts.states.SYNCED - report.receipts.states.EXPIRED : labels.unknown],
    [labels.lastConfirmation, date(report.lastBackendConfirmationAt)],
    [labels.storage, report.storage.usageMiB === null || report.storage.quotaMiB === null ? labels.unknown : `${report.storage.usageMiB} / ${report.storage.quotaMiB} MiB`],
    [labels.persistence, report.storage.persistent === null ? labels.unknown : report.storage.persistent ? labels.yes : labels.no],
  ];
}
