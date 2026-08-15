import { serializeEnvelope } from "../src/protocol/codec.ts";
import { canonicalReportBytes, createDeviceIdentityFromSeed, signReport } from "../src/protocol/identity.ts";
import type { EmergencyEnvelope, EmergencyReport } from "../src/protocol/types.ts";

const identity = createDeviceIdentityFromSeed(Uint8Array.from({ length: 32 }, (_, index) => index));
const unsigned: EmergencyReport = {
  protocolVersion: "0.1",
  eventId: "00000000-0000-4000-8000-000000000001",
  eventType: "PERSON_LAST_SEEN",
  reportMode: "LAST_SEEN",
  priority: "HIGH",
  createdAt: 1_700_000_000_000,
  observedAt: 1_699_999_700_000,
  validUntil: 1_700_086_400_000,
  location: {
    latitude: 19.4326,
    longitude: -99.1332,
    accuracyMeters: 120,
    timestamp: 1_699_999_700_000,
    source: "APPROXIMATE",
    zoneId: "mx-cdmx-demo",
  },
  peopleAffected: 1,
  shortMessage: "Vista cerca del refugio",
  anonymousDeviceId: identity.anonymousDeviceId,
  subject: { pseudonymousId: "subject-vector-1", ageRange: "ADULT" },
  nonce: "00000000-0000-4000-8000-000000000002",
  trustMetadata: { level: "UNASSESSED", corroborationCount: 0 },
};
const report = signReport(unsigned, identity);
const envelope: EmergencyEnvelope = {
  packetId: "00000000-0000-4000-8000-000000000003",
  report,
  expiresAt: 1_700_086_400_000,
  hopCount: 0,
  hopLimit: 12,
  transportHistory: [],
};

console.log(JSON.stringify({
  vectorVersion: 1,
  seedHex: Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("hex"),
  anonymousDeviceId: identity.anonymousDeviceId,
  unsignedReportCborHex: Buffer.from(canonicalReportBytes(unsigned)).toString("hex"),
  signatureBase64Url: report.signature?.value,
  envelopeCborHex: Buffer.from(serializeEnvelope(envelope)).toString("hex"),
  envelope,
}, null, 2));
