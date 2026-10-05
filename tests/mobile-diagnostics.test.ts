import assert from "node:assert/strict";
import test from "node:test";
import { collectDiagnostics, diagnosticRows } from "../src/mobile-client/diagnostics.js";
import { getCatalog } from "../src/mobile-client/i18n.js";
import { mobileAsset } from "../src/mobile-client/assets.ts";

test("diagnostics export only allowlisted aggregates, distinguish saved/pending/confirmed and never probe implicitly", async () => {
  const secret = "PRIVATE-DATA-DO-NOT-EXPORT"; const now = 100_000;
  const items = [
    { state: "QUEUED", eventId: secret, lastError: secret, nextAttemptAt: now + 1, envelope: { text: secret, latitude: 23 } },
    { state: "SYNCED", updatedAt: now - 100, anonymousDeviceId: secret, token: secret },
    { state: "EXPIRED", lastError: secret }, { state: "FORWARDED" }, { state: "arbitrary-" + secret },
  ];
  const store = { list: async () => items, listReceipts: async () => [{ state: "QUEUED", report: { message: secret } }, { state: "SYNCED" }] };
  let calls = 0;
  const report = await collectDiagnostics(store, { now, secureContext: true, navigator: { onLine: true, serviceWorker: { controller: {} }, storage: {
    estimate: async () => ({ usage: 1_048_576, quota: 10_485_760, secret }), persisted: async () => false,
  } }, fetcher: async () => { calls++; throw new Error(secret); } });
  assert.equal(calls, 0); assert.equal(report.server.status, "NOT_PROBED");
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(report.outbox?.total, 5); assert.equal(report.outbox?.awaitingConfirmation, 3); assert.equal(report.outbox?.states.SYNCED, 1);
  assert.equal(report.outbox?.retryScheduled, 1); assert.equal(report.outbox?.states.UNKNOWN, 1);
  assert.equal(report.lastBackendConfirmationAt, now - 100);
  assert.deepEqual(report.storage, { database: "READABLE", usageMiB: 1, quotaMiB: 10, persistent: false });
  for (const locale of ["es", "en"]) {
    const rows = diagnosticRows(report, getCatalog(locale), locale); assert.equal(rows.length, 16);
    for (const [label, value] of rows) { assert.ok(label); assert.notEqual(value, undefined); }
  }
  assert.ok(mobileAsset("/mobile/diagnostics.js"));
});

test("unreadable storage stays unknown, optional browser APIs cannot disguise failure as an empty queue", async () => {
  const report = await collectDiagnostics({ list: async () => { throw new Error("private"); }, listReceipts: async () => [] }, {
    navigator: { onLine: false, storage: { estimate: async () => { throw new Error("private"); }, persisted: async () => { throw new Error("private"); } } }, secureContext: false,
  });
  assert.equal(report.storage.database, "UNAVAILABLE"); assert.equal(report.outbox, null); assert.equal(report.receipts, null);
  assert.equal(report.storage.persistent, null); assert.equal(report.browserNetworkHint, "OFFLINE_HINT");
  assert.equal(JSON.stringify(report).includes("private"), false);
});

test("explicit diagnostic probe omits credentials and cache and handles untrusted server output without exporting it", async () => {
  const store = { list: async () => [], listReceipts: async () => [] };
  for (const mode of ["ok", "bad", "fail"]) {
    const report = await collectDiagnostics(store, { probe: true, navigator: {}, fetcher: async (url: string, options: any) => {
      assert.equal(url, "/health"); assert.equal(options.credentials, "omit"); assert.equal(options.cache, "no-store"); assert.equal(options.redirect, "error"); assert.ok(options.signal);
      if (mode === "fail") throw new Error("secret");
      return { ok: mode === "ok", json: async () => ({ status: "ok", protocolVersion: "0.1", arbitrarySecret: "secret" }) };
    } });
    assert.equal(report.server.status, mode === "ok" ? "REACHABLE" : mode === "bad" ? "UNEXPECTED_RESPONSE" : "UNREACHABLE_OR_TLS_ERROR");
    assert.equal(JSON.stringify(report).includes("secret"), false);
  }
});
