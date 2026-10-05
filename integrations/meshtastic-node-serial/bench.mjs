// SPDX-License-Identifier: GPL-3.0-only
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { MeshDevice } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";
import { createDeviceIdentity, signReport } from "../../src/protocol/identity.ts";
import { DeterministicRoutingManager } from "../../src/routing/manager.ts";
import { makeReport } from "../../src/simulator/fixtures.ts";
import { SimulatedNode } from "../../src/simulator/node.ts";
import { SqliteCustodyQueue } from "../../src/storage/sqlite-custody.ts";
import { SqliteStoreAndForwardQueue } from "../../src/storage/sqlite-store.ts";
import { CustodyBridgeTransportAdapter } from "../../src/transports/custody-bridge.ts";
import {
  MeshtasticSdkFramePort,
  parseMeshtasticNodeAddress,
} from "../../src/transports/meshtastic-core-port.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    device: { type: "string" },
    peer: { type: "string" },
    "node-id": { type: "string" },
    "peer-id": { type: "string" },
    channel: { type: "string", default: "0" },
    db: { type: "string" },
    "timeout-ms": { type: "string", default: "30000" },
    "key-id": { type: "string" },
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

function usage() {
  console.log(`Meshtastic two-radio bench (synthetic data only)

Receiver:
  npm run bench -- --mode receive --device /dev/ttyACM0 \\
    --node-id bench-b --peer-id bench-a --peer !11112222

Sender:
  npm run bench -- --mode send --device /dev/ttyACM1 \\
    --node-id bench-a --peer-id bench-b --peer !33334444

Options:
  --channel 0..7             Meshtastic channel index (default 0)
  --db PATH                  SQLite custody file under .data by default
  --timeout-ms N             Configuration/custody timeout (default 30000)
  --key-id ID                Enable authenticated ACKs; read the secret from
                             EMERGENCY_MESH_ACK_KEY_HEX (at least 32 bytes)
  --dry-run                  Validate configuration without opening serial

Both radios must already share compatible Meshtastic region, modem, and channel
configuration. A serial device must already be visible inside Ubuntu WSL2.`);
}

if (values.help) {
  usage();
  process.exit(0);
}

const mode = values.mode;
if (mode !== "send" && mode !== "receive") throw new Error("--mode must be send or receive");
if (!values.device || !values.peer || !values["node-id"] || !values["peer-id"]) {
  throw new Error("--device, --peer, --node-id, and --peer-id are required");
}
parseMeshtasticNodeAddress(values.peer);

const channel = Number(values.channel);
if (!Number.isInteger(channel) || channel < 0 || channel > 7) throw new Error("--channel must be an integer from 0 to 7");
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be a positive integer");

function acknowledgementAuthentication() {
  const keyId = values["key-id"];
  const encoded = process.env.EMERGENCY_MESH_ACK_KEY_HEX;
  if (!keyId && !encoded) return undefined;
  if (!keyId || !encoded) throw new Error("--key-id and EMERGENCY_MESH_ACK_KEY_HEX must be supplied together");
  if (!/^(?:[0-9a-fA-F]{2}){32,}$/.test(encoded)) {
    throw new Error("EMERGENCY_MESH_ACK_KEY_HEX must encode at least 32 bytes");
  }
  return { keyId, secret: Buffer.from(encoded, "hex") };
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitUntilConfigured(port) {
  const deadline = Date.now() + timeoutMs;
  while (!port.available() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!port.available()) throw new Error("Meshtastic device did not reach configured status");
}

function syntheticReport() {
  const identity = createDeviceIdentity();
  const original = makeReport({
    identity,
    eventId: `bench-${randomUUID()}`,
    eventType: "AREA_STATUS",
    priority: "LOW",
    createdAt: Date.now(),
  });
  const { signature: _signature, ...unsigned } = original;
  return signReport({
    ...unsigned,
    shortMessage: "SYNTHETIC BENCH TEST - NOT AN EMERGENCY",
  }, identity);
}

const databasePath = values.db ?? `.data/meshtastic-bench-${mode}.sqlite`;
const ackAuthentication = acknowledgementAuthentication();
if (values["dry-run"]) {
  console.log(JSON.stringify({
    state: "DRY_RUN_VALID",
    mode,
    device: values.device,
    peer: values.peer,
    nodeId: values["node-id"],
    peerId: values["peer-id"],
    channel,
    databasePath,
    authenticatedAcknowledgements: Boolean(ackAuthentication),
  }, null, 2));
  process.exit(0);
}
mkdirSync(dirname(databasePath), { recursive: true });
const transport = await TransportNodeSerial.create(values.device, 115200);
const client = new MeshDevice(transport);
const port = new MeshtasticSdkFramePort(`serial-${values["node-id"]}`, client, { channel });
const bridge = new CustodyBridgeTransportAdapter(`bench-${values["node-id"]}-${values["peer-id"]}`, port, {
  localNodeId: values["node-id"],
  peerNodeId: values["peer-id"],
  peerAddress: values.peer,
  acknowledgementTimeoutMs: timeoutMs,
  ackAuthentication,
});
let queue;

async function close() {
  bridge.dispose();
  port.dispose();
  queue?.close();
  await transport.disconnect();
}

try {
  await withTimeout(client.configure(), "Meshtastic configuration request");
  await waitUntilConfigured(port);
  console.log(JSON.stringify({
    state: "CONFIGURED",
    mode,
    device: values.device,
    channel,
    maximumFrameBytes: port.capabilities().maximumFrameBytes,
  }));

  if (mode === "receive") {
    queue = new SqliteCustodyQueue(databasePath);
    bridge.connectCustodyReceiver((envelope) => {
      const acknowledgement = queue.acceptCustody(envelope, values["node-id"]);
      console.log(JSON.stringify({
        state: acknowledgement ? "CUSTODY_ACCEPTED" : "CUSTODY_REJECTED",
        eventId: envelope.report.eventId,
        packetId: envelope.packetId,
        acknowledgement,
      }));
      return acknowledgement;
    });
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    console.log(JSON.stringify({ state: "STOPPED", portStats: port.stats() }, null, 2));
  } else {
    queue = new SqliteStoreAndForwardQueue(databasePath);
    const node = new SimulatedNode(values["node-id"], new DeterministicRoutingManager(), undefined, queue);
    node.addTransport(bridge);
    const report = syntheticReport();
    node.create(report);
    const startedAt = Date.now();
    const [result] = await node.flush();
    const accepted = result?.accepted.includes(bridge.id) ?? false;
    console.log(JSON.stringify({
      state: accepted ? "PEER_CUSTODY_CONFIRMED" : "SENDER_RETAINED_CUSTODY",
      eventId: report.eventId,
      result,
      evidence: node.deliveryEvidence.get(report.eventId) ?? [],
      durationMs: Date.now() - startedAt,
      portStats: port.stats(),
      queued: node.queue.has(report.eventId),
    }, null, 2));
    if (!accepted) process.exitCode = 2;
  }
} finally {
  await close();
}
