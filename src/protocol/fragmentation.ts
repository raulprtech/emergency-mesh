import { createHash, timingSafeEqual } from "node:crypto";
import { decodeCbor, encodeCbor } from "./cbor.ts";
import { deserializeEnvelope, serializeEnvelope } from "./codec.ts";
import type { EmergencyEnvelope } from "./types.ts";

export const FRAGMENT_VERSION = 1;
export const MAX_FRAGMENT_COUNT = 256;
export const MAX_REASSEMBLED_BYTES = 65_536;

export interface FragmentFrame {
  version: 1;
  transferId: string;
  index: number;
  count: number;
  totalLength: number;
  digest: Uint8Array;
  data: Uint8Array;
}

export interface ReassemblyOptions {
  maxTransfers?: number;
  maxBufferedBytes?: number;
  maxPayloadBytes?: number;
  maxFragments?: number;
  maxFrameBytes?: number;
  timeoutMs?: number;
}

export interface ReassemblyResult {
  status: "PARTIAL" | "DUPLICATE" | "COMPLETE" | "REJECTED";
  transferId?: string;
  payload?: Uint8Array;
  envelope?: EmergencyEnvelope;
  error?: string;
}

interface PendingTransfer {
  transferId: string;
  digest: Uint8Array;
  count: number;
  totalLength: number;
  fragments: Map<number, Uint8Array>;
  bufferedBytes: number;
  updatedAt: number;
}

function transferIdFor(digest: Uint8Array): string {
  return Buffer.from(digest.subarray(0, 16)).toString("base64url");
}

function validateFrame(frame: FragmentFrame): string[] {
  const errors: string[] = [];
  if (frame.version !== FRAGMENT_VERSION) errors.push("unsupported fragment version");
  if (typeof frame.transferId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(frame.transferId)) errors.push("fragment transferId is invalid");
  if (!(frame.digest instanceof Uint8Array) || frame.digest.length !== 32) errors.push("fragment digest must be 32 bytes");
  if (frame.digest instanceof Uint8Array && frame.digest.length === 32 && frame.transferId !== transferIdFor(frame.digest)) errors.push("fragment transferId does not match digest");
  if (!Number.isInteger(frame.index) || frame.index < 0) errors.push("fragment index must be a non-negative integer");
  if (!Number.isInteger(frame.count) || frame.count < 1 || frame.count > MAX_FRAGMENT_COUNT) errors.push("fragment count is out of range");
  if (Number.isInteger(frame.index) && Number.isInteger(frame.count) && frame.index >= frame.count) errors.push("fragment index must be below count");
  if (!Number.isInteger(frame.totalLength) || frame.totalLength < 1 || frame.totalLength > MAX_REASSEMBLED_BYTES) errors.push("fragment totalLength is out of range");
  if (!(frame.data instanceof Uint8Array) || frame.data.length < 1) errors.push("fragment data must not be empty");
  if (frame.data instanceof Uint8Array && Number.isInteger(frame.totalLength) && frame.data.length > frame.totalLength) errors.push("fragment data exceeds totalLength");
  if (Number.isInteger(frame.totalLength) && Number.isInteger(frame.count) && frame.totalLength < frame.count) errors.push("fragment count exceeds possible non-empty chunks");
  return errors;
}

export function encodeFragment(frame: FragmentFrame): Uint8Array {
  const errors = validateFrame(frame);
  if (errors.length) throw new Error(`Invalid fragment: ${errors.join("; ")}`);
  return encodeCbor({ v: frame.version, t: frame.transferId, i: frame.index, n: frame.count, l: frame.totalLength, h: frame.digest, d: frame.data });
}

