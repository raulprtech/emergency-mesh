import { serializeEnvelope } from "../protocol/codec.ts";
import type { EmergencyEnvelope } from "../protocol/types.ts";
import type { Gateway } from "../gateway/gateway.ts";
import type { EgressAdvertisement, SendResult, TransportAdapter, TransportCapabilities } from "./transport.ts";
import { createBackendAcknowledgement } from "./ack.ts";
import { EgressTracker } from "./egress.ts";

export class InternetAdapter implements TransportAdapter {
  readonly id: string;
  private readonly gateway: Gateway;
  private readonly now: () => number;
  private readonly tracker: EgressTracker;
  private online = false;
  constructor(id: string, gateway: Gateway, now: () => number = Date.now) { this.id = id; this.gateway = gateway; this.now = now; this.tracker = new EgressTracker([id]); }
  setOnline(online: boolean): void { this.online = online; if (online) this.tracker.report(0.9, this.now()); else this.tracker.disconnect(); }
  available(): boolean { if (this.online) this.tracker.report(0.9, this.now()); return this.online; }
  capabilities(): TransportCapabilities {
    return { bandwidthBitsPerSecond: 1_000_000, latencyMs: 100, requiresInfrastructure: true, externalHardwareRequired: false, energyCost: "MEDIUM", maximumPayloadSize: 64_000, broadcast: false, bidirectional: true, canReachInternet: true };
  }
  async send(envelope: EmergencyEnvelope): Promise<SendResult> {
    if (!this.online) return { accepted: false, acknowledgement: "NONE", detail: "offline" };
    if (serializeEnvelope(envelope).length > this.maximumPayloadSize()) return { accepted: false, acknowledgement: "NONE", detail: "payload exceeds MTU" };
    const acknowledgedAt = this.now();
    const result = this.gateway.sync(envelope, acknowledgedAt);
    const accepted = result.status === "ACCEPTED" || result.status === "DUPLICATE";
    if (!accepted) return { accepted: false, acknowledgement: "NONE", detail: result.status };
    const evidence = createBackendAcknowledgement(this.id, envelope, acknowledgedAt, result.status === "DUPLICATE");
    this.tracker.confirm(evidence);
    return { accepted: true, acknowledgement: "BACKEND", detail: result.status, evidence };
  }
  receive(): () => void { return () => undefined; }
  estimatedCost(): number { return 0; }
  estimatedEnergyCost(): number { return 2; }
  maximumPayloadSize(): number { return this.capabilities().maximumPayloadSize; }
  hasEgress(): boolean { const state = this.tracker.advertisement(this.now()).state; return this.online && (state === "REPORTED" || state === "CONFIRMED"); }
  egressQuality(): number { return this.online ? this.tracker.advertisement(this.now()).quality : 0; }
  egressAdvertisement(now = this.now()): EgressAdvertisement { return this.tracker.advertisement(now); }
}
