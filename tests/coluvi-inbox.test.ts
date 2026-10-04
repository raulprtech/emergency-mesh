import assert from "node:assert/strict";
import test from "node:test";
import { verify } from "node:crypto";
import { MemoryClientStore, synchronizeOutbox } from "../src/mobile-client/core.js";
import { createBrowserIdentity } from "../src/mobile-client/crypto.js";
import { ColuviAuth, enrollmentCodeHash, enrollmentProofBytes, passwordVerifier } from "../src/commands/auth.ts";
import { authorityFor, authorityFingerprint, createCheckinCommand } from "../src/commands/authority.ts";
import { createDeviceIdentityFromSeed } from "../src/protocol/identity.ts";
import { currentEnrollment, enrollPilot, markCheckinShown, pollInbox, respondToCheckin, synchronizeReceipts, verifyPilotTrust, pollNotices, markNoticeShown } from "../src/mobile-client/inbox.js";
import { createOperationalNotice } from "../src/commands/notices.ts";

class PilotMemoryStore extends MemoryClientStore {
  settings = new Map<string, any>(); commands = new Map<string, any>(); receipts = new Map<string, any>();
  notices = new Map<string, any>();
  async getSetting(key: string) { return structuredClone(this.settings.get(key)); }
  async saveEnrollment(value: any) { if (this.settings.get("identity")?.anonymousDeviceId !== value.deviceId) throw new Error("Identity changed"); this.settings.set("coluviEnrollment", structuredClone(value)); }
  async updateInboxCursor(deviceId: string, token: string, cursor: number) {
    const value = this.settings.get("coluviEnrollment"); if (value?.deviceId !== deviceId || value.token !== token) throw new Error("Enrollment changed"); value.cursor = Math.max(value.cursor, cursor);
  }
  async getCommand(id: string) { return structuredClone(this.commands.get(id)); }
  async getNotice(id: string) { return structuredClone(this.notices.get(id)); }
  async updateNoticeCursor(deviceId: string, token: string, cursor: number) {
    const value = this.settings.get("coluviEnrollment"); if (value?.deviceId !== deviceId || value.token !== token) throw new Error("Enrollment changed"); value.noticeCursor = Math.max(value.noticeCursor ?? 0, cursor);
  }
  async receiveNotice(record: any, receipt: any, token: string) {
    const enrolled = this.settings.get("coluviEnrollment"); if (enrolled?.deviceId !== record.deviceId || enrolled.token !== token) throw new Error("Enrollment changed");
    const existing = this.notices.get(record.noticeId);
    if (existing) { if (existing.report.signature.value !== record.report.signature.value || existing.deviceId !== record.deviceId) throw new Error("Conflict"); return false; }
    this.notices.set(record.noticeId, structuredClone(record)); this.receipts.set(receipt.eventId, structuredClone(receipt)); return true;
  }
  async markNoticeShown(id: string, deviceId: string, receipt: any, at: number) {
    const row = this.notices.get(id); if (!row || row.deviceId !== deviceId) throw new Error("Unknown notice");
    if (row.shownAt !== undefined) return false; row.shownAt = at; this.receipts.set(receipt.eventId, structuredClone(receipt)); return true;
  }
  async receiveCommand(record: any, receipt: any) {
    const existing = this.commands.get(record.commandId);
    if (existing) { if (existing.report.signature.value !== record.report.signature.value || existing.deviceId !== record.deviceId) throw new Error("Conflict"); return false; }
    this.commands.set(record.commandId, structuredClone(record)); this.receipts.set(receipt.eventId, structuredClone(receipt)); return true;
  }
  async markCommandShown(id: string, deviceId: string, receipt: any, at: number) {
    const row = this.commands.get(id); if (!row || row.deviceId !== deviceId) throw new Error("Unknown command");
    if (row.shownAt !== undefined) return false; row.shownAt = at; this.receipts.set(receipt.eventId, structuredClone(receipt)); return true;
  }
  async queueCommandResponse(id: string, deviceId: string, item: any) {
    const row = this.commands.get(id); if (!row || row.deviceId !== deviceId) throw new Error("Unknown command");
    if (row.responseEventId) return false;
    this.items.set(item.eventId, structuredClone(item)); row.responseEventId = item.eventId; row.responseStatus = item.envelope.report.extensions.coluvi.status; return true;
  }
  async listReceipts() { return [...this.receipts.values()].map((item) => structuredClone(item)); }
  async putReceipt(receipt: any) { this.receipts.set(receipt.eventId, structuredClone(receipt)); }
}

