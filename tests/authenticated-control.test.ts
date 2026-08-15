import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import {
  decodeAuthenticatedControlMessage,
  encodeAuthenticatedControlMessage,
  type ControlFrameAuthentication,
} from "../src/transports/authenticated-control.ts";
import { CustodyBridgeTransportAdapter } from "../src/transports/custody-bridge.ts";
import type { RoutingControlMessage } from "../src/transports/control.ts";
import type {
  RawFramePort,
  RawFramePortCapabilities,
  RawFrameReceipt,
  RawFrameSendOptions,
  RawFrameSendResult,
} from "../src/transports/raw-frame-port.ts";

const now = 1_800_000_000_000;
const sharedAuthentication: ControlFrameAuthentication = {
  keyId: "mesh-neighbors-v1",
  secret: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
};

const acknowledgementMessage: RoutingControlMessage = {
  kind: "ACK",
  controlVersion: "0.1",
  senderNodeId: "node-b",
  acknowledgement: {
    acknowledgementId: "ack-authenticated",
    eventId: "event-authenticated",
    packetId: "packet-authenticated",
    level: "PEER",
    acknowledgedAt: now,
    issuerId: "node-b",
    status: "CUSTODY_ACCEPTED",
  },
};

class MemoryFramePort implements RawFramePort {
  readonly id: string;
  readonly address: string;
  peer?: MemoryFramePort;
  private readonly handlers = new Set<(receipt: RawFrameReceipt) => void | Promise<void>>();

  constructor(id: string, address: string) {
    this.id = id;
    this.address = address;
  }

  available(): boolean { return Boolean(this.peer); }
  capabilities(): RawFramePortCapabilities {
    return {
      maximumFrameBytes: 233,
      medium: "LORA",
      bidirectional: true,
      broadcast: true,
      transportOwnsRouting: true,
      transportOwnsEncryption: true,
      acknowledgement: "ROUTING_ACK",
    };
  }

  async sendFrame(frame: Uint8Array, options: RawFrameSendOptions = {}): Promise<RawFrameSendResult> {
    if (!this.peer || options.destination !== this.peer.address || frame.length > 233) {
      return { acceptedByLocalPort: false, acceptance: "NONE" };
    }
    const receipt: RawFrameReceipt = {
      payload: frame.slice(),
      source: this.address,
      destination: options.destination,
      broadcast: false,
    };
    for (const handler of this.peer.handlers) await handler(receipt);
    return { acceptedByLocalPort: true, acceptance: "ROUTING_ACK" };
  }

  receiveFrame(handler: (receipt: RawFrameReceipt) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

function linkedPorts(): [MemoryFramePort, MemoryFramePort] {
  const left = new MemoryFramePort("port-a", "address-a");
  const right = new MemoryFramePort("port-b", "address-b");
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function bridge(
  id: string,
  port: RawFramePort,
  localNodeId: string,
  peerNodeId: string,
  peerAddress: string,
  ackAuthentication?: ControlFrameAuthentication,
) {
  return new CustodyBridgeTransportAdapter(id, port, {
    localNodeId,
    peerNodeId,
    peerAddress,
    acknowledgementTimeoutMs: 10,
    ackAuthentication,
    now: () => now,
  });
}

function envelope(eventId: string) {
  const origin = new SimulatedNode("origin", new DeterministicRoutingManager());
  return origin.create(makeReport({ eventId, createdAt: now }));
}

test("authenticated control frame round trips and rejects tampering or the wrong key", () => {
  const frame = encodeAuthenticatedControlMessage(acknowledgementMessage, sharedAuthentication);
  assert.deepEqual(decodeAuthenticatedControlMessage(frame, sharedAuthentication), acknowledgementMessage);

  const tampered = frame.slice();
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decodeAuthenticatedControlMessage(tampered, sharedAuthentication), /tag mismatch/);
  assert.throws(() => decodeAuthenticatedControlMessage(frame, {
    ...sharedAuthentication,
    secret: new Uint8Array(32).fill(9),
  }), /tag mismatch/);
  assert.throws(() => decodeAuthenticatedControlMessage(frame, {
    ...sharedAuthentication,
    keyId: "rotated-key",
  }), /keyId mismatch/);
});

test("bridge releases custody after a correctly authenticated peer ACK", async () => {
  const [portA, portB] = linkedPorts();
  const sender = bridge("bridge-a-b", portA, "node-a", "node-b", "address-b", sharedAuthentication);
  const receiver = bridge("bridge-b-a", portB, "node-b", "node-a", "address-a", sharedAuthentication);
  receiver.receive(() => true);

  const result = await sender.send(envelope("authenticated-custody"));
  assert.equal(result.accepted, true);
  assert.equal(result.acknowledgement, "PEER");
  assert.equal(result.evidence?.issuerId, "node-b");
  sender.dispose();
  receiver.dispose();
});

test("configured authentication rejects wrong-key and legacy ACK downgrade", async () => {
  const wrongAuthentication = {
    ...sharedAuthentication,
    secret: new Uint8Array(32).fill(7),
  };

  const [wrongPortA, wrongPortB] = linkedPorts();
  const wrongSender = bridge("wrong-sender", wrongPortA, "node-a", "node-b", "address-b", sharedAuthentication);
  const wrongReceiver = bridge("wrong-receiver", wrongPortB, "node-b", "node-a", "address-a", wrongAuthentication);
  wrongReceiver.receive(() => true);
  assert.equal((await wrongSender.send(envelope("wrong-key-custody"))).accepted, false);
  wrongSender.dispose();
  wrongReceiver.dispose();

  const [legacyPortA, legacyPortB] = linkedPorts();
  const protectedSender = bridge("protected-sender", legacyPortA, "node-a", "node-b", "address-b", sharedAuthentication);
  const legacyReceiver = bridge("legacy-receiver", legacyPortB, "node-b", "node-a", "address-a");
  legacyReceiver.receive(() => true);
  const downgraded = await protectedSender.send(envelope("downgrade-custody"));
  assert.equal(downgraded.accepted, false);
  assert.match(downgraded.detail ?? "", /timed out/);
  protectedSender.dispose();
  legacyReceiver.dispose();
});

test("bridge validates authentication configuration at construction", () => {
  const [portA] = linkedPorts();
  assert.throws(() => bridge("short-key", portA, "node-a", "node-b", "address-b", {
    keyId: "key",
    secret: new Uint8Array(31),
  }), /at least 32 bytes/);
  assert.throws(() => bridge("bad-id", portA, "node-a", "node-b", "address-b", {
    keyId: "contains spaces",
    secret: new Uint8Array(32),
  }), /keyId is invalid/);
});
