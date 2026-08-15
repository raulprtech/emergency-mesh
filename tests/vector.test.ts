import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { serializeEnvelope } from "../src/protocol/codec.ts";
import { createDeviceIdentityFromSeed, signReport } from "../src/protocol/identity.ts";
import type { EmergencyEnvelope, EmergencyReport } from "../src/protocol/types.ts";

type Vector = {
  seedHex: string;
  anonymousDeviceId: string;
  signatureBase64Url: string;
  envelopeCborHex: string;
};

test("published v0.1 Ed25519 and CBOR vector remains byte-for-byte stable", () => {
  const vector = JSON.parse(readFileSync(new URL("../examples/protocol-vector-v0.1.json", import.meta.url), "utf8")) as Vector;
  const identity = createDeviceIdentityFromSeed(Buffer.from(vector.seedHex, "hex"));
  assert.equal(identity.anonymousDeviceId, vector.anonymousDeviceId);
  const unsigned: EmergencyReport = {
    protocolVersion: "0.1",
    eventId: "00000000-0000-4000-8000-000000000001",
    eventType: "PERSON_LAST_SEEN",
    reportMode: "LAST_SEEN",
    priority: "HIGH",
    createdAt: 1_700_000_000_000,
    observedAt: 1_699_999_700_000,
    validUntil: 1_700_086_400_000,
    location: { latitude: 19.4326, longitude: -99.1332, accuracyMeters: 120, timestamp: 1_699_999_700_000, source: "APPROXIMATE", zoneId: "mx-cdmx-demo" },
    peopleAffected: 1,
    shortMessage: "Vista cerca del refugio",
    anonymousDeviceId: identity.anonymousDeviceId,
    subject: { pseudonymousId: "subject-vector-1", ageRange: "ADULT" },
    nonce: "00000000-0000-4000-8000-000000000002",
    trustMetadata: { level: "UNASSESSED", corroborationCount: 0 },
  };
  const report = signReport(unsigned, identity);
  assert.equal(report.signature?.value, vector.signatureBase64Url);
  const envelope: EmergencyEnvelope = {
    packetId: "00000000-0000-4000-8000-000000000003",
    report,
    expiresAt: 1_700_086_400_000,
    hopCount: 0,
    hopLimit: 12,
    transportHistory: [],
  };
  assert.equal(Buffer.from(serializeEnvelope(envelope)).toString("hex"), vector.envelopeCborHex);
});
