import assert from "node:assert/strict";
import test from "node:test";
import { decodeCbor, encodeCbor } from "../src/protocol/cbor.ts";
import { deserializeEnvelope } from "../src/protocol/codec.ts";

test("CBOR decoder rejects declared allocation and nesting bombs before allocation", () => {
  assert.throws(() => decodeCbor(Uint8Array.of(0x9a, 0xff, 0xff, 0xff, 0xff)), /array exceeds item limit/);
  assert.throws(() => decodeCbor(Uint8Array.of(0xba, 0xff, 0xff, 0xff, 0xff)), /map exceeds entry limit/);
  assert.throws(() => decodeCbor(Uint8Array.from([...Array(33).fill(0x81), 0x00])), /depth limit/);
  assert.throws(() => decodeCbor(encodeCbor([1, 2, 3]), { maxTotalItems: 3 }), /item count/);
  assert.throws(() => decodeCbor(new Uint8Array(9), { maxInputBytes: 8 }), /input exceeds size limit/);
});

test("CBOR maps reject duplicate keys and define prototype-named data safely", () => {
  assert.throws(() => decodeCbor(Uint8Array.of(0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02)), /Duplicate CBOR map key/);
  const key = new TextEncoder().encode("__proto__");
  const encoded = Uint8Array.from([0xa1, 0x69, ...key, 0xa0]);
  const decoded = decodeCbor(encoded) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.equal(Object.hasOwn(decoded, "__proto__"), true);
  assert.deepEqual(decoded.__proto__, {});
});

test("protocol expansion rejects short-name alias collisions", () => {
  assert.throws(() => deserializeEnvelope(encodeCbor({ a: "short", packetId: "long" })), /Duplicate protocol field packetId/);
});

test("CBOR rejects non-finite numbers on encode and decode", () => {
  assert.throws(() => encodeCbor(Number.NaN), /Non-finite/);
  assert.throws(() => encodeCbor(Number.POSITIVE_INFINITY), /Non-finite/);
  assert.throws(() => decodeCbor(Buffer.from("fb7ff8000000000000", "hex")), /Non-finite/);
});

test("deterministic malformed-input fuzzing remains bounded and round-trips accepted values", { timeout: 5_000 }, () => {
  let state = 0x6d2b79f5;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  let accepted = 0;
  for (let sample = 0; sample < 5_000; sample += 1) {
    const bytes = new Uint8Array(random() % 257);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = random() & 0xff;
    try {
      const value = decodeCbor(bytes);
      assert.deepEqual(decodeCbor(encodeCbor(value)), value);
      accepted += 1;
    } catch (error) {
      assert.equal(error instanceof Error, true);
    }
  }
  assert.ok(accepted > 0, "seeded corpus should include valid scalar CBOR values");
});
