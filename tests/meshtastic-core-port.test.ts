import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceIdentity } from "../src/protocol/identity.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { CustodyBridgeTransportAdapter } from "../src/transports/custody-bridge.ts";
import {
  MESHTASTIC_CORE_DEVICE_CONFIGURED,
  MeshtasticCoreFramePort,
  meshtasticNodeAddress,
  parseMeshtasticNodeAddress,
  type MeshtasticCoreClient,
  type MeshtasticEvent,
  type MeshtasticPrivatePacket,
} from "../src/transports/meshtastic-core-port.ts";
import { MESHTASTIC_DATA_PAYLOAD_BYTES, MESHTASTIC_PRIVATE_APP_PORT } from "../src/transports/meshtastic-policy.ts";

class FakeEvent<T> implements MeshtasticEvent<T> {
  private readonly handlers = new Set<(value: T) => void>();
  subscribe(handler: (value: T) => void) {
    this.handlers.add(handler);
    return { unsubscribe: () => this.handlers.delete(handler) };
  }
  emit(value: T): void { for (const handler of this.handlers) handler(value); }
  size(): number { return this.handlers.size; }
}

class FakeMeshtasticClient implements MeshtasticCoreClient {
  readonly privatePackets = new FakeEvent<MeshtasticPrivatePacket>();
  readonly statuses = new FakeEvent<number>();
  readonly events = { onPrivatePacket: this.privatePackets, onDeviceStatus: this.statuses };
  readonly calls: unknown[][] = [];
  nextPacketId = 42;
  failure?: Error;
  onSend?: (args: Parameters<MeshtasticCoreClient["sendPacket"]>) => void | Promise<void>;

  async sendPacket(...args: Parameters<MeshtasticCoreClient["sendPacket"]>): Promise<number> {
    this.calls.push(args);
    if (this.failure) throw this.failure;
    await this.onSend?.(args);
    return this.nextPacketId;
  }
}

test("Meshtastic node addresses use canonical eight-digit hexadecimal form", () => {
  assert.equal(meshtasticNodeAddress(0x1234_abcd), "!1234abcd");
  assert.equal(parseMeshtasticNodeAddress("!1234ABCD"), 0x1234_abcd);
  assert.throws(() => parseMeshtasticNodeAddress("1234abcd"), /!xxxxxxxx/);
  assert.throws(() => meshtasticNodeAddress(-1), /unsigned 32-bit/);
});

test("port becomes available only when the official client reports configured", () => {
  const client = new FakeMeshtasticClient();
  const port = new MeshtasticCoreFramePort("meshtastic", client);
  assert.equal(port.available(), false);
  client.statuses.emit(MESHTASTIC_CORE_DEVICE_CONFIGURED);
  assert.equal(port.available(), true);
  client.statuses.emit(2);
  assert.equal(port.available(), false);
  port.dispose();
  assert.equal(client.privatePackets.size(), 0);
  assert.equal(client.statuses.size(), 0);
});

test("port sends a copied PRIVATE_APP frame as routing-ACKed unicast", async () => {
  const client = new FakeMeshtasticClient();
  const port = new MeshtasticCoreFramePort("meshtastic", client, { channel: 3, initialAvailable: true });
  const frame = new Uint8Array([1, 2, 3]);
  const result = await port.sendFrame(frame, { destination: "!1234abcd", requestRoutingAck: true });
  assert.deepEqual(result, { acceptedByLocalPort: true, acceptance: "ROUTING_ACK", transportPacketId: "42" });
  assert.equal(client.calls.length, 1);
  const [sent, portNum, destination, channel, wantAck, wantResponse, echoResponse] = client.calls[0];
  assert.deepEqual(sent, frame);
  assert.notEqual(sent, frame);
  assert.equal(portNum, MESHTASTIC_PRIVATE_APP_PORT);
  assert.equal(destination, 0x1234_abcd);
  assert.equal(channel, 3);
  assert.equal(wantAck, true);
  assert.equal(wantResponse, false);
  assert.equal(echoResponse, false);
  port.dispose();
});