const issuer = createDeviceIdentityFromSeed(new Uint8Array(32).fill(8)); const authority = authorityFor(issuer, ["north"]);
const origin = "https://pilot.test";
const trust = { version: 1, origin, authorities: [authority], fingerprint: authorityFingerprint(authority) };
const commandAt = (now: number, id = "checkin") => createCheckinCommand(issuer, authority, { commandId: id, incidentRef: "flood-drill", zoneId: "north", nonce: `nonce-${id}`, issuedAt: now, promptUntil: now + 60_000, responseUntil: now + 120_000 });
async function enrolledStore() {
  const store = new PilotMemoryStore(); const identity = await createBrowserIdentity(); store.settings.set("identity", identity);
  await store.saveEnrollment({ deviceId: identity.anonymousDeviceId, zoneId: "north", token: "fictitious-token", expiresAt: Date.now() + 24 * 60 * 60_000, trust, cursor: 0 });
  return { store, identity };
}
const page = (commands: any[], cursor = 1) => async () => ({ ok: true, json: async () => ({ commands, cursor, hasMore: false }) });

test("trust import requires independent matching fingerprint, origin, key-derived identity and authorized kind", async () => {
  assert.deepEqual(await verifyPilotTrust(trust, trust.fingerprint, origin), trust);
  await assert.rejects(verifyPilotTrust(trust, "0".repeat(64), origin), /fingerprint/);
  await assert.rejects(verifyPilotTrust(trust, trust.fingerprint, "https://other.test"));
  await assert.rejects(verifyPilotTrust({ ...trust, authorities: [{ ...authority, revoked: true }] }, trust.fingerprint, origin));
  await assert.rejects(verifyPilotTrust({ ...trust, authorities: [{ ...authority, issuerId: "other" }] }, trust.fingerprint, origin), /fingerprint/);
  await assert.rejects(verifyPilotTrust({ ...trust, authorities: [{ ...authority, kinds: ["SOS"] }] }, trust.fingerprint, origin));
});

test("browser enrollment proves possession, saves scoped credentials and rejects identity rotation race", async () => {
  const identity = await createBrowserIdentity(); const store = new PilotMemoryStore(); store.settings.set("identity", identity);
  const code = "fictitious-enrollment-code"; const auth = new ColuviAuth(await passwordVerifier("fictitious-password-for-test"), enrollmentCodeHash(code));
  let challenge;
  const fetcher = async (url: string, options: any) => {
    const input = JSON.parse(options.body);
    if (url.endsWith("/challenge")) { challenge = auth.challenge(input.code, input.publicKey, input.zoneId, ["north"], "test"); return { ok: true, json: async () => challenge }; }
    const completed = auth.complete(input.challengeId, input.signature);
    assert.equal(verify(null, enrollmentProofBytes(completed), { key: Buffer.from(identity.publicKey, "base64url"), type: "spki", format: "der" }, Buffer.from(input.signature, "base64url")), true);
    return { ok: true, json: async () => ({ deviceId: identity.anonymousDeviceId, zoneId: "north", token: "A".repeat(43), expiresAt: Date.now() + 7 * 24 * 60 * 60_000 }) };
  };
  const enrolled = await enrollPilot(store, identity, { trust, fingerprint: trust.fingerprint, zoneId: "north", code }, origin, fetcher);
  assert.equal(enrolled.cursor, 0); assert.deepEqual(await currentEnrollment(store, identity), enrolled);
  store.settings.set("identity", { anonymousDeviceId: "rotated" });
  await assert.rejects(enrollPilot(store, identity, { trust, fingerprint: trust.fingerprint, zoneId: "north", code }, origin, fetcher), /Identity changed/);
  assert.equal(await currentEnrollment(store, { mode: "UNSIGNED", anonymousDeviceId: identity.anonymousDeviceId }), undefined);
});

test("inbox persists before cursor, rejects forged commands, deduplicates receipt and shown evidence", async () => {
  const { store, identity } = await enrolledStore(); const now = Date.now(); const command = commandAt(now);
  const forged = { ...command, eventId: "forged" };
  const result = await pollInbox(store, identity, page([forged, command]), now);
  assert.deepEqual(result, { received: 1, rejected: 1, hasMore: false });
  assert.equal(store.commands.size, 1); assert.equal(store.receipts.size, 1);
  assert.equal((await currentEnrollment(store, identity)).cursor, 1);
  assert.equal((await pollInbox(store, identity, page([command]), now + 1)).received, 0);
  assert.equal(store.receipts.size, 1);
  assert.equal(await markCheckinShown(store, identity, command.eventId, now + 1), true);
  assert.equal(await markCheckinShown(store, identity, command.eventId, now + 2), false);
  assert.equal(store.receipts.size, 2);
});

