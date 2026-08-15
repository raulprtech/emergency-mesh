# Meshtastic core compatibility port

`MeshtasticCoreFramePort` adapts the published `@meshtastic/core` 2.6.x `MeshDevice` surface to `RawFramePort`. It is implemented and tested without a hardware transport or a runtime dependency on Meshtastic packages.

## Audited upstream surface

The compatibility boundary was checked on 2026-08-15 against:

- JSR `@meshtastic/core` 2.6.6 documentation.
- `meshtastic/js` master commit `38ebaad3e2ab390801bc62ce859ef0ea0eba1b9b`.
- `MeshDevice.sendPacket(byteData, portNum, destination, channel, wantAck, wantResponse, echoResponse)`.
- `events.onPrivatePacket`, whose payload is `PacketMetadata<Uint8Array>`.
- `events.onDeviceStatus`, where configured status is numeric value 7.

The upstream repository is GPL-3.0. This repository does not copy its implementation, import it, or declare it as a core dependency. Instead, the port accepts a structural `MeshtasticCoreClient` supplied by a deployment composition root. Shipping a product that combines these components still requires a distribution-specific license review; this separation is an engineering boundary, not a legal conclusion.

## Mapping

| Emergency Mesh | `@meshtastic/core` 2.6.x |
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

The published 2.6.x SDK's `sendPacket` promise is completed by its routing-ACK queue. Meshtastic firmware clears `want_ack` on broadcasts to avoid ACK storms. Treating that promise as successful broadcast acceptance would therefore be ambiguous or timeout-prone. This compatibility port rejects broadcast and any call that does not request a routing ACK.

The custody bridge uses routing-ACKed unicast for both fragments and its compact custody ACK. A routing ACK only confirms Meshtastic routing; `CustodyBridgeTransportAdapter` still waits for the separate remote reassembly-and-queue ACK before returning `PEER` custody.

## Deployment composition

A deployment, not the core library, is responsible for:

1. Installing a reviewed Meshtastic SDK and one official BLE, serial, TCP, or HTTP transport.
2. Constructing and configuring its `MeshDevice`.
3. Passing that object to `MeshtasticCoreFramePort`.
4. Pairing the port with a peer-specific `CustodyBridgeTransportAdapter` using the peer's canonical `!xxxxxxxx` address.
5. Disposing both bridge and port when the device session ends.

Because no SDK package is installed here, upstream API drift cannot be caught by this repository alone. A deployable integration package must pin an exact SDK version and run contract tests against the real package.

## Validation status

Automated tests cover address canonicalization, configured/disconnected lifecycle, exact `sendPacket` argument mapping, frame copies, MTU enforcement, SDK errors, inbound `PRIVATE_APP` mapping, subscription disposal, and full composition through two ports, two custody bridges, and two node queues.

Still required: a real transport package, two configured radios, regional radio settings, queue/backpressure measurements, disconnect/reboot tests, and exact-version contract CI.
