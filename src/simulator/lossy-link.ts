import { serializeEnvelope } from "../protocol/codec.ts";
import type { EmergencyEnvelope } from "../protocol/types.ts";
import type { SendResult, TransportAdapter, TransportCapabilities } from "../transports/transport.ts";
import { createPeerAcknowledgement } from "../transports/ack.ts";
import type { RandomSource } from "./random.ts";

type Receiver = (envelope: EmergencyEnvelope) => boolean | void | Promise<boolean | void>;

export class LossyLinkAdapter implements TransportAdapter {
  readonly id: string;
  private enabled = true;
  private receiver?: Receiver;
  private readonly random: RandomSource;
  private readonly lossRate: number;
  private readonly mtu: number;

  constructor(id: string, random: RandomSource, options: { lossRate?: number; maximumPayloadSize?: number } = {}) {
    this.id = id;
    this.random = random;
    this.lossRate = options.lossRate ?? 0;
    this.mtu = options.maximumPayloadSize ?? 4_096;
    if (this.lossRate < 0 || this.lossRate > 1) throw new Error("lossRate must be between 0 and 1");
  }
  connect(receiver: Receiver): void { this.receiver = receiver; }
  setAvailable(value: boolean): void { this.enabled = value; }
  available(): boolean { return this.enabled && Boolean(this.receiver); }
  capabilities(): TransportCapabilities {
    return { approximateRangeMeters: 100, bandwidthBitsPerSecond: 32_000, latencyMs: 250, requiresInfrastructure: false, externalHardwareRequired: false, energyCost: "LOW", maximumPayloadSize: this.mtu, broadcast: true, bidirectional: true, canReachInternet: false };
  }
  async send(envelope: EmergencyEnvelope): Promise<SendResult> {
    if (!this.available() || !this.receiver) return { accepted: false, acknowledgement: "NONE", detail: "link unavailable" };
    if (serializeEnvelope(envelope).length > this.mtu) return { accepted: false, acknowledgement: "NONE", detail: "payload exceeds MTU" };
    if (this.random.next() < this.lossRate) return { accepted: false, acknowledgement: "NONE", detail: "simulated packet loss" };
    const received = await this.receiver(structuredClone(envelope));
    return received === false
      ? { accepted: false, acknowledgement: "NONE", detail: "peer queue rejected packet" }
      : { accepted: true, acknowledgement: "PEER", evidence: createPeerAcknowledgement(this.id, envelope) };
  }
  receive(): () => void { return () => undefined; }
  estimatedCost(): number { return 0; }
  estimatedEnergyCost(): number { return 1; }
  maximumPayloadSize(): number { return this.mtu; }
  hasEgress(): boolean { return false; }
  egressQuality(): number { return 0; }
}
