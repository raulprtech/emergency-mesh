export type PhysicalMedium = "BLE" | "LORA" | "WIFI" | "OTHER";
export type FrameAcceptance = "NONE" | "LOCAL_QUEUE" | "ROUTING_ACK";

export interface RawFramePortCapabilities {
  maximumFrameBytes: number;
  medium: PhysicalMedium;
  bidirectional: boolean;
  broadcast: boolean;
  transportOwnsRouting: boolean;
  transportOwnsEncryption: boolean;
  acknowledgement: FrameAcceptance;
}

export interface RawFrameSendOptions {
  destination?: string;
  broadcast?: boolean;
  requestRoutingAck?: boolean;
}

export interface RawFrameReceipt {
  payload: Uint8Array;
  source?: string;
  destination?: string;
  broadcast: boolean;
  transportPacketId?: string;
}

export interface RawFrameSendResult {
  acceptedByLocalPort: boolean;
  acceptance: FrameAcceptance;
  transportPacketId?: string;
  detail?: string;
}

export interface RawFramePort {
  readonly id: string;
  available(): boolean;
  capabilities(): RawFramePortCapabilities;
  sendFrame(frame: Uint8Array, options?: RawFrameSendOptions): Promise<RawFrameSendResult>;
  receiveFrame(handler: (receipt: RawFrameReceipt) => void | Promise<void>): () => void;
}

/**
 * Validates the narrow boundary between Emergency Mesh fragmentation and a
 * physical transport. Success means only that a frame may be handed to the
 * port; it says nothing about delivery or remote custody.
 */
export function validateRawFrameSend(
  frame: Uint8Array,
  options: RawFrameSendOptions,
  capabilities: RawFramePortCapabilities,
): void {
  if (!(frame instanceof Uint8Array) || frame.length === 0) throw new Error("raw frame must not be empty");
  if (!Number.isSafeInteger(capabilities.maximumFrameBytes) || capabilities.maximumFrameBytes < 1) {
    throw new Error("physical port maximumFrameBytes must be a positive integer");
  }
  if (frame.length > capabilities.maximumFrameBytes) {
    throw new Error(`raw frame exceeds physical port limit of ${capabilities.maximumFrameBytes} bytes`);
  }
  if (options.broadcast && options.destination !== undefined) {
    throw new Error("raw frame cannot be both broadcast and explicitly addressed");
  }
  if (options.broadcast && !capabilities.broadcast) throw new Error("physical port does not support broadcast");
  if (options.requestRoutingAck && !capabilities.bidirectional) {
    throw new Error("routing acknowledgement requires a bidirectional physical port");
  }
  if (options.requestRoutingAck && capabilities.acknowledgement !== "ROUTING_ACK") {
    throw new Error("physical port does not support routing acknowledgements");
  }
}

/** A transport ACK is deliberately below PEER custody in the core protocol. */
export function isEmergencyMeshCustody(_result: RawFrameSendResult): false {
  return false;
}
