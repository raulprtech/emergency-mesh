import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { SqliteCustodyQueue } from "../src/storage/sqlite-custody.ts";
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
  dropNextControlFrame = false;
  private readonly mtu: number;
  private readonly handlers = new Set<(receipt: RawFrameReceipt) => void | Promise<void>>();

  constructor(id: string, address: string, mtu = 180) {
    this.id = id;
    this.address = address;
    this.mtu = mtu;
  }

  available(): boolean { return Boolean(this.peer); }
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
    if (!this.peer || options.destination !== this.peer.address || frame.length > this.mtu) {
      return { acceptedByLocalPort: false, acceptance: "NONE" };
    }
    if (this.dropNextControlFrame && frame[0] >> 5 === 4) {
      this.dropNextControlFrame = false;
      return { acceptedByLocalPort: true, acceptance: "ROUTING_ACK" };
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

function bridge(id: string, port: RawFramePort, localNodeId: string, peerNodeId: string, peerAddress: string) {
  return new CustodyBridgeTransportAdapter(id, port, {
    localNodeId,
    peerNodeId,
    peerAddress,
    acknowledgementTimeoutMs: 10,
    now: () => now,
  });
}

test("lost custody ACK is replayed from SQLite after receiver restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "emergency-mesh-bridge-custody-"));
  const path = join(directory, "custody.sqlite");
  const [portA, portB] = linkedPorts();
  const sender = bridge("bridge-a-b", portA, "node-a", "node-b", "address-b");
  let receiver = bridge("bridge-b-a", portB, "node-b", "node-a", "address-a");
  let queue = new SqliteCustodyQueue(path);
  receiver.connectCustodyReceiver((value) => queue.acceptCustody(value, "node-b", now));
  const origin = new SimulatedNode("origin", new DeterministicRoutingManager());
  const value = origin.create(makeReport({ eventId: "restart-safe-custody", createdAt: now }));

  try {
    portB.dropNextControlFrame = true;
    const first = await sender.send(value);
    assert.equal(first.accepted, false);
    assert.equal(queue.size(), 1);
    const persisted = queue.custodyReceipt(value.report.eventId, value.packetId, now);
    assert.ok(persisted);

    receiver.dispose();
    queue.close();
    queue = new SqliteCustodyQueue(path);
    receiver = bridge("bridge-b-a-restarted", portB, "node-b", "node-a", "address-a");
    receiver.connectCustodyReceiver((incoming) => queue.acceptCustody(incoming, "node-b", now + 1));

    const retry = await sender.send(value);
    assert.equal(retry.accepted, true);
    assert.equal(retry.acknowledgement, "PEER");
    assert.deepEqual(retry.evidence, persisted);
    assert.equal(queue.size(), 1, "restart retry must not enqueue a second copy");
  } finally {
    sender.dispose();
    receiver.dispose();
    queue.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bridge refuses malformed acknowledgements returned by a durable receiver", async () => {
  const [portA, portB] = linkedPorts();
  const sender = bridge("bridge-a-b", portA, "node-a", "node-b", "address-b");
  const receiver = bridge("bridge-b-a", portB, "node-b", "node-a", "address-a");
  receiver.connectCustodyReceiver((value) => ({
    acknowledgementId: "wrong-issuer",
    eventId: value.report.eventId,
    packetId: value.packetId,
    level: "PEER",
    acknowledgedAt: now,
    issuerId: "attacker",
    status: "CUSTODY_ACCEPTED",
  }));
  const origin = new SimulatedNode("origin", new DeterministicRoutingManager());
  const value = origin.create(makeReport({ eventId: "malformed-durable-ack", createdAt: now }));

  const result = await sender.send(value);
  assert.equal(result.accepted, false);
  assert.match(result.detail ?? "", /timed out/);
  sender.dispose();
  receiver.dispose();
});

test("volatile and durable custody receivers are mutually exclusive", () => {
  const [, portB] = linkedPorts();
  const receiver = bridge("bridge-b-a", portB, "node-b", "node-a", "address-a");
  receiver.connectCustodyReceiver(() => undefined);
  assert.throws(() => receiver.receive(() => true), /durable custody receiver/);
  assert.throws(() => receiver.connectCustodyReceiver(() => undefined), /already has a receiver/);
  receiver.dispose();
});
