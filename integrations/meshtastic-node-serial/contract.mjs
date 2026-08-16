// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { MeshDevice } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";
import { MeshtasticSdkFramePort } from "../../src/transports/meshtastic-core-port.ts";

assert.equal(typeof MeshDevice, "function");
assert.equal(typeof TransportNodeSerial.create, "function");

const transport = {
  toDevice: new WritableStream({ write() {} }),
  fromDevice: new ReadableStream({ start() {} }),
  async disconnect() {},
};
const client = new MeshDevice(transport);
assert.equal(typeof client.sendPacket, "function");
assert.equal(typeof client.configure, "function");
assert.equal(typeof client.events?.onPrivatePacket?.subscribe, "function");
assert.equal(typeof client.events?.onDeviceStatus?.subscribe, "function");

const port = new MeshtasticSdkFramePort("published-sdk-contract", client);
assert.equal(port.available(), false);
assert.equal(port.capabilities().maximumFrameBytes, 233);
port.dispose();

console.log(JSON.stringify({
  success: true,
  core: "@meshtastic/core@2.6.7",
  transport: "@meshtastic/transport-node-serial@0.0.2",
  note: "structural contract only; no radio was opened",
}, null, 2));