export function decodeFragment(bytes: Uint8Array): FragmentFrame {
  const decoded = decodeCbor(bytes);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid fragment object");
  const value = decoded as Record<string, unknown>;
  const allowed = new Set(["v", "t", "i", "n", "l", "h", "d"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Fragment contains unknown fields");
  const frame = {
    version: value.v,
    transferId: value.t,
    index: value.i,
    count: value.n,
    totalLength: value.l,
    digest: value.h,
    data: value.d,
  } as FragmentFrame;
  const errors = validateFrame(frame);
  if (errors.length) throw new Error(`Invalid fragment: `);
  const canonical = encodeFragment(frame);
  if (canonical.length !== bytes.length || !timingSafeEqual(canonical, bytes)) throw new Error("Fragment CBOR is not canonical");
  return frame;
}

export function fragmentBytes(payload: Uint8Array, mtu: number): Uint8Array[] {
  if (!(payload instanceof Uint8Array) || payload.length < 1) throw new Error("Fragment payload must not be empty");
  if (payload.length > MAX_REASSEMBLED_BYTES) throw new Error(`Fragment payload exceeds ${MAX_REASSEMBLED_BYTES} bytes`);
  if (!Number.isSafeInteger(mtu) || mtu < 1) throw new Error("MTU must be a positive integer");
  const digest = createHash("sha256").update(payload).digest();
  const transferId = transferIdFor(digest);
  let chunkSize = Math.min(payload.length, mtu);
  while (chunkSize > 0) {
    const count = Math.ceil(payload.length / chunkSize);
    if (count > MAX_FRAGMENT_COUNT) throw new Error(`MTU requires more than ${MAX_FRAGMENT_COUNT} fragments`);
    const frames: Uint8Array[] = [];
    let largestExcess = 0;
    for (let index = 0; index < count; index += 1) {
      const data = payload.subarray(index * chunkSize, Math.min(payload.length, (index + 1) * chunkSize));
      const encoded = encodeFragment({ version: 1, transferId, index, count, totalLength: payload.length, digest, data });
      largestExcess = Math.max(largestExcess, encoded.length - mtu);
      frames.push(encoded);
    }
    if (largestExcess <= 0) return frames;
    chunkSize -= Math.max(1, largestExcess);
  }
  throw new Error(`MTU ${mtu} is too small for fragment metadata`);
}

export function fragmentEnvelope(envelope: EmergencyEnvelope, mtu: number): Uint8Array[] {
  return fragmentBytes(serializeEnvelope(envelope), mtu);
}

export class FragmentReassembler {
  private readonly transfers = new Map<string, PendingTransfer>();
  private bufferedBytes = 0;
  private readonly options: Required<ReassemblyOptions>;

  constructor(options: ReassemblyOptions = {}) {
    this.options = {
      maxTransfers: options.maxTransfers ?? 32,
      maxBufferedBytes: options.maxBufferedBytes ?? 1_048_576,
      maxPayloadBytes: options.maxPayloadBytes ?? MAX_REASSEMBLED_BYTES,
      maxFragments: options.maxFragments ?? MAX_FRAGMENT_COUNT,
      maxFrameBytes: options.maxFrameBytes ?? MAX_REASSEMBLED_BYTES,
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
    };
    if (!Number.isInteger(this.options.maxTransfers) || this.options.maxTransfers < 1) throw new Error("maxTransfers must be positive");
    if (!Number.isInteger(this.options.maxBufferedBytes) || this.options.maxBufferedBytes < 1) throw new Error("maxBufferedBytes must be positive");
    if (!Number.isInteger(this.options.maxPayloadBytes) || this.options.maxPayloadBytes < 1 || this.options.maxPayloadBytes > MAX_REASSEMBLED_BYTES) throw new Error("maxPayloadBytes is out of range");
    if (!Number.isInteger(this.options.maxFragments) || this.options.maxFragments < 1 || this.options.maxFragments > MAX_FRAGMENT_COUNT) throw new Error("maxFragments is out of range");
    if (!Number.isInteger(this.options.maxFrameBytes) || this.options.maxFrameBytes < 1) throw new Error("maxFrameBytes must be positive");
    if (!Number.isInteger(this.options.timeoutMs) || this.options.timeoutMs < 1) throw new Error("timeoutMs must be positive");
  }

  private remove(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    this.bufferedBytes -= transfer.bufferedBytes;
    this.transfers.delete(transferId);
  }

  prune(now = Date.now()): number {
    let removed = 0;
    for (const transfer of this.transfers.values()) {
      if (now - transfer.updatedAt >= this.options.timeoutMs) { this.remove(transfer.transferId); removed += 1; }
    }
    return removed;
  }

  ingest(bytes: Uint8Array, now = Date.now()): ReassemblyResult {
    this.prune(now);
    if (!(bytes instanceof Uint8Array) || bytes.length > this.options.maxFrameBytes) return { status: "REJECTED", error: "fragment frame exceeds size limit" };
    let frame: FragmentFrame;
    try { frame = decodeFragment(bytes); }
    catch (error) { return { status: "REJECTED", error: error instanceof Error ? error.message : "invalid fragment" }; }
    if (frame.totalLength > this.options.maxPayloadBytes) return { status: "REJECTED", transferId: frame.transferId, error: "reassembled payload exceeds size limit" };
    if (frame.count > this.options.maxFragments) return { status: "REJECTED", transferId: frame.transferId, error: "fragment count exceeds policy" };

    let transfer = this.transfers.get(frame.transferId);
    if (!transfer) {
      if (this.transfers.size >= this.options.maxTransfers) return { status: "REJECTED", transferId: frame.transferId, error: "reassembly transfer capacity exhausted" };
      if (this.bufferedBytes + frame.data.length > this.options.maxBufferedBytes) return { status: "REJECTED", transferId: frame.transferId, error: "reassembly byte capacity exhausted" };
      transfer = { transferId: frame.transferId, digest: frame.digest.slice(), count: frame.count, totalLength: frame.totalLength, fragments: new Map(), bufferedBytes: 0, updatedAt: now };
      this.transfers.set(frame.transferId, transfer);
    } else if (transfer.count !== frame.count || transfer.totalLength !== frame.totalLength || !timingSafeEqual(transfer.digest, frame.digest)) {
      return { status: "REJECTED", transferId: frame.transferId, error: "fragment metadata conflicts with pending transfer" };
    }

    const existing = transfer.fragments.get(frame.index);
    if (existing) {
      if (existing.length === frame.data.length && timingSafeEqual(existing, frame.data)) return { status: "DUPLICATE", transferId: frame.transferId };
      return { status: "REJECTED", transferId: frame.transferId, error: "fragment conflicts with existing index" };
    }
    if (transfer.bufferedBytes + frame.data.length > transfer.totalLength) return { status: "REJECTED", transferId: frame.transferId, error: "fragment bytes exceed declared totalLength" };
    if (this.bufferedBytes + frame.data.length > this.options.maxBufferedBytes) return { status: "REJECTED", transferId: frame.transferId, error: "reassembly byte capacity exhausted" };
    transfer.fragments.set(frame.index, frame.data.slice());
    transfer.bufferedBytes += frame.data.length;
    transfer.updatedAt = now;
    this.bufferedBytes += frame.data.length;
    if (transfer.fragments.size < transfer.count) return { status: "PARTIAL", transferId: frame.transferId };

    const payload = new Uint8Array(transfer.totalLength);
    let offset = 0;
    for (let index = 0; index < transfer.count; index += 1) {
      const data = transfer.fragments.get(index);
      if (!data || offset + data.length > payload.length) { this.remove(frame.transferId); return { status: "REJECTED", transferId: frame.transferId, error: "fragment layout is inconsistent" }; }
      payload.set(data, offset); offset += data.length;
    }
    this.remove(frame.transferId);
    if (offset !== payload.length) return { status: "REJECTED", transferId: frame.transferId, error: "reassembled length does not match metadata" };
    const digest = createHash("sha256").update(payload).digest();
    if (!timingSafeEqual(digest, frame.digest)) return { status: "REJECTED", transferId: frame.transferId, error: "reassembled payload digest mismatch" };
    return { status: "COMPLETE", transferId: frame.transferId, payload };
  }

  ingestEnvelope(bytes: Uint8Array, now = Date.now()): ReassemblyResult {
    const result = this.ingest(bytes, now);
    if (result.status !== "COMPLETE" || !result.payload) return result;
    try { return { ...result, envelope: deserializeEnvelope(result.payload) }; }
    catch (error) { return { status: "REJECTED", transferId: result.transferId, error: error instanceof Error ? error.message : "invalid reassembled envelope" }; }
  }

  stats(): { transfers: number; bufferedBytes: number } {
    return { transfers: this.transfers.size, bufferedBytes: this.bufferedBytes };
  }
}
