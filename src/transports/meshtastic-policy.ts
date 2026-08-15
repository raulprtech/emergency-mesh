import {
  validateRawFrameSend,
  type RawFramePortCapabilities,
  type RawFrameSendOptions,
} from "./raw-frame-port.ts";

/** Current Meshtastic Data.payload ceiling from the official protobuf contract. */
export const MESHTASTIC_DATA_PAYLOAD_BYTES = 233;
/** PortNum reserved by Meshtastic for private applications. */
export const MESHTASTIC_PRIVATE_APP_PORT = 256;
export const MESHTASTIC_BROADCAST_NODE = 0xffff_ffff;

export const MESHTASTIC_FRAME_CAPABILITIES: Readonly<RawFramePortCapabilities> = Object.freeze({
  maximumFrameBytes: MESHTASTIC_DATA_PAYLOAD_BYTES,
  medium: "LORA",
  bidirectional: true,
  broadcast: true,
  transportOwnsRouting: true,
  transportOwnsEncryption: true,
  acknowledgement: "ROUTING_ACK",
});

export interface MeshtasticFrameOptions {
  destinationNode?: number;
  requestRoutingAck?: boolean;
}

export interface MeshtasticDataRequest {
  payload: Uint8Array;
  portNum: typeof MESHTASTIC_PRIVATE_APP_PORT;
  destinationNode: number;
  wantAck: boolean;
}

/**
 * Maps one already-fragmented Emergency Mesh frame onto the supported
 * Meshtastic application-data boundary. An SDK-specific adapter can translate
 * this value to its native send-data call without owning mesh routing.
 */
export function createMeshtasticDataRequest(
  frame: Uint8Array,
  options: MeshtasticFrameOptions = {},
): MeshtasticDataRequest {
  const destinationNode = options.destinationNode ?? MESHTASTIC_BROADCAST_NODE;
  if (!Number.isSafeInteger(destinationNode) || destinationNode < 0 || destinationNode > 0xffff_ffff) {
    throw new Error("Meshtastic destinationNode must be an unsigned 32-bit integer");
  }
  const broadcast = destinationNode === MESHTASTIC_BROADCAST_NODE;
  const rawOptions: RawFrameSendOptions = {
    broadcast,
    destination: broadcast ? undefined : destinationNode.toString(16).padStart(8, "0"),
    requestRoutingAck: !broadcast && options.requestRoutingAck === true,
  };
  validateRawFrameSend(frame, rawOptions, MESHTASTIC_FRAME_CAPABILITIES);
  return {
    payload: frame.slice(),
    portNum: MESHTASTIC_PRIVATE_APP_PORT,
    destinationNode,
    // Meshtastic clears want_ack for broadcasts to avoid ACK storms.
    wantAck: rawOptions.requestRoutingAck === true,
  };
}
