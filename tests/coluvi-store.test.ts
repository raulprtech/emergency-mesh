import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ColuviStore } from "../src/commands/store.ts";
import { authorityFor, createCheckinCommand } from "../src/commands/authority.ts";
import { createDeviceIdentityFromSeed } from "../src/protocol/identity.ts";
import { createBrowserIdentity } from "../src/mobile-client/crypto.js";
import { createCheckinReceipt, createCheckinResponse, signColuviBrowserReport } from "../src/mobile-client/commands.js";
import { SqliteBackend } from "../src/backend/sqlite-backend.ts";
import { createOutboxItem } from "../src/mobile-client/core.js";
import { aggregateReports, PUBLIC_AGGREGATION_POLICY } from "../src/backend/aggregation.ts";

const now = 1_800_000_000_000;
const issuer = createDeviceIdentityFromSeed(new Uint8Array(32).fill(7));
const authority = authorityFor(issuer, ["north", "south"]);
const makeCommand = (commandId = "request-1", zoneId = "north") => createCheckinCommand(issuer, authority, {
  commandId, zoneId, incidentRef: "flood-drill", nonce: `nonce-${commandId}`, issuedAt: now, promptUntil: now + 60_000, responseUntil: now + 120_000,
});
const publicKey = (identity: Awaited<ReturnType<typeof createBrowserIdentity>>) => identity.publicKey;

test("issuance freezes recipients, scopes inbox, rejects replay and derives UNKNOWN only after deadline", async () => {
  const store = new ColuviStore(":memory:", [authority]);
  try {
    const a = await createBrowserIdentity(); const b = await createBrowserIdentity(); const later = await createBrowserIdentity();
    store.enroll(publicKey(a), "north", now); store.enroll(publicKey(b), "south", now);
    assert.equal(store.issue(makeCommand(), now), "ACCEPTED");
    store.enroll(publicKey(later), "north", now + 1);
    assert.equal(store.issue(makeCommand(), now + 1), "DUPLICATE");
    assert.equal(store.inbox(a.anonymousDeviceId, 0, 1, now).commands.length, 1);
    assert.equal(store.inbox(b.anonymousDeviceId, 0, 1, now).commands.length, 0);
    assert.equal(store.inbox(later.anonymousDeviceId, 0, 1, now).commands.length, 0);
    const page = store.inbox(a.anonymousDeviceId, 0, 1, now);
    assert.equal(store.inbox(a.anonymousDeviceId, page.cursor, 1, now).commands.length, 0);
    assert.throws(() => store.inbox(a.anonymousDeviceId, -1), /pagination/);
    assert.throws(() => store.inbox(a.anonymousDeviceId, 0, 101), /pagination/);
    assert.throws(() => store.enroll(publicKey(later), "south", now), /conflict/);
    assert.throws(() => store.enroll(publicKey(later), "unknown", now), /zone/);
    assert.equal(store.projection("request-1", now).counts.pending, 1);
    const overdue = store.projection("request-1", now + 60_000);
    assert.equal(overdue.counts.requested, 1);
    assert.equal(overdue.counts.unknown, 1);
    assert.equal(overdue.recipients[0].received, false);
    assert.equal(overdue.units, "devices");
    assert.throws(() => store.issue(createCheckinCommand(issuer, authority, {
      commandId: "request-2", zoneId: "north", incidentRef: "flood-drill", nonce: "nonce-request-1", issuedAt: now, promptUntil: now + 60_000, responseUntil: now + 120_000,
    }), now), /UNIQUE/);
    assert.equal(store.command("request-2"), undefined);
    assert.throws(() => store.issue(makeCommand(), now + 60_000), /unauthorized/);
  } finally { store.close(); }
});