test("offline check-in response is queued once, survives repeated clicks and needs correlated backend evidence", async () => {
  const { store, identity } = await enrolledStore(); const now = Date.now(); const command = commandAt(now);
  await pollInbox(store, identity, page([command]), now);
  const [first, second] = await Promise.all([respondToCheckin(store, identity, command.eventId, "NEEDS_HELP", now + 1), respondToCheckin(store, identity, command.eventId, "SAFE", now + 1)]);
  assert.equal(first.eventId, second.eventId); assert.equal((await store.list()).length, 1);
  await synchronizeOutbox(store, async () => { throw new Error("offline"); }, "/api/packets", now + 2);
  assert.equal((await store.get(first.eventId)).state, "QUEUED");
  await synchronizeOutbox(store, async () => ({ ok: true, json: async () => ({ status: "ACCEPTED", evidence: {
    acknowledgementId: "ack", eventId: first.eventId, packetId: first.envelope.packetId, level: "BACKEND", acknowledgedAt: now + 3, issuerId: "coluvi-backend", status: "STORED",
  } }) }), "/api/packets", now + 3);
  assert.equal((await store.get(first.eventId)).state, "SYNCED");
  assert.equal(first.envelope.report.location, undefined); assert.equal(first.envelope.report.eventType, "x-coluvi-checkin-response");
});

test("inbox clock skew retries without losing cursor and expiration never reactivates prompt", async () => {
  const { store, identity } = await enrolledStore(); const now = Date.now();
  await assert.rejects(pollInbox(store, identity, page([commandAt(now + 60_000)]), now), /clock/);
  assert.equal((await currentEnrollment(store, identity)).cursor, 0);
  const command = commandAt(now); await pollInbox(store, identity, page([command]), now);
  await assert.rejects(respondToCheckin(store, identity, command.eventId, "SAFE", now + 60_000), /expired/);
  assert.equal(await markCheckinShown(store, identity, command.eventId, now + 60_000), false);
  assert.equal((await store.list()).length, 0);
});

test("failed inbox custody never advances cursor or overwrites rotated enrollment", async () => {
  const { store, identity } = await enrolledStore(); const now = Date.now();
  store.receiveCommand = async () => { throw new Error("disk full"); };
  await assert.rejects(pollInbox(store, identity, page([commandAt(now)]), now), /disk full/);
  assert.equal((await currentEnrollment(store, identity)).cursor, 0);
  await assert.rejects(pollInbox(store, identity, async () => { store.settings.get("coluviEnrollment").token = "rotated-token"; return { ok: true, json: async () => ({ commands: [], cursor: 1, hasMore: false }) }; }, now), /Enrollment changed/);
  assert.equal((await currentEnrollment(store, identity)).token, "rotated-token");
  assert.equal((await currentEnrollment(store, identity)).cursor, 0);
});

test("receipt retries preserve offline custody, honor backoff, and expire without sending", async () => {
  const { store, identity } = await enrolledStore(); const now = Date.now(); await pollInbox(store, identity, page([commandAt(now)]), now);
  let calls = 0;
  await synchronizeReceipts(store, identity, async () => { calls += 1; throw new Error("offline"); }, now);
  const pending = (await store.listReceipts())[0]; assert.equal(pending.state, "QUEUED"); assert.equal(pending.attempts, 1);
  await synchronizeReceipts(store, identity, async () => { calls += 1; throw new Error("too early"); }, now + 1); assert.equal(calls, 1);
  await synchronizeReceipts(store, identity, async () => ({ ok: true, json: async () => ({ status: "DUPLICATE" }) }), pending.nextAttemptAt);
  assert.equal((await store.listReceipts())[0].state, "SYNCED");
  const another = commandAt(now, "second"); await pollInbox(store, identity, page([another], 2), now);
  await synchronizeReceipts(store, identity, async () => { throw new Error("must not send"); }, now + 120_000);
  assert.equal((await store.listReceipts()).find((receipt) => receipt.report.relatedEventId === "second").state, "EXPIRED");
});

