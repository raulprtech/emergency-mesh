import { serializeEnvelope } from "../protocol/codec.ts";
import type { EmergencyEnvelope } from "../protocol/types.ts";
import { createPeerAcknowledgement } from "./ack.ts";
import type { SendResult, TransportAdapter, TransportCapabilities } from "./transport.ts";

type Receiver = (envelope: EmergencyEnvelope) => boolean | void | Promise<boolean | void>;

export class MockTransportAdapter implements TransportAdapter {
  readonly id: string;
  private readonly config: Partial<TransportCapabilities>;
  private enabled = true;
  private peer?: Receiver;
  private handlers = new Set<Receiver>();

  constructor(id: string, config: Partial<TransportCapabilities> = {}) {
    this.id = id;
    this.config = config;
  }

  connect(receiver: Receiver): void { this.peer = receiver; }
  setAvailable(available: boolean): void { this.enabled = available; }
  available(): boolean { return this.enabled && Boolean(this.peer); }
  capabilities(): TransportCapabilities {
    return {
      approximateRangeMeters: 100,
      bandwidthBitsPerSecond: 64_000,
      latencyMs: 100,
      requiresInfrastructure: false,
      externalHardwareRequired: false,
      energyCost: "LOW",
      maximumPayloadSize: 4_096,
      broadcast: true,
      bidirectional: true,
      canReachInternet: false,
      ...this.config,
    };
  }
  async send(envelope: EmergencyEnvelope): Promise<SendResult> {
    if (!this.available() || !this.peer) return { accepted: false, acknowledgement: "NONE", detail: "link unavailable" };
    if (serializeEnvelope(envelope).length > this.maximumPayloadSize()) {
      return { accepted: false, acknowledgement: "NONE", detail: "payload exceeds MTU" };
    }
    const received = await this.peer(structuredClone(envelope));
    return received === false
      ? { accepted: false, acknowledgement: "NONE", detail: "peer queue rejected packet" }
      : { accepted: true, acknowledgement: "PEER", evidence: createPeerAcknowledgement(this.id, envelope) };
  }
  receive(handler: Receiver): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async inject(envelope: EmergencyEnvelope): Promise<void> {
    for (const handler of this.handlers) await handler(structuredClone(envelope));
  }
  estimatedCost(): number { return 0; }
  estimatedEnergyCost(): number { return this.capabilities().energyCost === "LOW" ? 1 : 2; }
  maximumPayloadSize(): number { return this.capabilities().maximumPayloadSize; }
  hasEgress(): boolean { return this.capabilities().canReachInternet; }
  egressQuality(): number { return this.hasEgress() ? 0.5 : 0; }
}
