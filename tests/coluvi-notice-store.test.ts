import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeviceIdentity } from "../src/protocol/identity.ts";
import { authorityFor, type ColuviAuthority } from "../src/commands/authority.ts";
import { ColuviStore } from "../src/commands/store.ts";
import { NoticeStore } from "../src/commands/notice-store.ts";
import { createOperationalNotice } from "../src/commands/notices.ts";
import { createBrowserIdentity } from "../src/mobile-client/crypto.js";
import { createNoticeReceipt } from "../src/mobile-client/notices.js";

const now = 1_800_000_000_000;
const issuer = createDeviceIdentity(); const authority = { ...authorityFor(issuer, ["north", "south"]), kinds: ["CHECKIN_REQUEST", "OPERATIONAL_NOTICE"] };
const notice = (id = "notice-1", nonce = id) => createOperationalNotice(issuer, authority, { noticeId: id, nonce, incidentRef: "flood-drill", zoneId: "north", issuedAt: now, expiresAt: now + 60_000, sourceLabel: "Equipo de simulacro", title: "Prueba de enlace", message: "SIMULACRO sin instrucciones reales.", level: "INFORMATION" });
async function fixture(run: (context: { participants: ColuviStore; notices: NoticeStore; reopen: (trust?: ColuviAuthority[]) => NoticeStore; path: string }) => Promise<void>) {
  const directory = mkdtempSync("/tmp/coluvi-notice-store-"); const path = join(directory, "private.sqlite");
  const participants = new ColuviStore(path, [authority]); let notices = new NoticeStore(path, [authority]);
  try { await run({ participants, notices, path, reopen: (trust = [authority]) => { notices.close(); notices = new NoticeStore(path, trust); return notices; } }); }
  finally { notices.close(); participants.close(); rmSync(directory, { recursive: true, force: true }); }
}

test("notice recipients are frozen by zone; cursor, duplicate issuance and expiry survive restart", async () => fixture(async ({ participants, notices, reopen }) => {
  const north = await createBrowserIdentity(); const south = await createBrowserIdentity(); const later = await createBrowserIdentity();
  participants.enroll(north.publicKey, "north", now); participants.enroll(south.publicKey, "south", now);
  assert.equal(notices.issue(notice(), now), "ACCEPTED"); assert.equal(notices.issue(notice(), now), "DUPLICATE");
  participants.enroll(later.publicKey, "north", now + 1);
  assert.deepEqual(notices.projection("notice-1").counts, { requested: 1, received: 0, shown: 0 });
  assert.equal(notices.inbox(south.anonymousDeviceId, 0, 50, now).notices.length, 0);
  assert.equal(notices.inbox(later.anonymousDeviceId, 0, 50, now).notices.length, 0);
  notices.issue(notice("notice-2"), now);
  const first = notices.inbox(north.anonymousDeviceId, 0, 1, now); assert.equal(first.notices[0].eventId, "notice-1"); assert.equal(first.hasMore, true);
  notices = reopen(); const second = notices.inbox(north.anonymousDeviceId, first.cursor, 1, now);
  assert.equal(second.notices[0].eventId, "notice-2"); assert.equal(second.hasMore, false);
  assert.equal(notices.inbox(north.anonymousDeviceId, 0, 50, now + 60_000).notices.length, 0);
  assert.equal(notices.list().length, 2);
  assert.throws(() => notices.issue(notice("notice-3", "notice-1"), now), /UNIQUE/);
  assert.throws(() => notices.inbox(north.anonymousDeviceId, -1, 50, now), /pagination/);
  assert.equal(notices.projection("notice-2", 0, 1).pagination.hasMore, true);
}));

test("notice receipts persist exactly once, reject cross-device and revoked submissions, and remain private", async () => fixture(async ({ participants, notices, reopen, path }) => {
  const device = await createBrowserIdentity(); const outsider = await createBrowserIdentity();
  participants.enroll(device.publicKey, "north", now); participants.enroll(outsider.publicKey, "south", now);
  const report = notice(); notices.issue(report, now);
  const received = await createNoticeReceipt(report, "RECEIVED", device, now + 1);
  const shown = await createNoticeReceipt(report, "SHOWN", device, now + 2);
  assert.throws(() => notices.acceptReceipt(received, outsider.anonymousDeviceId, now + 3), /unauthorized/);
  assert.throws(() => notices.acceptReceipt({ ...received, nonce: "altered" }, device.anonymousDeviceId, now + 3), /unauthorized/);
  assert.equal(notices.acceptReceipt(received, device.anonymousDeviceId, now + 3), "ACCEPTED");
  notices = reopen(); assert.equal(notices.acceptReceipt(received, device.anonymousDeviceId, now + 4), "DUPLICATE");
  assert.equal(notices.acceptReceipt(shown, device.anonymousDeviceId, now + 4), "ACCEPTED");
  assert.equal(notices.acceptReceipt(await createNoticeReceipt(report, "SHOWN", device, now + 5), device.anonymousDeviceId, now + 6), "DUPLICATE");
  assert.deepEqual(notices.projection(report.eventId).counts, { requested: 1, received: 1, shown: 1 });
  assert.throws(() => notices.acceptReceipt(received, device.anonymousDeviceId, now + 60_000), /unauthorized/);
  const other = await createNoticeReceipt(report, "RECEIVED", outsider, now + 1);
  assert.throws(() => notices.acceptReceipt(other, outsider.anonymousDeviceId, now + 2), /Unauthorized/);
  participants.revokeParticipant(device.anonymousDeviceId, now + 7);
  assert.throws(() => notices.inbox(device.anonymousDeviceId, 0, 50, now + 7), /revoked/);
  assert.throws(() => notices.acceptReceipt(received, device.anonymousDeviceId, now + 7), /Unauthorized/);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM coluvi_notice_receipts").get() as { n: number }).n, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM coluvi_commands").get() as { n: number }).n, 0);
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { db.close(); }
  assert.equal(notices.prune(now + 60_000, 1), 0); assert.equal(notices.prune(now + 60_001, 1), 1);
  assert.ok(participants.participant(device.anonymousDeviceId), "retention preserves enrollment and revocation");
}));

test("notice authority revocation or kind removal stops pending delivery after restart", async () => fixture(async ({ participants, notices, reopen }) => {
  const device = await createBrowserIdentity(); participants.enroll(device.publicKey, "north", now); const report = notice(); notices.issue(report, now);
  for (const trust of [[{ ...authority, revoked: true }], [{ ...authority, kinds: ["CHECKIN_REQUEST"] }]]) {
    notices = reopen(trust);
    assert.equal(notices.inbox(device.anonymousDeviceId, 0, 50, now + 1).notices.length, 0);
    assert.throws(() => notices.issue(report, now + 1), /unauthorized/);
  }
}));
