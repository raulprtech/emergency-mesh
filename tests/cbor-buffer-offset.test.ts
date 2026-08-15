import assert from "node:assert/strict";
import test from "node:test";
import { deserializeEnvelope, serializeEnvelope } from "../src/protocol/codec.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";

test("64-bit CBOR integers decode correctly from a Buffer view with non-zero offset", () => {
  const report = makeReport({ eventId: "buffer-offset", createdAt: 1_800_000_000_000 });
  const envelope = new SimulatedNode("origin", new DeterministicRoutingManager()).create(report);
  const encoded = serializeEnvelope(envelope);
  const backing = Buffer.alloc(encoded.length + 19, 0xa5);
  Buffer.from(encoded).copy(backing, 7);
  const httpLikeBody = backing.subarray(7, 7 + encoded.length);
  assert.notEqual(httpLikeBody.byteOffset, 0);
  assert.deepEqual(deserializeEnvelope(httpLikeBody), JSON.parse(JSON.stringify(envelope)));
});
