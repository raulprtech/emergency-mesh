/** Minimal deterministic CBOR codec for protocol values (RFC 8949 core types). */
const concat = (chunks: Uint8Array[]): Uint8Array => {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

function head(major: number, value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("CBOR length/integer out of range");
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value <= 0xff) return Uint8Array.of((major << 5) | 24, value);
  if (value <= 0xffff) return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  if (value <= 0xffffffff) {
    const bytes = new Uint8Array(5);
    bytes[0] = (major << 5) | 26;
    new DataView(bytes.buffer).setUint32(1, value);
    return bytes;
  }
  const bytes = new Uint8Array(9);
  bytes[0] = (major << 5) | 27;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(value));
  return bytes;
}

export function encodeCbor(value: unknown): Uint8Array {
  if (value === null) return Uint8Array.of(0xf6);
  if (value === false) return Uint8Array.of(0xf4);
  if (value === true) return Uint8Array.of(0xf5);
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
    const bytes = new Uint8Array(9);
    bytes[0] = 0xfb;
    new DataView(bytes.buffer).setFloat64(1, value);
    return bytes;
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return concat([head(2, value.length), value]);
  if (Array.isArray(value)) return concat([head(4, value.length), ...value.map(encodeCbor)]);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [encodeCbor(key), encodeCbor(item)] as const)
      .sort(([a], [b]) => a.length - b.length || Buffer.compare(a, b));
    return concat([head(5, entries.length), ...entries.flatMap(([key, item]) => [key, item])]);
  }
  throw new Error(`Unsupported CBOR value: ${typeof value}`);
}

class Decoder {
  private offset = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }

  decode(): unknown {
    const initial = this.readByte();
    const major = initial >> 5;
    const additional = initial & 31;
    if (major === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
      if (additional === 27) return this.readFloat64();
      throw new Error(`Unsupported CBOR simple value ${additional}`);
    }
    const length = this.readLength(additional);
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2) return this.readBytes(length);
    if (major === 3) return new TextDecoder("utf-8", { fatal: true }).decode(this.readBytes(length));
    if (major === 4) return Array.from({ length }, () => this.decode());
    if (major === 5) {
      const object: Record<string, unknown> = {};
      for (let index = 0; index < length; index += 1) {
        const key = this.decode();
        if (typeof key !== "string") throw new Error("Only string CBOR map keys are supported");
        object[key] = this.decode();
      }
      return object;
    }
    throw new Error(`Unsupported CBOR major type ${major}`);
  }

  finished(): boolean { return this.offset === this.bytes.length; }
  private readByte(): number {
    if (this.offset >= this.bytes.length) throw new Error("Unexpected end of CBOR data");
    return this.bytes[this.offset++];
  }
  private readBytes(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) throw new Error("Unexpected end of CBOR data");
    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  private readLength(additional: number): number {
    if (additional < 24) return additional;
    if (additional === 24) return this.readByte();
    if (additional === 25) return this.readNumber(2);
    if (additional === 26) return this.readNumber(4);
    if (additional === 27) {
      const bytes = this.readBytes(8);
      const value = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0));
      if (!Number.isSafeInteger(value)) throw new Error("CBOR integer exceeds JavaScript safe range");
      return value;
    }
    throw new Error("Indefinite-length CBOR is not supported");
  }
  private readNumber(length: number): number {
    const bytes = this.readBytes(length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return length === 2 ? view.getUint16(0) : view.getUint32(0);
  }
  private readFloat64(): number {
    const bytes = this.readBytes(8);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0);
  }
}

export function decodeCbor(bytes: Uint8Array): unknown {
  const decoder = new Decoder(bytes);
  const value = decoder.decode();
  if (!decoder.finished()) throw new Error("Trailing bytes after CBOR value");
  return value;
}
