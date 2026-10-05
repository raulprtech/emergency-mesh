import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceIdentity, signReport } from "../src/protocol/identity.ts";
import { CONTROL_PROTOCOL_VERSION, encodeControlMessage } from "../src/transports/control.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { CustodyBridgeTransportAdapter } from "../src/transports/custody-bridge.ts";
import type {
  RawFramePort,
  RawFramePortCapabilities,
  RawFrameReceipt,
  RawFrameSendOptions,
  RawFrameSendResult,
} from "../src/transports/raw-frame-port.ts";

const now = 1_800_000_000_000;

class MemoryFramePort implements RawFramePort {
  readonly id: string;
  readonly address: string;
  peer?: MemoryFramePort;
  enabled = true;
  dropNextAck = false;
  sentFrames = 0;
  private readonly handlers = new Set<(receipt: RawFrameReceipt) => void | Promise<void>>();
  private readonly mtu: number;

  constructor(id: string, address: string, mtu = 233) {
    this.id = id;
    this.address = address;
    this.mtu = mtu;
  }

  available(): boolean { return this.enabled && Boolean(this.peer?.enabled); }
  capabilities(): RawFramePortCapabilities {
    return {
      maximumFrameBytes: this.mtu,
      medium: "LORA",
      bidirectional: true,
      broadcast: true,
      transportOwnsRouting: true,
      transportOwnsEncryption: true,
      acknowledgement: "ROUTING_ACK",
    };
  }

  async sendFrame(frame: Uint8Array, options: RawFrameSendOptions = {}): Promise<RawFrameSendResult> {
    this.sentFrames += 1;
    if (!this.available() || !this.peer || options.destination !== this.peer.address || frame.length > this.mtu) {
      return { acceptedByLocalPort: false, acceptance: "NONE", detail: "memory link unavailable" };
    }
    if (this.dropNextAck && frame[0] >> 5 === 4) {
      this.dropNextAck = false;
      return { acceptedByLocalPort: true, acceptance: "LOCAL_QUEUE" };
    }
    const receipt: RawFrameReceipt = {
      payload: frame.slice(),
      source: this.address,
      destination: options.destination,
      broadcast: false,
      transportPacketId: String(this.sentFrames),
    };
    for (const handler of this.peer.handlers) await handler(receipt);
    return { acceptedByLocalPort: true, acceptance: options.requestRoutingAck ? "ROUTING_ACK" : "LOCAL_QUEUE" };
  }

