import {
  createProtectedRecipientKeyPair,
  openProtectedPayload,
  sealProtectedPayload,
  type ProtectedPayloadContext,
} from "../src/protocol/protected-payload.ts";

const now = Date.now();
const context: ProtectedPayloadContext = {
  protocolVersion: "0.1",
  eventId: crypto.randomUUID(),
  anonymousDeviceId: "demo-device",
  createdAt: now,
  validUntil: now + 60 * 60_000,
};
const recipient = createProtectedRecipientKeyPair("demo-authorized-service");
const protectedPayload = sealProtectedPayload({
  preciseLocation: { latitude: 19.432608, longitude: -99.133209, accuracyMeters: 8 },
  contact: { callback: "+52-000-000-0000" },
}, context, [recipient], now);

console.log(JSON.stringify({
  recipientId: recipient.recipientId,
  protectedPayloadBytes: Buffer.byteLength(protectedPayload),
  decryptedByAuthorizedRecipient: openProtectedPayload(protectedPayload, context, recipient),
}, null, 2));
