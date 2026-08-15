import assert from "node:assert/strict";
import test from "node:test";
import { deserializeEnvelope, envelopeFromJson, envelopeToJson, serializeEnvelope } from "../src/protocol/codec.ts";
import { verifyReportSignature } from "../src/protocol/identity.ts";
import { validateReport } from "../src/protocol/types.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";

test("CBOR and JSON serialize and deserialize an envelope without semantic loss", () => {
  const report = makeReport({ eventId: "event-roundtrip" });
  const node = new SimulatedNode("origin", new DeterministicRoutingManager());
  const envelope = node.create(report);
  const binary = serializeEnvelope(envelope);
  assert.deepEqual(deserializeEnvelope(binary), JSON.parse(JSON.stringify(envelope)));
  assert.deepEqual(envelopeFromJson(envelopeToJson(envelope)), JSON.parse(JSON.stringify(envelope)));
  assert.ok(binary.length < Buffer.byteLength(envelopeToJson(envelope)), "compact CBOR should be smaller than pretty JSON");
});

test("signature verifies immutable report content and rejects tampering", () => {
  const report = makeReport();
  assert.equal(verifyReportSignature(report), true);
  assert.equal(verifyReportSignature({ ...report, shortMessage: "alterado" }), false);
});

test("version field survives decoding and extensions are forward-compatible", () => {
  const report = makeReport();
  report.extensions = { "x-community-code": "mx-cdmx" };
  const node = new SimulatedNode("origin", new DeterministicRoutingManager());
  const decoded = deserializeEnvelope(serializeEnvelope(node.create(report)));
  assert.equal(decoded.report.protocolVersion, "0.1");
  assert.equal(decoded.report.extensions?.["x-community-code"], "mx-cdmx");
});

test("SELF, THIRD_PARTY and LAST_SEEN enforce subject semantics", () => {
  assert.deepEqual(validateReport(makeReport({ reportMode: "SELF" })), []);
  const thirdParty = makeReport({ reportMode: "THIRD_PARTY", subjectId: "person-a" });
  assert.deepEqual(validateReport(thirdParty), []);
  const invalid = { ...thirdParty, subject: undefined };
  assert.match(validateReport(invalid).join(" "), /subject is required/);
  const lastSeen = makeReport({ eventType: "PERSON_LAST_SEEN", reportMode: "LAST_SEEN", subjectId: "person-b" });
  assert.deepEqual(validateReport(lastSeen), []);
  assert.equal(lastSeen.observedAt, lastSeen.location?.timestamp);
});