test("port fails closed for broadcast, missing ACK, bad address, oversize, and SDK errors", async () => {
  const client = new FakeMeshtasticClient();
  const port = new MeshtasticCoreFramePort("meshtastic", client, { initialAvailable: true });
  assert.match((await port.sendFrame(Uint8Array.of(1), { broadcast: true, requestRoutingAck: true })).detail ?? "", /unicast-only/);
  assert.match((await port.sendFrame(Uint8Array.of(1), { destination: "!1234abcd" })).detail ?? "", /routing-ACKed/);
  assert.match((await port.sendFrame(Uint8Array.of(1), { destination: "bad", requestRoutingAck: true })).detail ?? "", /!xxxxxxxx/);
  assert.match((await port.sendFrame(new Uint8Array(MESHTASTIC_DATA_PAYLOAD_BYTES + 1), { destination: "!1234abcd", requestRoutingAck: true })).detail ?? "", /port limit/);
  client.failure = new Error("routing timeout");
  const failed = await port.sendFrame(Uint8Array.of(1), { destination: "!1234abcd", requestRoutingAck: true });
  assert.equal(failed.acceptedByLocalPort, false);
  assert.equal(failed.acceptance, "NONE");
  assert.match(failed.detail ?? "", /routing timeout/);
  client.failure = undefined;
  client.nextPacketId = Number.NaN;
  const invalidId = await port.sendFrame(Uint8Array.of(1), { destination: "!1234abcd", requestRoutingAck: true });
  assert.equal(invalidId.acceptedByLocalPort, false);
  assert.match(invalidId.detail ?? "", /invalid packet id/);
  port.dispose();
});

test("PRIVATE_APP events become isolated raw-frame receipts", async () => {
  const client = new FakeMeshtasticClient();
  const port = new MeshtasticCoreFramePort("meshtastic", client, { initialAvailable: true });
  const receipts: unknown[] = [];
  port.receiveFrame((receipt) => { receipts.push(receipt); });
  const data = new Uint8Array([9, 8, 7]);
  client.privatePackets.emit({ id: 77, type: "direct", from: 0x1111_2222, to: 0x3333_4444, channel: 0, data });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(receipts, [{
    payload: data,
    source: "!11112222",
    destination: "!33334444",
    broadcast: false,
    transportPacketId: "77",
  }]);
  assert.notEqual((receipts[0] as { payload: Uint8Array }).payload, data);
  client.privatePackets.emit({ id: 78, type: "direct", from: 1, to: 2, channel: 0, data: new Uint8Array(234) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receipts.length, 1);
  client.privatePackets.emit({ id: 79, type: "broadcast", from: 1, to: 0xffff_ffff, channel: 0, data: Uint8Array.of(1) });
  client.privatePackets.emit({ id: 80, type: "direct", from: 1, to: 2, channel: 1, data: Uint8Array.of(1) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receipts.length, 1);
  port.dispose();
});

test("Meshtastic core ports compose with custody bridges and node queues", async () => {
  const nodeNumberA = 0x1111_2222;
  const nodeNumberB = 0x3333_4444;
  const clientA = new FakeMeshtasticClient();
  const clientB = new FakeMeshtasticClient();
  clientA.onSend = ([data, portNum, destination]) => {
    assert.equal(portNum, MESHTASTIC_PRIVATE_APP_PORT);
    clientB.privatePackets.emit({
      id: clientA.nextPacketId++, type: "direct", from: nodeNumberA, to: destination as number, channel: 0, data,
    });
  };
  clientB.onSend = ([data, portNum, destination]) => {
    assert.equal(portNum, MESHTASTIC_PRIVATE_APP_PORT);
    clientA.privatePackets.emit({
      id: clientB.nextPacketId++, type: "direct", from: nodeNumberB, to: destination as number, channel: 0, data,
    });
  };
  const portA = new MeshtasticCoreFramePort("meshtastic-a", clientA, { initialAvailable: true });
  const portB = new MeshtasticCoreFramePort("meshtastic-b", clientB, { initialAvailable: true });
  const bridgeA = new CustodyBridgeTransportAdapter("bridge-a-b", portA, {
    localNodeId: "node-a", peerNodeId: "node-b", peerAddress: meshtasticNodeAddress(nodeNumberB),
  });
  const bridgeB = new CustodyBridgeTransportAdapter("bridge-b-a", portB, {
    localNodeId: "node-b", peerNodeId: "node-a", peerAddress: meshtasticNodeAddress(nodeNumberA),
  });
  const sender = new SimulatedNode("node-a", new DeterministicRoutingManager());
  const receiver = new SimulatedNode("node-b", new DeterministicRoutingManager());
  sender.addTransport(bridgeA);
  bridgeB.receive((value) => receiver.receive(value));
  const report = makeReport({ identity: createDeviceIdentity(), eventId: "meshtastic-composed", createdAt: Date.now() });
  sender.create(report);
  const [result] = await sender.flush();
  assert.deepEqual(result.accepted, ["bridge-a-b"]);
  assert.equal(sender.queue.has(report.eventId), false);
  assert.equal(receiver.queue.has(report.eventId), true);
  assert.equal(sender.deliveryEvidence.get(report.eventId)?.[0].issuerId, "node-b");
  bridgeA.dispose(); bridgeB.dispose(); portA.dispose(); portB.dispose();
});
