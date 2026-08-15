import { decodeCbor, encodeCbor } from "../protocol/cbor.ts";
import type { DeliveryAcknowledgement, EgressAdvertisement } from "./transport.ts";

export const CONTROL_PROTOCOL_VERSION = "0.1" as const;

export type RoutingControlMessage =
  | {
      kind: "ACK";
      controlVersion: typeof CONTROL_PROTOCOL_VERSION;
      senderNodeId: string;
      acknowledgement: DeliveryAcknowledgement;
    }
  | {
      kind: "EGRESS_ADVERTISEMENT";
      controlVersion: typeof CONTROL_PROTOCOL_VERSION;
      senderNodeId: string;
      advertisement: EgressAdvertisement;
      createdAt: number;
      validUntil: number;
      nonce: string;
    };

const ackLevels = ["PEER", "GATEWAY", "BACKEND"];
const ackStatuses = ["CUSTODY_ACCEPTED", "STORED", "DUPLICATE"];
const egressStates = ["UNKNOWN", "REPORTED", "CONFIRMED", "STALE"];

export function encodeControlMessage(message: RoutingControlMessage): Uint8Array {
  if (message.kind === "ACK") {
    const ack = message.acknowledgement;
    return encodeCbor([0, message.controlVersion, message.senderNodeId, ack.acknowledgementId, ack.eventId, ack.packetId, ack.level, ack.acknowledgedAt, ack.issuerId, ack.status]);
  }
  const advertisement = message.advertisement;
  return encodeCbor([
    1,
    message.controlVersion,
    message.senderNodeId,
    advertisement.state,
    advertisement.quality,
    advertisement.lastReportedAt ?? null,
    advertisement.lastConfirmedAt ?? null,
    advertisement.supportedTransports,
    advertisement.evidenceLevel ?? null,
    message.createdAt,
    message.validUntil,
    message.nonce,
  ]);
}

export function decodeControlMessage(bytes: Uint8Array, now?: number): RoutingControlMessage {
  const value = decodeCbor(bytes);
  if (!Array.isArray(value)) throw new Error("Control message must be a CBOR array");
  if (value[1] !== CONTROL_PROTOCOL_VERSION) throw new Error("Unsupported control protocol version");
  if (typeof value[2] !== "string" || !value[2]) throw new Error("Control senderNodeId is required");
  if (value[0] === 0) {
    if (value.length !== 10 || !ackLevels.includes(String(value[6])) || !ackStatuses.includes(String(value[9]))) throw new Error("Malformed ACK control message");
    if (![3, 4, 5, 8].every((index) => typeof value[index] === "string" && value[index].length > 0) || !Number.isFinite(Number(value[7]))) throw new Error("Invalid ACK fields");
    return {
      kind: "ACK",
      controlVersion: CONTROL_PROTOCOL_VERSION,
      senderNodeId: value[2],
      acknowledgement: {
        acknowledgementId: String(value[3]),
        eventId: String(value[4]),
        packetId: String(value[5]),
        level: value[6] as DeliveryAcknowledgement["level"],
        acknowledgedAt: Number(value[7]),
        issuerId: String(value[8]),
        status: value[9] as DeliveryAcknowledgement["status"],
      },
    };
  }
  if (value[0] === 1) {
    if (value.length !== 12 || !egressStates.includes(String(value[3]))) throw new Error("Malformed egress advertisement");
    const quality = Number(value[4]);
    const createdAt = Number(value[9]);
    const validUntil = Number(value[10]);
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new Error("Invalid egress quality");
    if (!Number.isFinite(createdAt) || !Number.isFinite(validUntil) || validUntil <= createdAt) throw new Error("Invalid egress validity window");
    if (!Array.isArray(value[7]) || !value[7].every((item) => typeof item === "string")) throw new Error("Invalid supported transports");
    if (value[8] !== null && !ackLevels.includes(String(value[8]))) throw new Error("Invalid egress evidence level");
    if (value[3] === "CONFIRMED" && (value[6] === null || (value[8] !== "GATEWAY" && value[8] !== "BACKEND"))) throw new Error("Confirmed egress requires gateway or backend evidence");
    if (typeof value[11] !== "string" || !value[11]) throw new Error("Egress nonce is required");
    if (now !== undefined && validUntil <= now) throw new Error("Egress advertisement is expired");
    return {
      kind: "EGRESS_ADVERTISEMENT",
      controlVersion: CONTROL_PROTOCOL_VERSION,
      senderNodeId: value[2],
      advertisement: {
        state: value[3] as EgressAdvertisement["state"],
        quality,
        lastReportedAt: value[5] === null ? undefined : Number(value[5]),
        lastConfirmedAt: value[6] === null ? undefined : Number(value[6]),
        supportedTransports: value[7] as string[],
        evidenceLevel: value[8] === null ? undefined : value[8] as DeliveryAcknowledgement["level"],
      },
      createdAt,
      validUntil,
      nonce: String(value[11]),
    };
  }
  throw new Error("Unknown control message kind");
}