const noticeAuthority = { ...authority, kinds: ["CHECKIN_REQUEST", "OPERATIONAL_NOTICE"] };
const noticeAt = (now: number, id = "notice") => createOperationalNotice(issuer, noticeAuthority, { noticeId: id, incidentRef: "drill", zoneId: "north", nonce: `nonce-${id}`, issuedAt: now, expiresAt: now + 60_000, sourceLabel: "Equipo ficticio", title: "Prueba", message: "SIMULACRO", level: "INFORMATION" });
const noticePage = (notices: any[], cursor = 1) => async () => ({ ok: true, json: async () => ({ notices, cursor, hasMore: false }) });
async function noticeStore() {
  const fixture = await enrolledStore(); fixture.store.settings.get("coluviEnrollment").trust.authorities = [noticeAuthority]; return fixture;
}

test("notice trust is explicit, receipt custody precedes cursor, and shown evidence is idempotent", async () => {
  const { store, identity } = await enrolledStore(); const now = Date.now(); const notice = noticeAt(now);
  let calls = 0;
  assert.deepEqual(await pollNotices(store, identity, async () => { calls++; throw new Error("must not bootstrap authority"); }, now), { received: 0, rejected: 0, hasMore: false }); assert.equal(calls, 0);
  const expandedTrust = { ...trust, authorities: [noticeAuthority] };
  assert.deepEqual(await verifyPilotTrust(expandedTrust, trust.fingerprint, origin), expandedTrust);
  store.settings.get("coluviEnrollment").trust = expandedTrust;
  assert.deepEqual(await pollNotices(store, identity, noticePage([{ ...notice, nonce: "tampered" }, notice]), now), { received: 1, rejected: 1, hasMore: false });
  assert.equal(store.notices.size, 1); assert.equal(store.receipts.size, 1); assert.equal(store.settings.get("coluviEnrollment").noticeCursor, 1);
  assert.equal(store.settings.get("coluviEnrollment").cursor, 0, "check-in cursor is independent");
  assert.equal((await pollNotices(store, identity, noticePage([notice]), now + 1)).received, 0); assert.equal(store.receipts.size, 1);
  assert.equal(await markNoticeShown(store, identity, notice.eventId, now + 1), true);
  assert.equal(await markNoticeShown(store, identity, notice.eventId, now + 2), false); assert.equal(store.receipts.size, 2);
  const second = noticeAt(now, "notice-2"); await pollNotices(store, identity, noticePage([second], 2), now);
  assert.equal(await markNoticeShown(store, identity, second.eventId, now + 60_000), false);
});

test("notice disk failure, future clock and credential rotation never lose the delivery cursor", async () => {
  const { store, identity } = await noticeStore(); const now = Date.now();
  await assert.rejects(pollNotices(store, identity, noticePage([noticeAt(now + 60_000)]), now), /clock/);
  assert.equal(store.settings.get("coluviEnrollment").noticeCursor, undefined);
  const receive = store.receiveNotice.bind(store); store.receiveNotice = async () => { throw new Error("disk full"); };
  await assert.rejects(pollNotices(store, identity, noticePage([noticeAt(now)]), now), /disk full/);
  assert.equal(store.settings.get("coluviEnrollment").noticeCursor, undefined); assert.equal(store.receipts.size, 0);
  store.receiveNotice = receive;
  await assert.rejects(pollNotices(store, identity, async () => { store.settings.get("coluviEnrollment").token = "rotated"; return noticePage([noticeAt(now)])(); }, now), /Enrollment changed/);
  assert.equal(store.notices.size, 0); assert.equal(store.settings.get("coluviEnrollment").noticeCursor, undefined);
});

test("synced receipt history cannot starve later notice receipts beyond the first 400 records", async () => {
  const { store, identity } = await noticeStore(); const now = Date.now();
  for (let i = 0; i < 401; i++) store.receipts.set(`old-${i}`, { eventId: `old-${i}`, state: "SYNCED", report: { anonymousDeviceId: identity.anonymousDeviceId } });
  await pollNotices(store, identity, noticePage([noticeAt(now)]), now);
  let calls = 0;
  const results = await synchronizeReceipts(store, identity, async () => { calls++; return { ok: true, json: async () => ({ status: "ACCEPTED" }) }; }, now + 1);
  assert.equal(calls, 1); assert.equal(results.length, 1); assert.equal(results[0].state, "SYNCED");
});