test("offline responses survive restart, deduplicate, keep late history and preserve old reports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coluvi-store-"));
  const path = join(directory, "pilot.sqlite");
  let store: ColuviStore | undefined;
  try {
    const a = await createBrowserIdentity();
    const oldBackend = new SqliteBackend(path);
    const oldReport = await createOutboxItem({ action: "SAFE", eventId: "old-report" }, a, now);
    assert.equal(oldBackend.ingest(oldReport.envelope, now).status, "ACCEPTED");
    oldBackend.close();
    store = new ColuviStore(path, [authority]);
    store.enroll(publicKey(a), "north", now); store.issue(makeCommand(), now);
    const help = await createCheckinResponse(makeCommand(), "NEEDS_HELP", a, now + 10_000);
    const safe = await createCheckinResponse(makeCommand(), "SAFE", a, now + 20_000);
    assert.equal(store.acceptResponse(safe.envelope, now + 70_000).status, "ACCEPTED");
    // Older observations arriving later never regress the state.
    assert.equal(store.acceptResponse(help.envelope, now + 80_000).status, "ACCEPTED");
    assert.equal(store.acceptResponse(safe.envelope, now + 90_000).status, "DUPLICATE");
    const before = store.projection("request-1", now + 90_000);
    assert.equal(before.counts.responded, 1);
    assert.equal(before.counts.safe, 1); assert.equal(before.counts.needsHelp, 0);
    assert.equal(before.counts.late, 1); assert.equal(before.counts.unknown, 0);
    assert.equal(before.counts.received, 0); assert.equal(before.counts.shown, 0);
    assert.equal(before.recipients[0].history.length, 2);
    store.close(); store = new ColuviStore(path, [authority]);
    assert.deepEqual(store.projection("request-1", now + 90_000), before);
    assert.equal(store.acceptResponse(safe.envelope, now + 90_000).status, "DUPLICATE");
    assert.throws(() => store.acceptResponse(safe.envelope, now + 120_000), /expired/);
    const oldAgain = new SqliteBackend(path);
    assert.equal(oldAgain.size(), 1); assert.equal(oldAgain.get("old-report")?.eventId, "old-report"); oldAgain.close();
    assert.equal(store.prune(now + 120_000, 0), 1);
    assert.equal(store.listCommands().length, 0);
    assert.throws(() => store.prune(now, -1), /retention/);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("forged, unenrolled, wrong-scope, revoked, nonce-replayed and conflicting responses fail closed", async () => {
  const store = new ColuviStore(":memory:", [authority]);
  try {
    const a = await createBrowserIdentity(); const other = await createBrowserIdentity(); const south = await createBrowserIdentity();
    store.enroll(publicKey(a), "north", now); store.enroll(publicKey(south), "south", now); store.issue(makeCommand(), now);
    const response = await createCheckinResponse(makeCommand(), "SAFE", a, now + 1_000);
    const outsider = await createCheckinResponse(makeCommand(), "SAFE", other, now + 1_000);
    const wrongZone = await createCheckinResponse(makeCommand(), "SAFE", south, now + 1_000);
    assert.throws(() => store.acceptResponse(outsider.envelope, now + 2_000), /recipient/);
    assert.throws(() => store.acceptResponse(wrongZone.envelope, now + 2_000), /recipient/);
    assert.throws(() => store.acceptResponse({ ...response.envelope, report: { ...response.envelope.report, signature: undefined } }, now + 2_000), /unauthorized/);
    assert.throws(() => store.acceptResponse(response.envelope, now), /unauthorized/);
    store.acceptResponse(response.envelope, now + 2_000);
    const conflicting = await signColuviBrowserReport({ ...response.envelope.report, priority: "HIGH", extensions: { coluvi: { ...response.envelope.report.extensions.coluvi, status: "NEEDS_HELP" } } }, a);
    assert.throws(() => store.acceptResponse({ ...response.envelope, report: conflicting }, now + 2_000), /conflict/);
    const replay = await signColuviBrowserReport({ ...response.envelope.report, eventId: "another-event" }, a);
    assert.throws(() => store.acceptResponse({ ...response.envelope, report: replay }, now + 2_000), /UNIQUE/);
    assert.equal(store.projection("request-1", now + 2_000).counts.responded, 1);
    store.revokeParticipant(a.anonymousDeviceId, now + 3_000);
    assert.throws(() => store.acceptResponse(response.envelope, now + 4_000), /recipient/);
    assert.throws(() => store.inbox(a.anonymousDeviceId), /revoked/);
  } finally { store.close(); }
});

test("authority revocation on restart blocks pending command delivery and responses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coluvi-revocation-"));
  const path = join(directory, "private.sqlite");
  let store = new ColuviStore(path, [authority]);
  try {
    const a = await createBrowserIdentity(); store.enroll(publicKey(a), "north", now); store.issue(makeCommand(), now);
    const response = await createCheckinResponse(makeCommand(), "SAFE", a, now + 1_000);
    store.close(); store = new ColuviStore(path, [{ ...authority, revoked: true }]);
    assert.equal(store.inbox(a.anonymousDeviceId, 0, 50, now + 2_000).commands.length, 0);
    assert.throws(() => store.acceptResponse(response.envelope, now + 2_000), /unauthorized/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("operational packets cannot affect public suppression, counts, geography or needs", async () => {
  const a = await createBrowserIdentity();
  const responses = await Promise.all(Array.from({ length: 3 }, () => createCheckinResponse(makeCommand(), "NEEDS_HELP", a, now + 1_000)));
  const result = aggregateReports([makeCommand(), ...responses.map((item) => item.envelope.report)], PUBLIC_AGGREGATION_POLICY, now + 2_000);
  assert.deepEqual(result.areas, []); assert.equal(result.privacy.suppressedGroups, 0);
});

test("participant capacity and SQLite integrity are explicit and bounded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coluvi-capacity-"));
  const path = join(directory, "private.sqlite");
  const store = new ColuviStore(path, [authority], 1);
  try {
    const a = await createBrowserIdentity(); const b = await createBrowserIdentity();
    store.enroll(publicKey(a), "north", now);
    assert.throws(() => store.enroll(publicKey(b), "north", now), /capacity/);
    assert.throws(() => store.enroll("bad", "north", now), /public key/);
    const database = new DatabaseSync(path, { readOnly: true });
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok"); database.close();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("receipt evidence is signed, scoped, deduplicated and distinct from response or human attention", async () => {
  const store = new ColuviStore(":memory:", [authority]);
  try {
    const a = await createBrowserIdentity(); store.enroll(publicKey(a), "north", now); store.issue(makeCommand(), now);
    const received = await createCheckinReceipt(makeCommand(), "RECEIVED", a, now + 1_000);
    const shown = await createCheckinReceipt(makeCommand(), "SHOWN", a, now + 2_000);
    assert.throws(() => store.acceptReceipt(received, "another-device", now + 3_000), /unauthorized/);
    assert.equal(store.acceptReceipt(received, a.anonymousDeviceId, now + 3_000), "ACCEPTED");
    assert.equal(store.acceptReceipt(received, a.anonymousDeviceId, now + 3_000), "DUPLICATE");
    const anotherReceived = await createCheckinReceipt(makeCommand(), "RECEIVED", a, now + 2_000);
    assert.equal(store.acceptReceipt(anotherReceived, a.anonymousDeviceId, now + 3_000), "DUPLICATE");
    const middle = store.projection("request-1", now + 3_000);
    assert.equal(middle.counts.received, 1); assert.equal(middle.counts.shown, 0); assert.equal(middle.counts.responded, 0);
    assert.equal(store.acceptReceipt(shown, a.anonymousDeviceId, now + 3_000), "ACCEPTED");
    assert.equal(store.projection("request-1", now + 60_000).counts.shown, 1);
    assert.equal(store.projection("request-1", now + 60_000).counts.unknown, 1);
    const forged = { ...shown, eventId: "changed" };
    assert.throws(() => store.acceptReceipt(forged, a.anonymousDeviceId, now + 3_000), /unauthorized/);
    const conflicting = await signColuviBrowserReport({ ...shown, extensions: { coluvi: { ...shown.extensions.coluvi, evidence: "RECEIVED" } } }, a);
    assert.throws(() => store.acceptReceipt(conflicting, a.anonymousDeviceId, now + 3_000), /conflict/);
    await assert.rejects(createCheckinReceipt(makeCommand(), "SHOWN", a, now + 60_000), /expired/);
    assert.throws(() => store.acceptReceipt(shown, a.anonymousDeviceId, now + 120_000), /unauthorized/);
  } finally { store.close(); }
});
