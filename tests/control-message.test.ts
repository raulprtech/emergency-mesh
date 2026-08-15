import assert from "node:assert/strict";
import test from "node:test";
import { decodeControlMessage, encodeControlMessage, type RoutingControlMessage } from "../src/transports/control.ts";

test("ACK control message has a stable compact CBOR round trip", () => {
  const message: RoutingControlMessage = {
    kind: "ACK",
    controlVersion: "0.1",
    senderNodeId: "gateway-a",
    acknowledgement: {
      acknowledgementId: "ack-1",
      eventId: "event-1",
      packetId: "packet-1",
      level: "BACKEND",
      acknowledgedAt: 1_800_000_000_000,
      issuerId: "backend-a",
      status: "STORED",
    },
  };
  const binary = encodeControlMessage(message);
  assert.deepEqual(decodeControlMessage(binary), message);
  assert.ok(binary.length < Buffer.byteLength(JSON.stringify(message)));
});

test("egress advertisement round trips with explicit validity", () => {
  const message: RoutingControlMessage = {
    kind: "EGRESS_ADVERTISEMENT",
    controlVersion: "0.1",
    senderNodeId: "node-c",
    advertisement: {
      state: "CONFIRMED",
      quality: 0.9,
      lastReportedAt: 1_800_000_000_000,
      lastConfirmedAt: 1_800_000_000_100,
      supportedTransports: ["internet", "lora"],
      evidenceLevel: "BACKEND",
    },
    createdAt: 1_800_000_000_100,
    validUntil: 1_800_000_120_100,
    nonce: "control-nonce-1",
  };
  assert.deepEqual(decodeControlMessage(encodeControlMessage(message), message.createdAt), message);
  assert.throws(() => decodeControlMessage(encodeControlMessage(message), message.validUntil), /expired/);
});

test("malformed or expired-shape control messages fail closed", () => {
  assert.throws(() => decodeControlMessage(Uint8Array.of(0x80)), /Unsupported control protocol version/);
  const invalid: RoutingControlMessage = {
    kind: "EGRESS_ADVERTISEMENT",
    controlVersion: "0.1",
    senderNodeId: "node",
    advertisement: { state: "REPORTED", quality: 2, supportedTransports: [] },
    createdAt: 10,
    validUntil: 5,
    nonce: "nonce",
  };
  assert.throws(() => decodeControlMessage(encodeControlMessage(invalid)), /Invalid egress quality/);
});
