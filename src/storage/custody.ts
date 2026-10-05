import type { EmergencyEnvelope } from "../protocol/types.ts";
import type { DeliveryAcknowledgement } from "../transports/transport.ts";

/** Queue acceptance and acknowledgement persistence must be one atomic action. */
export interface CustodyAcceptanceStore {
  acceptCustody(
    envelope: EmergencyEnvelope,
    issuerId: string,
    acknowledgedAt?: number,
  ): DeliveryAcknowledgement | undefined;
  custodyReceipt(eventId: string, packetId: string, now?: number): DeliveryAcknowledgement | undefined;
  pruneCustody(now?: number): number;
}