  receiveFrame(handler: (receipt: RawFrameReceipt) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async inject(receipt: RawFrameReceipt): Promise<void> {
    for (const handler of this.handlers) await handler(receipt);
  }
}

function linkedPorts(mtu = 233): [MemoryFramePort, MemoryFramePort] {
  const left = new MemoryFramePort("port-a", "address-a", mtu);
  const right = new MemoryFramePort("port-b", "address-b", mtu);
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function envelope(eventId: string, padding = 1_000) {
  const identity = createDeviceIdentity();
  const original = makeReport({ identity, eventId, createdAt: now });
  const { signature: _signature, ...unsigned } = original;
  const report = signReport({ ...unsigned, extensions: { "x-padding": "x".repeat(padding) } }, identity);
  return {
    packetId: `packet-${eventId}`,
    report,
    expiresAt: report.validUntil,
    hopCount: 0,
    hopLimit: 12,
    transportHistory: [],
  };
}

test("bridge claims PEER custody only after remote reassembly and receiver acceptance", async () => {
  const [portA, portB] = linkedPorts(180);
  const sender = new CustodyBridgeTransportAdapter("bridge-a-b", portA, {
    localNodeId: "node-a", peerNodeId: "node-b", peerAddress: "address-b", now: () => now,
  });
  const receiver = new CustodyBridgeTransportAdapter("bridge-b-a", portB, {
    localNodeId: "node-b", peerNodeId: "node-a", peerAddress: "address-a", now: () => now,
  });
  const received: string[] = [];
  receiver.receive((value) => { received.push(value.report.eventId); return true; });
  const value = envelope("physical-custody", 2_000);
  const result = await sender.send(value);
  assert.equal(result.accepted, true);
  assert.equal(result.acknowledgement, "PEER");
  assert.equal(result.evidence?.issuerId, "node-b");
  assert.deepEqual(received, [value.report.eventId]);
  assert.ok(portA.sentFrames > 1);
  sender.dispose(); receiver.dispose();
});

test("bridge retains sender custody when the remote queue rejects the envelope", async () => {
  const [portA, portB] = linkedPorts(180);
  const sender = new CustodyBridgeTransportAdapter("bridge-a-b", portA, {
    localNodeId: "node-a", peerNodeId: "node-b", peerAddress: "address-b",
    acknowledgementTimeoutMs: 10, now: () => now,
  });
  const receiver = new CustodyBridgeTransportAdapter("bridge-b-a", portB, {
    localNodeId: "node-b", peerNodeId: "node-a", peerAddress: "address-a", now: () => now,
  });
  receiver.receive(() => false);
  const result = await sender.send(envelope("rejected-custody"));
  assert.equal(result.accepted, false);
  assert.match(result.detail ?? "", /timed out/);
  sender.dispose(); receiver.dispose();
});

test("lost custody ACK is resent from bounded acceptance memory without enqueueing twice", async () => {
  const [portA, portB] = linkedPorts(180);
  const sender = new CustodyBridgeTransportAdapter("bridge-a-b", portA, {
    localNodeId: "node-a", peerNodeId: "node-b", peerAddress: "address-b",
    acknowledgementTimeoutMs: 10, now: () => now,
  });
  const receiver = new CustodyBridgeTransportAdapter("bridge-b-a", portB, {
    localNodeId: "node-b", peerNodeId: "node-a", peerAddress: "address-a", now: () => now,
  });
  let accepted = 0;
  receiver.receive(() => { accepted += 1; return true; });
  portB.dropNextAck = true;
  const value = envelope("lost-ack");
  const first = await sender.send(value);
  assert.equal(first.accepted, false);
  const second = await sender.send(value);
  assert.equal(second.accepted, true);
  assert.equal(accepted, 1);
  sender.dispose(); receiver.dispose();
});

test("simulated sender releases its queue only after remote bridge custody", async () => {
  const [portA, portB] = linkedPorts(180);
  const bridgeA = new CustodyBridgeTransportAdapter("bridge-a-b", portA, {
    localNodeId: "node-a", peerNodeId: "node-b", peerAddress: "address-b", now: () => now,
  });
  const bridgeB = new CustodyBridgeTransportAdapter("bridge-b-a", portB, {
    localNodeId: "node-b", peerNodeId: "node-a", peerAddress: "address-a", now: () => now,
  });
  const senderNode = new SimulatedNode("node-a", new DeterministicRoutingManager());
  const receiverNode = new SimulatedNode("node-b", new DeterministicRoutingManager());
  senderNode.addTransport(bridgeA);
  bridgeB.receive((value) => receiverNode.receive(value, now));
  const report = makeReport({ identity: createDeviceIdentity(), eventId: "node-bridge-custody", createdAt: now });
  senderNode.create(report);
  const [result] = await senderNode.flush(now);
  assert.deepEqual(result.accepted, ["bridge-a-b"]);
  assert.equal(senderNode.queue.has(report.eventId), false);
  assert.equal(receiverNode.queue.has(report.eventId), true);
  assert.equal(senderNode.deliveryEvidence.get(report.eventId)?.[0].level, "PEER");
  bridgeA.dispose(); bridgeB.dispose();
});

test("bridge rejects transfers whose custody ACK cannot fit the physical MTU", async () => {
  const [portA] = linkedPorts(180);
  const sender = new CustodyBridgeTransportAdapter("bridge-a-b", portA, {
    localNodeId: "node-a", peerNodeId: "n".repeat(200), peerAddress: "address-b", now: () => now,
  });
  const result = await sender.send(envelope("oversized-ack", 0));
  assert.equal(result.accepted, false);
  assert.match(result.detail ?? "", /custody ACK exceeds physical frame limit/);
  assert.equal(portA.sentFrames, 0);
  sender.dispose();
});

test("bridge ignores forged custody ACKs from the wrong physical source", async () => {
  const [portA, portB] = linkedPorts(180);
  const sender = new CustodyBridgeTransportAdapter("bridge-a-b", portA, {
    localNodeId: "node-a", peerNodeId: "node-b", peerAddress: "address-b",
    acknowledgementTimeoutMs: 10, now: () => now,
  });
  const receiver = new CustodyBridgeTransportAdapter("bridge-b-a", portB, {
    localNodeId: "node-b", peerNodeId: "node-a", peerAddress: "address-a", now: () => now,
  });
  receiver.receive(() => false);
  const value = envelope("no-false-custody");
  const pending = sender.send(value);
  await portA.inject({
    payload: encodeControlMessage({
      kind: "ACK",
      controlVersion: CONTROL_PROTOCOL_VERSION,
      senderNodeId: "node-b",
      acknowledgement: {
        acknowledgementId: "forged-ack",
        eventId: value.report.eventId,
        packetId: value.packetId,
        level: "PEER",
        acknowledgedAt: now,
        issuerId: "node-b",
        status: "CUSTODY_ACCEPTED",
      },
    }),
    source: "attacker-address",
    destination: "address-a",
    broadcast: false,
  });
  const result = await pending;
  assert.equal(result.accepted, false);
  sender.dispose(); receiver.dispose();
});
