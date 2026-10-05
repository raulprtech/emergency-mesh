import {
  MESHTASTIC_BROADCAST_NODE,
  MESHTASTIC_DATA_PAYLOAD_BYTES,
  MESHTASTIC_PRIVATE_APP_PORT,
} from "./meshtastic-policy.ts";
import {
  validateRawFrameSend,
  type RawFramePort,
  type RawFramePortCapabilities,
  type RawFrameReceipt,
  type RawFrameSendOptions,
  type RawFrameSendResult,
} from "./raw-frame-port.ts";

export const MESHTASTIC_DEVICE_CONFIGURED = 7;
/** Backward-compatible name for the archived @meshtastic/core adapter. */
export const MESHTASTIC_CORE_DEVICE_CONFIGURED = MESHTASTIC_DEVICE_CONFIGURED;

export interface MeshtasticSubscription {
  unsubscribe(): void;
}

export interface MeshtasticEvent<T> {
  subscribe(handler: (value: T) => void): MeshtasticSubscription | (() => void) | void;
}

/** Structural subset of @meshtastic/core PacketMetadata<Uint8Array>. */
export interface MeshtasticPrivatePacket {
  id: number;
  type: "broadcast" | "direct";
  from: number;
  to: number;
  channel: number;
  data: Uint8Array;
}

/**
 * Structural subset shared by the active @meshtastic/sdk 1.0 MeshClient and
 * the archived published @meshtastic/core 2.6.7 MeshDevice. Injection keeps
 * GPL runtime packages outside the Apache-2.0 core dependency graph.
 */
export interface MeshtasticSdkClient {
  events: {
    onPrivatePacket: MeshtasticEvent<MeshtasticPrivatePacket>;
    onDeviceStatus?: MeshtasticEvent<number>;
  };
  sendPacket(
    data: Uint8Array,
    portNum: number,
    destination: number | "self" | "broadcast",
    channel?: number,
    wantAck?: boolean,
    wantResponse?: boolean,
    echoResponse?: boolean,
  ): Promise<number>;
}

/** Backward-compatible structural name for the archived published client. */
export type MeshtasticCoreClient = MeshtasticSdkClient;

export interface MeshtasticSdkFramePortOptions {
  channel?: number;
  initialAvailable?: boolean;
}

export interface MeshtasticSdkFramePortStats {
  sdkSendAttempts: number;
  routingAcknowledgedFrames: number;
  failedFrames: number;
  outboundBytesAttempted: number;
  inboundFrames: number;
  inboundBytes: number;
}

/** Backward-compatible options name. */
export type MeshtasticCoreFramePortOptions = MeshtasticSdkFramePortOptions;

function release(subscription: MeshtasticSubscription | (() => void) | void): void {
  if (typeof subscription === "function") subscription();
  else subscription?.unsubscribe();
}

export function meshtasticNodeAddress(nodeNumber: number): string {
  if (!Number.isSafeInteger(nodeNumber) || nodeNumber < 0 || nodeNumber > 0xffff_ffff) {
    throw new Error("Meshtastic node number must be an unsigned 32-bit integer");
  }
  return `!${nodeNumber.toString(16).padStart(8, "0")}`;
}

export function parseMeshtasticNodeAddress(address: string): number {
  if (!/^![0-9a-fA-F]{8}$/.test(address)) throw new Error("Meshtastic address must use !xxxxxxxx hexadecimal form");
  return Number.parseInt(address.slice(1), 16);
}

/**
 * PRIVATE_APP raw-frame port for compatible Meshtastic SDK clients. It is
 * intentionally unicast-only because sendPacket completion represents a
 * routing ACK while firmware suppresses ACK requests for broadcasts.
 */
export class MeshtasticSdkFramePort implements RawFramePort {
  readonly id: string;
  private readonly client: MeshtasticSdkClient;
  private readonly channel: number;
  private readonly handlers = new Set<(receipt: RawFrameReceipt) => void | Promise<void>>();
  private readonly privateSubscription: MeshtasticSubscription | (() => void) | void;
  private readonly statusSubscription: MeshtasticSubscription | (() => void) | void;
  private readonly statistics: MeshtasticSdkFramePortStats = {
    sdkSendAttempts: 0,
    routingAcknowledgedFrames: 0,
    failedFrames: 0,
    outboundBytesAttempted: 0,
    inboundFrames: 0,
    inboundBytes: 0,
  };
  private enabled: boolean;
  private disposed = false;

