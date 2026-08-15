import type { EmergencyEnvelope } from "../protocol/types.ts";
import type { DeliveryAcknowledgement } from "./transport.ts";

export function createPeerAcknowledgement(
  issuerId: string,
  envelope: EmergencyEnvelope,
  acknowledgedAt = envelope.lastForwardedAt ?? Date.now(),
): DeliveryAcknowledgement {
  return {
    acknowledgementId: `peer:${issuerId}:${envelope.packetId}:${acknowledgedAt}`,
    eventId: envelope.report.eventId,
    packetId: envelope.packetId,
    level: "PEER",
    acknowledgedAt,
    issuerId,
    status: "CUSTODY_ACCEPTED",
  };
}

export function createBackendAcknowledgement(
  issuerId: string,
  envelope: EmergencyEnvelope,
  acknowledgedAt: number,
  duplicate: boolean,
): DeliveryAcknowledgement {
  return {
    acknowledgementId: `backend:${issuerId}:${envelope.report.eventId}:${acknowledgedAt}`,
    eventId: envelope.report.eventId,
    packetId: envelope.packetId,
    level: "BACKEND",
    acknowledgedAt,
    issuerId,
    status: duplicate ? "DUPLICATE" : "STORED",
  };
}
