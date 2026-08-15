import type { EmergencyEnvelope } from "../protocol/types.ts";

export type EgressState = "UNKNOWN" | "REPORTED" | "CONFIRMED" | "STALE";
export type EnergyCost = "LOW" | "MEDIUM" | "HIGH";

export interface TransportCapabilities {
  approximateRangeMeters?: number;
  bandwidthBitsPerSecond?: number;
  latencyMs?: number;
  requiresInfrastructure: boolean;
  externalHardwareRequired: boolean;
  energyCost: EnergyCost;
  maximumPayloadSize: number;
  broadcast: boolean;
  bidirectional: boolean;
  canReachInternet: boolean;
}

export interface DeliveryAcknowledgement {
  acknowledgementId: string;
  eventId: string;
  packetId: string;
  level: "PEER" | "GATEWAY" | "BACKEND";
  acknowledgedAt: number;
  issuerId: string;
  status: "CUSTODY_ACCEPTED" | "STORED" | "DUPLICATE";
}

export interface EgressAdvertisement {
  state: EgressState;
  quality: number;
  lastReportedAt?: number;
  lastConfirmedAt?: number;
  supportedTransports: string[];
  evidenceLevel?: DeliveryAcknowledgement["level"];
}

export interface SendResult {
  accepted: boolean;
  acknowledgement: "NONE" | "PEER" | "GATEWAY" | "BACKEND";
  detail?: string;
  evidence?: DeliveryAcknowledgement;
}

export interface TransportAdapter {
  readonly id: string;
  available(): boolean;
  capabilities(): TransportCapabilities;
  send(envelope: EmergencyEnvelope): Promise<SendResult>;
  receive(handler: (envelope: EmergencyEnvelope) => boolean | void | Promise<boolean | void>): () => void;
  estimatedCost(envelope: EmergencyEnvelope): number;
  estimatedEnergyCost(envelope: EmergencyEnvelope): number;
  maximumPayloadSize(): number;
  hasEgress(): boolean;
  egressQuality(): number;
  egressAdvertisement?(now?: number): EgressAdvertisement;
}
