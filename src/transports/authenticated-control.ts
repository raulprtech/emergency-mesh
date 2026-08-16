import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeCbor, encodeCbor } from "../protocol/cbor.ts";
import { decodeControlMessage, encodeControlMessage, type RoutingControlMessage } from "./control.ts";

export const AUTHENTICATED_CONTROL_VERSION = "0.1" as const;
export const AUTHENTICATED_CONTROL_TAG_BYTES = 16;
const AUTHENTICATED_CONTROL_KIND = 2;

export interface ControlFrameAuthentication {
  keyId: string;
  secret: Uint8Array;
}

function validateAuthentication(authentication: ControlFrameAuthentication): void {
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(authentication.keyId)) {
    throw new Error("control authentication keyId is invalid");
  }
  if (!(authentication.secret instanceof Uint8Array) || authentication.secret.length < 32) {
    throw new Error("control authentication secret must contain at least 32 bytes");
  }
}

function unsignedFrame(keyId: string, controlBytes: Uint8Array): Uint8Array {
  return encodeCbor([
    AUTHENTICATED_CONTROL_KIND,
    AUTHENTICATED_CONTROL_VERSION,
    keyId,
    controlBytes,
  ]);
}

function authenticationTag(
  keyId: string,
  controlBytes: Uint8Array,
  secret: Uint8Array,
): Uint8Array {
  return createHmac("sha256", secret)
    .update("emergency-mesh:authenticated-control:", "utf8")
    .update(unsignedFrame(keyId, controlBytes))
    .digest()
    .subarray(0, AUTHENTICATED_CONTROL_TAG_BYTES);
}

/** Authenticates an existing deterministic control message without changing v0.1. */
export function encodeAuthenticatedControlMessage(
  message: RoutingControlMessage,
  authentication: ControlFrameAuthentication,
): Uint8Array {
  validateAuthentication(authentication);
  const controlBytes = encodeControlMessage(message);
  const tag = authenticationTag(authentication.keyId, controlBytes, authentication.secret);
  return encodeCbor([
    AUTHENTICATED_CONTROL_KIND,
    AUTHENTICATED_CONTROL_VERSION,
    authentication.keyId,
    controlBytes,
    tag,
  ]);
}

/** Verifies key selection, canonical framing, and MAC before parsing the inner message. */
export function decodeAuthenticatedControlMessage(
  bytes: Uint8Array,
  authentication: ControlFrameAuthentication,
): RoutingControlMessage {
  validateAuthentication(authentication);
  const decoded = decodeCbor(bytes);
  if (!Array.isArray(decoded) || decoded.length !== 5) {
    throw new Error("Malformed authenticated control frame");
  }
  const [kind, version, keyId, controlBytes, tag] = decoded;
  if (kind !== AUTHENTICATED_CONTROL_KIND || version !== AUTHENTICATED_CONTROL_VERSION) {
    throw new Error("Unsupported authenticated control frame");
  }
  if (keyId !== authentication.keyId) throw new Error("Authenticated control keyId mismatch");
  if (!(controlBytes instanceof Uint8Array) || controlBytes.length === 0) {
    throw new Error("Authenticated control payload is invalid");
  }
  if (!(tag instanceof Uint8Array) || tag.length !== AUTHENTICATED_CONTROL_TAG_BYTES) {
    throw new Error("Authenticated control tag is invalid");
  }
  const expected = authenticationTag(authentication.keyId, controlBytes, authentication.secret);
  if (!timingSafeEqual(tag, expected)) throw new Error("Authenticated control tag mismatch");
  const canonical = encodeCbor([kind, version, keyId, controlBytes, tag]);
  if (canonical.length !== bytes.length || !timingSafeEqual(canonical, bytes)) {
    throw new Error("Authenticated control frame is not canonical");
  }
  const message = decodeControlMessage(controlBytes);
  const canonicalControl = encodeControlMessage(message);
  if (canonicalControl.length !== controlBytes.length || !timingSafeEqual(canonicalControl, controlBytes)) {
    throw new Error("Authenticated inner control message is not canonical");
  }
  return message;
}
