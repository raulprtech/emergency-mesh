import assert from "node:assert/strict";
import test from "node:test";
import { decodeFragment, fragmentBytes } from "../src/protocol/fragmentation.ts";

test("fragment decoder rejects valid but non-canonical CBOR integer encoding", () => {
  const canonical = fragmentBytes(Uint8Array.of(1, 2, 3), 256)[0];
  assert.deepEqual([...canonical.slice(-3)], [0x61, 0x76, 0x01], "version is the final canonical map entry");
  const nonCanonical = new Uint8Array(canonical.length + 1);
  nonCanonical.set(canonical.subarray(0, -1));
  nonCanonical.set([0x18, 0x01], canonical.length - 1);
  assert.throws(() => decodeFragment(nonCanonical), /not canonical/);
});
