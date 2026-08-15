import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { deserializeEnvelope, serializeEnvelope } from "../src/protocol/codec.ts";
import {
  FragmentReassembler,
  decodeFragment,
  encodeFragment,
  fragmentBytes,
  fragmentEnvelope,
} from "../src/protocol/fragmentation.ts";
import { createDeviceIdentity, signReport, verifyReportSignature } from "../src/protocol/identity.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { StoreAndForwardQueue } from "../src/storage/store.ts";
import { FragmentedMockTransportAdapter } from "../src/transports/fragmented-mock.ts";

const now = 1_800_000_000_000;

function largeEnvelope(eventId = "fragmented-event", padding = 3_000) {
  const identity = createDeviceIdentity();
  const original = makeReport({ identity, eventId, createdAt: now });
  const { signature: _signature, ...unsigned } = original;
  const report = signReport({ ...unsigned, extensions: { "x-test-padding": "x".repeat(padding) } }, identity);
  return { packetId: `packet-${eventId}`, report, expiresAt: report.validUntil, hopCount: 0, hopLimit: 12, transportHistory: [] };
}

test("fragment frames never exceed MTU and reassemble out of order", () => {
  const payload = randomBytes(4_321);
  for (const mtu of [128, 160, 220, 512]) {
    const frames = fragmentBytes(payload, mtu);
    assert.ok(frames.length > 1);
    assert.ok(frames.every((frame) => frame.length <= mtu));
    const reassembler = new FragmentReassembler({ maxFrameBytes: mtu });
    let complete;
    for (const frame of frames.toReversed()) {
      const result = reassembler.ingest(frame, now);
      if (result.status === "COMPLETE") complete = result.payload;
    }
    assert.deepEqual(Buffer.from(complete), payload);
    assert.deepEqual(reassembler.stats(), { transfers: 0, bufferedBytes: 0 });
  }
});

test("duplicate frames are idempotent while conflicting data is rejected", () => {
  const payload = randomBytes(1_024);
  const frames = fragmentBytes(payload, 180);
  const reassembler = new FragmentReassembler({ maxFrameBytes: 180 });
  assert.equal(reassembler.ingest(frames[0], now).status, "PARTIAL");
  assert.equal(reassembler.ingest(frames[0], now + 1).status, "DUPLICATE");
  const decoded = decodeFragment(frames[0]);
  const altered = decoded.data.slice(); altered[0] ^= 0xff;
  assert.match(reassembler.ingest(encodeFragment({ ...decoded, data: altered }), now + 2).error ?? "", /conflicts/);
  let final;
  for (const frame of frames.slice(1)) final = reassembler.ingest(frame, now + 3);
  assert.equal(final?.status, "COMPLETE");
  assert.deepEqual(Buffer.from(final?.payload ?? []), payload);
});

test("full-payload digest rejects corrupted but structurally valid fragment sets", () => {
  const payload = randomBytes(900);
  const frames = fragmentBytes(payload, 170);
  const last = decodeFragment(frames.at(-1)!);
  const corrupted = last.data.slice(); corrupted[corrupted.length - 1] ^= 1;
  frames[frames.length - 1] = encodeFragment({ ...last, data: corrupted });
  const reassembler = new FragmentReassembler({ maxFrameBytes: 170 });
  let result;
  for (const frame of frames) result = reassembler.ingest(frame, now);
  assert.equal(result?.status, "REJECTED");
  assert.match(result?.error ?? "", /digest mismatch/);
  assert.deepEqual(reassembler.stats(), { transfers: 0, bufferedBytes: 0 });
});

test("reassembly capacity fails closed and stale partial transfers expire", () => {
  const first = fragmentBytes(randomBytes(600), 180);
  const second = fragmentBytes(randomBytes(600), 180);
  const reassembler = new FragmentReassembler({ maxTransfers: 1, maxBufferedBytes: 1_000, maxFrameBytes: 180, timeoutMs: 100 });
  assert.equal(reassembler.ingest(first[0], now).status, "PARTIAL");
  assert.match(reassembler.ingest(second[0], now + 1).error ?? "", /transfer capacity/);
  assert.equal(reassembler.prune(now + 100), 1);
  assert.equal(reassembler.ingest(second[0], now + 100).status, "PARTIAL");
  assert.equal(reassembler.stats().transfers, 1);
});

test("malformed frames and impossible MTUs are rejected", () => {
  assert.throws(() => fragmentBytes(randomBytes(2_000), 40), /MTU|fragments/);
  assert.throws(() => decodeFragment(encodeCbor({ v: 1, unexpected: true })), /Invalid fragment|unknown fields/);
  const reassembler = new FragmentReassembler({ maxFrameBytes: 64 });
  assert.equal(reassembler.ingest(randomBytes(65), now).status, "REJECTED");
});

test("fragmented envelope preserves exact signed report bytes", () => {
  const envelope = largeEnvelope("signed-fragment-event", 2_000);
  const encoded = serializeEnvelope(envelope);
  const frames = fragmentEnvelope(envelope, 180);
  const reassembler = new FragmentReassembler({ maxFrameBytes: 180 });
  let result;
  for (const frame of frames) result = reassembler.ingestEnvelope(frame, now);
  assert.equal(result?.status, "COMPLETE");
  assert.deepEqual(serializeEnvelope(result!.envelope!), encoded);
  assert.equal(verifyReportSignature(deserializeEnvelope(result!.payload!).report), true);
});

test("fragmenting adapter retries partial transfer and claims custody only after receiver accepts", async () => {
  const target = new SimulatedNode("fragment-target", new DeterministicRoutingManager());
  const sender = new SimulatedNode("fragment-sender", new DeterministicRoutingManager());
  const adapter = new FragmentedMockTransportAdapter("tiny-link", {
    maximumPayloadSize: 180,
    deliverFrame: (_frame, index, attempt) => !(attempt === 1 && index === 2),
  });
  adapter.connect((envelope) => target.receive(envelope, now));
  sender.addTransport(adapter);
  const envelope = largeEnvelope("retry-fragment-event", 2_000);
  sender.receive(envelope, now);

  const [first] = await sender.flush(now);
  assert.deepEqual(first.accepted, []);
  assert.equal(sender.queue.has(envelope.report.eventId), true);
  const [second] = await sender.flush(now + 2_000);
  assert.deepEqual(second.accepted, ["tiny-link"]);
  assert.equal(sender.queue.has(envelope.report.eventId), false);
  assert.equal(target.queue.has(envelope.report.eventId), true);
});

test("fragmenting adapter keeps sender custody when peer queue rejects reassembled packet", async () => {
  const target = new SimulatedNode("bounded-fragment-target", new DeterministicRoutingManager(), undefined, new StoreAndForwardQueue({ maxItems: 1 }));
  target.create(makeReport({ eventId: "protected-critical", createdAt: now, priority: "CRITICAL" }));
  const sender = new SimulatedNode("bounded-fragment-sender", new DeterministicRoutingManager());
  const adapter = new FragmentedMockTransportAdapter("bounded-tiny-link", { maximumPayloadSize: 180 });
  adapter.connect((envelope) => target.receive(envelope, now));
  sender.addTransport(adapter);
  const report = makeReport({ eventId: "incoming-low-fragmented", createdAt: now, eventType: "AREA_STATUS", priority: "LOW" });
  const envelope = sender.create(report);
  const [result] = await sender.flush(now);
  assert.deepEqual(result.accepted, []);
  assert.equal(sender.queue.has(report.eventId), true);
  assert.equal(target.queue.has(report.eventId), false);
  assert.ok(fragmentEnvelope(envelope, 180).length > 1);
});