  constructor(id: string, client: MeshtasticSdkClient, options: MeshtasticSdkFramePortOptions = {}) {
    if (!id) throw new Error("Meshtastic frame port id is required");
    const channel = options.channel ?? 0;
    if (!Number.isInteger(channel) || channel < 0 || channel > 7) throw new Error("Meshtastic channel must be an integer from 0 to 7");
    this.id = id;
    this.client = client;
    this.channel = channel;
    this.enabled = options.initialAvailable ?? false;
    this.privateSubscription = client.events.onPrivatePacket.subscribe((packet) => { void this.handlePrivatePacket(packet); });
    this.statusSubscription = client.events.onDeviceStatus?.subscribe((status) => {
      this.enabled = status === MESHTASTIC_DEVICE_CONFIGURED;
    });
  }

  available(): boolean { return !this.disposed && this.enabled; }
  setAvailable(available: boolean): void { this.enabled = available; }
  stats(): Readonly<MeshtasticSdkFramePortStats> { return { ...this.statistics }; }


  capabilities(): RawFramePortCapabilities {
    return {
      maximumFrameBytes: MESHTASTIC_DATA_PAYLOAD_BYTES,
      medium: "LORA",
      bidirectional: true,
      broadcast: false,
      transportOwnsRouting: true,
      transportOwnsEncryption: true,
      acknowledgement: "ROUTING_ACK",
    };
  }

  async sendFrame(frame: Uint8Array, options: RawFrameSendOptions = {}): Promise<RawFrameSendResult> {
    if (!this.available()) return { acceptedByLocalPort: false, acceptance: "NONE", detail: "Meshtastic device is not configured" };
    if (options.broadcast) return { acceptedByLocalPort: false, acceptance: "NONE", detail: "Meshtastic SDK frame port is unicast-only" };
    if (options.requestRoutingAck !== true) {
      return { acceptedByLocalPort: false, acceptance: "NONE", detail: "Meshtastic SDK requires routing-ACKed unicast" };
    }
    let destination: number;
    try {
      validateRawFrameSend(frame, options, this.capabilities());
      if (options.destination === undefined) throw new Error("Meshtastic unicast destination is required");
      destination = parseMeshtasticNodeAddress(options.destination);
      if (destination === MESHTASTIC_BROADCAST_NODE) throw new Error("Meshtastic broadcast address is not valid for this unicast port");
    } catch (error) {
      return { acceptedByLocalPort: false, acceptance: "NONE", detail: error instanceof Error ? error.message : "invalid Meshtastic frame" };
    }
    this.statistics.sdkSendAttempts += 1;
    this.statistics.outboundBytesAttempted += frame.length;
    try {
      const packetId = await this.client.sendPacket(
        frame.slice(),
        MESHTASTIC_PRIVATE_APP_PORT,
        destination,
        this.channel,
        true,
        false,
        false,
      );
      if (!Number.isSafeInteger(packetId) || packetId < 0 || packetId > 0xffff_ffff) throw new Error("Meshtastic SDK returned an invalid packet id");
      this.statistics.routingAcknowledgedFrames += 1;
      return {
        acceptedByLocalPort: true,
        acceptance: "ROUTING_ACK",
        transportPacketId: String(packetId),
      };
    } catch (error) {
      this.statistics.failedFrames += 1;
      return {
        acceptedByLocalPort: false,
        acceptance: "NONE",
        detail: error instanceof Error ? error.message : "Meshtastic routing failed",
      };
    }
  }

  receiveFrame(handler: (receipt: RawFrameReceipt) => void | Promise<void>): () => void {
    if (this.disposed) return () => undefined;
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    release(this.privateSubscription);
    release(this.statusSubscription);
    this.handlers.clear();
  }

  private async handlePrivatePacket(packet: MeshtasticPrivatePacket): Promise<void> {
    if (!this.available()) return;
    if (!(packet.data instanceof Uint8Array) || packet.data.length < 1 || packet.data.length > MESHTASTIC_DATA_PAYLOAD_BYTES) return;
    if (packet.type !== "direct" || packet.to === MESHTASTIC_BROADCAST_NODE || packet.channel !== this.channel) return;
    let source: string;
    let destination: string | undefined;
    try {
      source = meshtasticNodeAddress(packet.from);
      destination = packet.to === MESHTASTIC_BROADCAST_NODE ? undefined : meshtasticNodeAddress(packet.to);
    } catch { return; }
    this.statistics.inboundFrames += 1;
    this.statistics.inboundBytes += packet.data.length;
    const receipt: RawFrameReceipt = {
      payload: packet.data.slice(),
      source,
      destination,
      broadcast: packet.type === "broadcast" || packet.to === MESHTASTIC_BROADCAST_NODE,
      transportPacketId: String(packet.id),
    };
    for (const handler of this.handlers) {
      try { await handler(structuredClone(receipt)); }
      catch { /* One consumer must not block other frame consumers. */ }
    }
  }
}

/** Backward-compatible class name retained for existing deployments. */
export { MeshtasticSdkFramePort as MeshtasticCoreFramePort };
