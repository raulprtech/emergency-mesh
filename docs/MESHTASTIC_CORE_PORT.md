# Meshtastic SDK compatibility and serial bench

`MeshtasticSdkFramePort` adapts the shared `sendPacket`, `onPrivatePacket`, and device-status surface to `RawFramePort`. The Apache-2.0 root keeps this structural and dependency-free; `MeshtasticCoreFramePort` remains a backward-compatible class alias.

## Audited upstream surface

The boundary was rechecked on 2026-08-15 against both official generations:

- Active `meshtastic/web` commit `1db40fe80bc6adc737eb045943c533292efaee92`, where `@meshtastic/sdk` 1.0 declares that it replaces `@meshtastic/core`.
- Active `MeshClient.sendPacket(...)`, `events.onPrivatePacket`, `events.onDeviceStatus`, and configured status 7.
- Archived `meshtastic/js` commit `38ebaad3e2ab390801bc62ce859ef0ea0eba1b9b`.
- Published `@meshtastic/core@2.6.7` and `@meshtastic/transport-node-serial@0.0.2`.

The active 1.0 packages were not published in NPM or JSR on that date. The isolated bench therefore pins the archived published generation provisionally while retaining a structural shape compatible with active `MeshClient`.

Both official generations are GPL-3.0-only. The root package does not import them. The private `integrations/meshtastic-node-serial` subpackage contains the exact runtime dependency and is marked GPL-3.0-only. Distribution still requires a specific license review; directory separation is an engineering boundary, not a legal conclusion.

## Mapping

| Emergency Mesh | compatible Meshtastic SDK client |
| --- | --- |
| frame bytes | `sendPacket` byte data |
| application protocol | `PRIVATE_APP` / 256 |
| peer address | canonical `!xxxxxxxx` node number |
| channel | configured channel index 0–7 |
| routing request | `wantAck = true` |
| application response | `wantResponse = false` |
| local echo | `echoResponse = false` |
| received frame | `events.onPrivatePacket` data |

Every outbound byte array is copied before entering the SDK. Inbound bytes are size-checked, copied, and delivered only while the SDK reports a configured device. SDK exceptions and routing failures become `acceptedByLocalPort: false` and never become Emergency Mesh custody.

## Why this port is unicast-only

The published 2.6.7 and audited active SDK queues complete `sendPacket` through routing acknowledgement. Meshtastic firmware clears `want_ack` on broadcasts to avoid ACK storms. Treating that promise as successful broadcast acceptance would therefore be ambiguous or timeout-prone. This compatibility port rejects broadcast and any call that does not request a routing ACK.

The custody bridge uses routing-ACKed unicast for both fragments and its compact custody ACK. A routing ACK only confirms Meshtastic routing; `CustodyBridgeTransportAdapter` still waits for the separate remote reassembly-and-queue ACK before returning `PEER` custody.

## Deployment composition

A deployment, not the core library, is responsible for:

1. Installing a reviewed Meshtastic SDK and one official BLE, serial, TCP, or HTTP transport.
2. Constructing `MeshDevice` for the published provisional runtime or `MeshClient` after the active 1.0 packages ship.
3. Passing that object to `MeshtasticSdkFramePort`.
4. Pairing the port with a peer-specific `CustodyBridgeTransportAdapter` using the peer's canonical `!xxxxxxxx` address.
5. Connecting a `SqliteCustodyQueue` through `connectCustodyReceiver()` so queue admission and ACK persistence are atomic across restart.
6. Configuring the same provisioned `ackAuthentication` key id and secret on both peer bridges so legacy or forged ACKs fail closed.
7. Disposing bridge, port, and queue when the device session ends.

The isolated serial subpackage pins exact published versions and runs `npm run contract` against their real exports without opening hardware. The active 1.0 API is pinned by audited commit until immutable registry artifacts exist.

## Validation status

Automated tests cover address canonicalization, configured/disconnected lifecycle, exact `sendPacket` argument mapping, frame copies, MTU enforcement, SDK errors, inbound `PRIVATE_APP` mapping, subscription disposal, and full composition through two ports, two custody bridges, and two node queues.

The real serial transport package, reproducible lockfile, contract check, CLI help, and hardware-free dry run are present. Still required: two configured radios, regional settings, queue/backpressure measurements, disconnect/reboot tests, and recorded physical results. See `integrations/meshtastic-node-serial/README.md`.
