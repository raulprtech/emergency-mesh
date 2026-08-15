import assert from "node:assert/strict";
import test from "node:test";
import { deserializeEnvelope, serializeEnvelope } from "../src/protocol/codec.ts";
import { verifyReportSignature } from "../src/protocol/identity.ts";
import { validateEnvelope, validateReport } from "../src/protocol/types.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";

test("decoded report retains a valid signature", () => {
  const node = new SimulatedNode("origin", new DeterministicRoutingManager());
  const decoded = deserializeEnvelope(serializeEnvelope(node.create(makeReport())));
  assert.equal(verifyReportSignature(decoded.report), true);
});

test("mutable envelope cannot extend signed report lifetime", () => {
  const node = new SimulatedNode("origin", new DeterministicRoutingManager());
  const envelope = node.create(makeReport());
  envelope.expiresAt = envelope.report.validUntil + 1;
  assert.match(validateEnvelope(envelope).join(" "), /cannot exceed signed validUntil/);
  assert.throws(() => serializeEnvelope(envelope), /signed validUntil/);
});

test("unsupported protocol families are rejected", () => {
  const report = { ...makeReport(), protocolVersion: "1.0" };
  assert.match(validateReport(report).join(" "), /unsupported protocolVersion/);
});

test("decoder rejects trailing bytes", () => {
  const node = new SimulatedNode("origin", new DeterministicRoutingManager());
  const valid = serializeEnvelope(node.create(makeReport()));
  const malformed = new Uint8Array(valid.length + 1);
  malformed.set(valid);
  assert.throws(() => deserializeEnvelope(malformed), /Trailing bytes/);
});
