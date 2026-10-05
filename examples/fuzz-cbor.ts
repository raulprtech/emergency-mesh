import assert from "node:assert/strict";
import { decodeCbor, encodeCbor } from "../src/protocol/cbor.ts";

function positiveInteger(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function unsignedSeed(): number {
  const raw = process.env.CBOR_FUZZ_SEED;
  if (raw === undefined) return 0x6d2b_79f5;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("CBOR_FUZZ_SEED must be an unsigned 32-bit integer");
  }
  return value >>> 0;
}

const iterations = positiveInteger("CBOR_FUZZ_ITERATIONS", 25_000, 10_000_000);
const maxBytes = positiveInteger("CBOR_FUZZ_MAX_BYTES", 512, 65_536);
const seed = unsignedSeed();
let state = seed || 0x9e37_79b9;
const random = (): number => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
};

const validCorpus = [
  null,
  false,
  true,
  0,
  -1,
  23,
  24,
  0xffff_ffff,
  1.5,
  "emergency-mesh",
  Uint8Array.of(0, 1, 2, 255),
  [null, true, 42, "mesh"],
  { eventId: "fuzz-event", nested: { priority: "CRITICAL" } },
].map(encodeCbor);

function rawBytes(): Uint8Array {
  const bytes = new Uint8Array(random() % (maxBytes + 1));
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = random() & 0xff;
  return bytes;
}

function mutatedValidBytes(): Uint8Array {
  const source = validCorpus[random() % validCorpus.length];
  const extra = random() % 5;
  const length = Math.min(maxBytes, source.length + extra);
  const bytes = new Uint8Array(length);
  bytes.set(source.subarray(0, length));
  for (let index = source.length; index < length; index += 1) bytes[index] = random() & 0xff;
  const mutations = 1 + (random() % 4);
  for (let mutation = 0; mutation < mutations && bytes.length > 0; mutation += 1) {
    const index = random() % bytes.length;
    bytes[index] ^= 1 << (random() % 8);
  }
  return bytes;
}

let accepted = 0;
let rejected = 0;
for (let sample = 0; sample < iterations; sample += 1) {
  const bytes = (random() & 1) === 0 ? rawBytes() : mutatedValidBytes();
  let value: unknown;
  try {
    value = decodeCbor(bytes);
  } catch (error) {
    assert.equal(error instanceof Error, true);
    rejected += 1;
    continue;
  }
  assert.deepEqual(decodeCbor(encodeCbor(value)), value);
  accepted += 1;
}

assert.equal(accepted + rejected, iterations);
assert.ok(accepted > 0, "fuzz corpus must exercise accepted CBOR values");
assert.ok(rejected > 0, "fuzz corpus must exercise rejected CBOR values");
console.log(JSON.stringify({ seed, iterations, maxBytes, accepted, rejected }));
