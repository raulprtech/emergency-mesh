import assert from "node:assert/strict";
import test from "node:test";
import { serializeEnvelope, deserializeEnvelope } from "../src/protocol/codec.ts";
import { createDeviceIdentity, signReport, verifyReportSignature } from "../src/protocol/identity.ts";
import {
  MAX_PROTECTED_RECIPIENTS,
  createProtectedRecipientKeyPair,
  openProtectedPayload,
  protectedPayloadContext,
  sealProtectedPayload,
  validateProtectedPayloadFormat,
  validateProtectedRecipients,
} from "../src/protocol/protected-payload.ts";
import { validateReport, type EmergencyReport } from "../src/protocol/types.ts";
import { sealBrowserProtectedPayload } from "../src/mobile-client/protected.js";

const now = 1_800_000_000_000;
const context = {
  protocolVersion: "0.1",
  eventId: "protected-event",
  anonymousDeviceId: "anonymous-device",
  createdAt: now,
  validUntil: now + 60_000,
};
const sensitive = {
  preciseLocation: { latitude: 19.432608, longitude: -99.133209, accuracyMeters: 8 },
  contact: { phone: "+52-555-000-0000" },
};

test("authorized X25519 recipients decrypt the same protected payload", () => {
  const first = createProtectedRecipientKeyPair("medical-coordination");
  const second = createProtectedRecipientKeyPair("search-and-rescue");
  const payload = sealProtectedPayload(sensitive, context, [second, first], now);
  assert.deepEqual(openProtectedPayload(payload, context, first), sensitive);
  assert.deepEqual(openProtectedPayload(payload, context, second), sensitive);
  assert.deepEqual(validateProtectedPayloadFormat(payload), []);
  assert.doesNotMatch(payload, /555-000-0000/);
});

test("payload authentication binds ciphertext to report context and recipient", () => {
  const recipient = createProtectedRecipientKeyPair();
  const outsider = createProtectedRecipientKeyPair();
  const payload = sealProtectedPayload(sensitive, context, [recipient], now);
  assert.throws(() => openProtectedPayload(payload, { ...context, eventId: "transplanted-event" }, recipient), /authentication failed/);
  assert.throws(() => openProtectedPayload(payload, context, outsider), /not authorized/);
  const replacement = payload.endsWith("A") ? "B" : "A";
  assert.throws(() => openProtectedPayload(payload.slice(0, -1) + replacement, context, recipient));
});

test("recipient policy rejects ambiguous, inactive, expired, and excessive key sets", () => {
  const recipient = createProtectedRecipientKeyPair();
  assert.match(validateProtectedRecipients([{ ...recipient, recipientId: "x25519:wrong" }], now).join(" "), /does not match/);
  assert.match(validateProtectedRecipients([{ ...recipient, status: "REVOKED" }], now).join(" "), /not active/);
  assert.match(validateProtectedRecipients([{ ...recipient, notAfter: now }], now).join(" "), /expired/);
  assert.match(validateProtectedRecipients(Array.from({ length: MAX_PROTECTED_RECIPIENTS + 1 }, (_, index) => ({ ...createProtectedRecipientKeyPair(), purpose: String(index) })), now).join(" "), /at most/);
});

test("browser Web Crypto sealing interoperates with Node decryption", async () => {
  const recipient = createProtectedRecipientKeyPair("browser-test");
  const payload = await sealBrowserProtectedPayload(sensitive, context, [recipient], now);
  assert.deepEqual(openProtectedPayload(payload, context, recipient), sensitive);
});

test("protected payload remains opaque through envelope CBOR and is covered by report signature", () => {
  const identity = createDeviceIdentity();
  const recipient = createProtectedRecipientKeyPair();
  const unsigned: EmergencyReport = {
    ...context,
    anonymousDeviceId: identity.anonymousDeviceId,
    eventType: "SOS",
    reportMode: "SELF",
    priority: "CRITICAL",
    observedAt: now,
    nonce: "protected-nonce",
  };
  unsigned.protectedPayload = sealProtectedPayload(sensitive, protectedPayloadContext(unsigned), [recipient], now);
  const report = signReport(unsigned, identity);
  const envelope = { packetId: "protected-packet", report, expiresAt: report.validUntil, hopCount: 0, hopLimit: 4 };
  const decoded = deserializeEnvelope(serializeEnvelope(envelope));
  assert.equal(decoded.report.protectedPayload, report.protectedPayload);
  assert.equal(verifyReportSignature(decoded.report), true);
  assert.deepEqual(openProtectedPayload(decoded.report.protectedPayload!, protectedPayloadContext(decoded.report), recipient), sensitive);
  assert.equal(verifyReportSignature({ ...decoded.report, protectedPayload: decoded.report.protectedPayload + "A" }), false);
});

test("report validation fails closed for malformed or oversized protected payload strings", () => {
  const base = { ...context, eventType: "SOS", reportMode: "SELF", priority: "CRITICAL", observedAt: now, nonce: "n" } as EmergencyReport;
  assert.match(validateReport({ ...base, protectedPayload: "plaintext-secret" }).join(" "), /format/);
  assert.match(validateReport({ ...base, protectedPayload: `emesh-protected-v1:${"A".repeat(33_000)}` }).join(" "), /size/);
});
