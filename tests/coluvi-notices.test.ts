import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceIdentityFromSeed, signReport } from "../src/protocol/identity.ts";
import { authorityFor, signColuviReport, verifyColuviReport } from "../src/commands/authority.ts";
import { createOperationalNotice, verifyAuthorizedNotice } from "../src/commands/notices.ts";
import { createBrowserIdentity } from "../src/mobile-client/crypto.js";
import { noticeErrors, noticeReceiptErrors, verifyNoticeForDevice, createNoticeReceipt } from "../src/mobile-client/notices.js";
import { aggregateReports, PUBLIC_AGGREGATION_POLICY } from "../src/backend/aggregation.ts";

const issuer = createDeviceIdentityFromSeed(new Uint8Array(32).fill(77));
const legacyAuthority = authorityFor(issuer, ["north"]);
const authority = { ...legacyAuthority, kinds: ["CHECKIN_REQUEST", "OPERATIONAL_NOTICE"] };
const now = 1_800_000_000_000;
const input = { noticeId: "notice-drill", incidentRef: "flood-drill", zoneId: "north", issuedAt: now, expiresAt: now + 60_000, sourceLabel: "Equipo de simulacro", title: "Revisión de conectividad", message: "SIMULACRO: conserve su reporte pendiente hasta recuperar conexión.", level: "INFORMATION" as const, nonce: "notice-nonce" };

test("operational notice requires separately provisioned kind, zone and active authority in both verifiers", async () => {
  assert.throws(() => createOperationalNotice(issuer, legacyAuthority, input), /unauthorized/);
  const report = createOperationalNotice(issuer, authority, input);
  assert.deepEqual(noticeErrors(report), []); assert.equal(verifyAuthorizedNotice(report, [authority], now), true);
  assert.equal(await verifyNoticeForDevice(report, [authority], "north", now), true);
  for (const trust of [[], [legacyAuthority], [{ ...authority, revoked: true }], [{ ...authority, zones: ["south"] }]]) {
    assert.equal(verifyAuthorizedNotice(report, trust, now), false); assert.equal(await verifyNoticeForDevice(report, trust, "north", now), false);
  }
  assert.equal(await verifyNoticeForDevice(report, [authority], "south", now), false);
  for (const at of [now - 1, input.expiresAt, input.expiresAt + 1]) {
    assert.equal(verifyAuthorizedNotice(report, [authority], at), false); assert.equal(await verifyNoticeForDevice(report, [authority], "north", at), false);
  }
});

test("notice text, expiry, simulation flag and both signature domains are immutable", async () => {
  const report = createOperationalNotice(issuer, authority, input);
  for (const patch of [{ message: "Alterado" }, { simulation: false }, { expiresAt: now + 1 }, { sourceLabel: "x".repeat(121) }, { title: " " }, { unexpected: "private" }]) {
    const altered = { ...report, extensions: { coluvi: { ...report.extensions!.coluvi as object, ...patch } } };
    assert.equal(verifyAuthorizedNotice(altered, [authority], now), false);
    assert.equal(await verifyNoticeForDevice(altered, [authority], "north", now), false);
  }
  const outerOnly = signReport({ ...report, extensions: { coluvi: { ...report.extensions!.coluvi as object, message: "Alterado con firma exterior válida" } } }, issuer);
  assert.equal(verifyAuthorizedNotice(outerOnly, [authority], now), false);
  const signedNonSimulation = signColuviReport({ ...report, extensions: { coluvi: { ...report.extensions!.coluvi as object, simulation: false } } }, issuer);
  assert.equal(verifyAuthorizedNotice(signedNonSimulation, [authority], now), false);
  assert.equal(verifyAuthorizedNotice({ ...report, shortMessage: "private" }, [authority], now), false);
  assert.equal(await verifyNoticeForDevice(null, [authority], "north", now), false);
});

test("notice received and shown receipts bind the original notice and expire without asserting human attention", async () => {
  const notice = createOperationalNotice(issuer, authority, input); const device = await createBrowserIdentity();
  for (const evidence of ["RECEIVED", "SHOWN"]) {
    const receipt = await createNoticeReceipt(notice, evidence, device, now + 1);
    assert.deepEqual(noticeReceiptErrors(receipt, notice), []); assert.equal(verifyColuviReport(receipt), true);
    assert.equal(receipt.relatedEventId, notice.eventId); assert.equal(receipt.validUntil, notice.validUntil);
    assert.ok(noticeReceiptErrors({ ...receipt, relatedEventId: "another-notice" }, notice).length);
    assert.ok(noticeReceiptErrors({ ...receipt, observedAt: input.expiresAt }, notice).length);
  }
  await assert.rejects(createNoticeReceipt(notice, "ATTENDED", device, now + 1), /Invalid/);
  await assert.rejects(createNoticeReceipt(notice, "SHOWN", device, input.expiresAt), /expired/);
  assert.deepEqual(aggregateReports([notice], PUBLIC_AGGREGATION_POLICY, now).areas, []);
});
