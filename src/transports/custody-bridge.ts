import { fragmentEnvelope, FragmentReassembler, type ReassemblyOptions } from "../protocol/fragmentation.ts";
import type { EmergencyEnvelope } from "../protocol/types.ts";
import { createPeerAcknowledgement } from "./ack.ts";
import { CONTROL_PROTOCOL_VERSION, decodeControlMessage, encodeControlMessage } from "./control.ts";
import type { RawFramePort, RawFrameReceipt } from "./raw-frame-port.ts";
import type {
  DeliveryAcknowledgement,
  SendResult,
  TransportAdapter,
  TransportCapabilities,
} from "./transport.ts";

type Receiver = (envelope: EmergencyEnvelope) => boolean | void | Promise<boolean | void>;

export interface CustodyBridgeOptions {
  localNodeId: string;
  peerNodeId: string;
  peerAddress: string;
  acknowledgementTimeoutMs?: number;
  acceptedCacheTtlMs?: number;
  maxAcceptedCacheEntries?: number;
  maximumClockSkewMs?: number;
  reassembly?: ReassemblyOptions;
  capabilities?: Partial<TransportCapabilities>;
  now?: () => number;
}

interface PendingSend {
  resolve: (result: SendResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AcceptedPacket {
  acknowledgement: DeliveryAcknowledgement;
  expiresAt: number;
}

function packetKey(eventId: string, packetId: string): string {
  return `${eventId}\u0000${packetId}`;
}

/**
 * Reference bridge from Emergency Mesh envelopes to a peer-addressed raw-frame
 * port. Physical routing ACKs are ignored for custody: send() succeeds only
 * after the remote bridge reassembles and its receiver accepts the envelope.
 */
export class CustodyBridgeTransportAdapter implements TransportAdapter {
  readonly id: string;
  private readonly port: RawFramePort;
  private readonly options: Required<Omit<CustodyBridgeOptions, "reassembly" | "capabilities">>;
  private readonly capabilityOverrides: Partial<TransportCapabilities>;
  private readonly reassembler: FragmentReassembler;
  private readonly handlers = new Set<Receiver>();
  private readonly pending = new Map<string, PendingSend>();
  private readonly accepted = new Map<string, AcceptedPacket>();
  private readonly unsubscribePort: () => void;
  private disposed = false;

  constructor(id: string, port: RawFramePort, options: CustodyBridgeOptions) {
    if (!id) throw new Error("custody bridge id is required");
    if (!options.localNodeId || !options.peerNodeId || !options.peerAddress) {
      throw new Error("custody bridge requires localNodeId, peerNodeId, and peerAddress");
    }
    this.id = id;
    this.port = port;
    this.options = {
      localNodeId: options.localNodeId,
      peerNodeId: options.peerNodeId,
      peerAddress: options.peerAddress,
      acknowledgementTimeoutMs: options.acknowledgementTimeoutMs ?? 5 * 60_000,
      acceptedCacheTtlMs: options.acceptedCacheTtlMs ?? 24 * 60 * 60_000,
      maxAcceptedCacheEntries: options.maxAcceptedCacheEntries ?? 1_024,
      maximumClockSkewMs: options.maximumClockSkewMs ?? 5 * 60_000,
      now: options.now ?? Date.now,
    };
    if (!Number.isInteger(this.options.acknowledgementTimeoutMs) || this.options.acknowledgementTimeoutMs < 1) {
      throw new Error("acknowledgementTimeoutMs must be positive");
    }
    if (!Number.isInteger(this.options.acceptedCacheTtlMs) || this.options.acceptedCacheTtlMs < 1) {
      throw new Error("acceptedCacheTtlMs must be positive");
    }
    if (!Number.isInteger(this.options.maxAcceptedCacheEntries) || this.options.maxAcceptedCacheEntries < 1) {
      throw new Error("maxAcceptedCacheEntries must be positive");
    }
    if (!Number.isInteger(this.options.maximumClockSkewMs) || this.options.maximumClockSkewMs < 0) {
      throw new Error("maximumClockSkewMs must be a non-negative integer");
    }
    const mtu = port.capabilities().maximumFrameBytes;
    this.reassembler = new FragmentReassembler({ ...options.reassembly, maxFrameBytes: mtu });
    this.capabilityOverrides = options.capabilities ?? {};
    this.unsubscribePort = port.receiveFrame((receipt) => this.handleReceipt(receipt));
  }

  available(): boolean { return !this.disposed && this.port.available(); }

  capabilities(): TransportCapabilities {
    const physical = this.port.capabilities();
    return {
      requiresInfrastructure: false,
      externalHardwareRequired: true,
      energyCost: "MEDIUM",
      maximumPayloadSize: physical.maximumFrameBytes,
      broadcast: false,
      bidirectional: physical.bidirectional,
      canReachInternet: false,
      ...this.capabilityOverrides,
      maximumPayloadSize: physical.maximumFrameBytes,
      broadcast: false,
      bidirectional: physical.bidirectional,
    };
  }

  async send(envelope: EmergencyEnvelope): Promise<SendResult> {
    if (!this.available()) return { accepted: false, acknowledgement: "NONE", detail: "physical port unavailable" };
    if (!this.port.capabilities().bidirectional) {
      return { accepted: false, acknowledgement: "NONE", detail: "custody bridge requires a bidirectional port" };
    }
    const key = packetKey(envelope.report.eventId, envelope.packetId);
    if (this.pending.has(key)) return { accepted: false, acknowledgement: "NONE", detail: "packet is already awaiting custody ACK" };
    let frames: Uint8Array[];
    try { frames = fragmentEnvelope(envelope, this.maximumPayloadSize()); }
    catch (error) {
      return { accepted: false, acknowledgement: "NONE", detail: error instanceof Error ? error.message : "fragmentation failed" };
    }
    const expectedAcknowledgement = encodeControlMessage({
      kind: "ACK",
      controlVersion: CONTROL_PROTOCOL_VERSION,
      senderNodeId: this.options.peerNodeId,
      acknowledgement: createPeerAcknowledgement(this.options.peerNodeId, envelope, this.options.now()),
    });
    if (expectedAcknowledgement.length > this.maximumPayloadSize()) {
      return { accepted: false, acknowledgement: "NONE", detail: "custody ACK exceeds physical frame limit" };
    }


    let settle: (result: SendResult) => void = () => undefined;
    const result = new Promise<SendResult>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => {
      if (!this.pending.delete(key)) return;
      settle({ accepted: false, acknowledgement: "NONE", detail: "remote custody ACK timed out" });
    }, this.options.acknowledgementTimeoutMs);
    this.pending.set(key, { resolve: settle, timer });

    for (let index = 0; index < frames.length && this.pending.has(key); index += 1) {
      let sent;
      try {
        sent = await this.port.sendFrame(frames[index], {
          destination: this.options.peerAddress,
          requestRoutingAck: true,
        });
      } catch (error) {
        this.failPending(key, error instanceof Error ? error.message : "physical frame send failed");
        break;
      }
      if (!sent.acceptedByLocalPort) {
        this.failPending(key, sent.detail ?? `physical port rejected frame ${index + 1}/${frames.length}`);
        break;
      }
    }
    return result;
  }

  receive(handler: Receiver): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  estimatedCost(): number { return 0; }

  estimatedEnergyCost(envelope: EmergencyEnvelope): number {
    try { return Math.max(1, fragmentEnvelope(envelope, this.maximumPayloadSize()).length * 0.25); }
    catch { return Number.MAX_SAFE_INTEGER; }
  }

  maximumPayloadSize(): number { return this.port.capabilities().maximumFrameBytes; }
  hasEgress(): boolean { return false; }
  egressQuality(): number { return 0; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribePort();
    for (const [key] of this.pending) this.failPending(key, "custody bridge disposed");
    this.handlers.clear();
    this.accepted.clear();
  }

  private failPending(key: string, detail: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    pending.resolve({ accepted: false, acknowledgement: "NONE", detail });
  }

  private async handleReceipt(receipt: RawFrameReceipt): Promise<void> {
    if (this.disposed || receipt.source !== this.options.peerAddress) return;
    if (!(receipt.payload instanceof Uint8Array) || receipt.payload.length === 0 || receipt.payload.length > this.maximumPayloadSize()) return;
    if (this.handleAcknowledgement(receipt)) return;
    const reassembled = this.reassembler.ingestEnvelope(receipt.payload, this.options.now());
    if (reassembled.status !== "COMPLETE" || !reassembled.envelope) return;
    const envelope = reassembled.envelope;
    const key = packetKey(envelope.report.eventId, envelope.packetId);
    this.pruneAccepted();
    const prior = this.accepted.get(key);
    if (prior) {
      await this.sendAcknowledgement(prior.acknowledgement, receipt.source);
      return;
    }
    if (this.handlers.size === 0) return;
    let custodyAccepted = true;
    for (const handler of this.handlers) {
      try {
        if (await handler(structuredClone(envelope)) === false) custodyAccepted = false;
      } catch {
        custodyAccepted = false;
      }
    }
    if (!custodyAccepted) return;
    const acknowledgement = createPeerAcknowledgement(this.options.localNodeId, envelope, this.options.now());
    this.rememberAccepted(key, acknowledgement, envelope.expiresAt);
    await this.sendAcknowledgement(acknowledgement, receipt.source);
  }

  private handleAcknowledgement(receipt: RawFrameReceipt): boolean {
    let message;
    try { message = decodeControlMessage(receipt.payload); }
    catch { return false; }
    if (message.kind !== "ACK") return true;
    const acknowledgement = message.acknowledgement;
    if (
      message.senderNodeId !== this.options.peerNodeId
      || acknowledgement.issuerId !== this.options.peerNodeId
      || acknowledgement.level !== "PEER"
      || (acknowledgement.status !== "CUSTODY_ACCEPTED" && acknowledgement.status !== "DUPLICATE")
      || acknowledgement.acknowledgedAt > this.options.now() + this.options.maximumClockSkewMs
    ) return true;
    const key = packetKey(acknowledgement.eventId, acknowledgement.packetId);
    const pending = this.pending.get(key);
    if (!pending) return true;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    pending.resolve({
      accepted: true,
      acknowledgement: "PEER",
      detail: "remote bridge accepted custody after reassembly",
      evidence: structuredClone(acknowledgement),
    });
    return true;
  }

  private async sendAcknowledgement(acknowledgement: DeliveryAcknowledgement, destination: string): Promise<void> {
    const frame = encodeControlMessage({
      kind: "ACK",
      controlVersion: CONTROL_PROTOCOL_VERSION,
      senderNodeId: this.options.localNodeId,
      acknowledgement,
    });
    if (frame.length > this.maximumPayloadSize()) return;
    try { await this.port.sendFrame(frame, { destination, requestRoutingAck: true }); }
    catch { /* Custody remains remote; sender will retry when its ACK times out. */ }
  }

  private rememberAccepted(key: string, acknowledgement: DeliveryAcknowledgement, envelopeExpiresAt: number): void {
    this.pruneAccepted();
    while (this.accepted.size >= this.options.maxAcceptedCacheEntries) {
      const oldest = this.accepted.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.accepted.delete(oldest);
    }
    this.accepted.set(key, {
      acknowledgement: structuredClone(acknowledgement),
      expiresAt: Math.min(envelopeExpiresAt, this.options.now() + this.options.acceptedCacheTtlMs),
    });
  }

  private pruneAccepted(): void {
    const now = this.options.now();
    for (const [key, value] of this.accepted) if (value.expiresAt <= now) this.accepted.delete(key);
  }
}
