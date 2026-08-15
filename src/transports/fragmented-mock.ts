import { fragmentEnvelope, FragmentReassembler, type ReassemblyOptions } from "../protocol/fragmentation.ts";
import type { EmergencyEnvelope } from "../protocol/types.ts";
import { createPeerAcknowledgement } from "./ack.ts";
import type { SendResult, TransportAdapter, TransportCapabilities } from "./transport.ts";

type Receiver = (envelope: EmergencyEnvelope) => boolean | void | Promise<boolean | void>;

export interface FragmentedMockOptions {
  maximumPayloadSize?: number;
  capabilities?: Partial<TransportCapabilities>;
  reassembly?: ReassemblyOptions;
  deliverFrame?: (frame: Uint8Array, index: number, attempt: number) => boolean | Promise<boolean>;
  now?: () => number;
}

/** Reference frame transport. PEER custody is claimed only after full reassembly and receiver acceptance. */
export class FragmentedMockTransportAdapter implements TransportAdapter {
  readonly id: string;
  readonly reassembler: FragmentReassembler;
  private readonly mtu: number;
  private readonly config: Partial<TransportCapabilities>;
  private readonly deliverFrame: NonNullable<FragmentedMockOptions["deliverFrame"]>;
  private readonly now: () => number;
  private enabled = true;
  private peer?: Receiver;
  private handlers = new Set<Receiver>();
  private attempt = 0;

  constructor(id: string, options: FragmentedMockOptions = {}) {
    this.id = id;
    this.mtu = options.maximumPayloadSize ?? 256;
    this.config = options.capabilities ?? {};
    this.deliverFrame = options.deliverFrame ?? (() => true);
    this.now = options.now ?? Date.now;
    this.reassembler = new FragmentReassembler({ ...options.reassembly, maxFrameBytes: this.mtu });
  }

  connect(receiver: Receiver): void { this.peer = receiver; }
  setAvailable(available: boolean): void { this.enabled = available; }
  available(): boolean { return this.enabled && Boolean(this.peer); }
  capabilities(): TransportCapabilities {
    return {
      approximateRangeMeters: 50,
      bandwidthBitsPerSecond: 8_000,
      latencyMs: 300,
      requiresInfrastructure: false,
      externalHardwareRequired: false,
      energyCost: "MEDIUM",
      maximumPayloadSize: this.mtu,
      broadcast: false,
      bidirectional: true,
      canReachInternet: false,
      ...this.config,
      maximumPayloadSize: this.mtu,
    };
  }

  async send(envelope: EmergencyEnvelope): Promise<SendResult> {
    if (!this.available() || !this.peer) return { accepted: false, acknowledgement: "NONE", detail: "link unavailable" };
    let frames: Uint8Array[];
    try { frames = fragmentEnvelope(envelope, this.mtu); }
    catch (error) { return { accepted: false, acknowledgement: "NONE", detail: error instanceof Error ? error.message : "fragmentation failed" }; }
    const attempt = ++this.attempt;
    let completed: EmergencyEnvelope | undefined;
    for (let index = 0; index < frames.length; index += 1) {
      if (!await this.deliverFrame(frames[index], index, attempt)) {
        return { accepted: false, acknowledgement: "NONE", detail: `frame ${index + 1}/${frames.length} not delivered` };
      }
      const outcome = this.reassembler.ingestEnvelope(frames[index], this.now());
      if (outcome.status === "REJECTED") return { accepted: false, acknowledgement: "NONE", detail: outcome.error };
      if (outcome.status === "COMPLETE") completed = outcome.envelope;
    }
    if (!completed) return { accepted: false, acknowledgement: "NONE", detail: "peer has not completed reassembly" };
    const received = await this.peer(structuredClone(completed));
    if (received === false) return { accepted: false, acknowledgement: "NONE", detail: "peer queue rejected reassembled packet" };
    return {
      accepted: true,
      acknowledgement: "PEER",
      detail: `reassembled from ${frames.length} frame${frames.length === 1 ? "" : "s"}`,
      evidence: createPeerAcknowledgement(this.id, envelope),
    };
  }

  receive(handler: Receiver): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  async inject(envelope: EmergencyEnvelope): Promise<void> { for (const handler of this.handlers) await handler(structuredClone(envelope)); }
  estimatedCost(): number { return 0; }
  estimatedEnergyCost(envelope: EmergencyEnvelope): number {
    try { return Math.max(1, fragmentEnvelope(envelope, this.mtu).length * 0.25); }
    catch { return Number.MAX_SAFE_INTEGER; }
  }
  maximumPayloadSize(): number { return this.mtu; }
  hasEgress(): boolean { return false; }
  egressQuality(): number { return 0; }
}
