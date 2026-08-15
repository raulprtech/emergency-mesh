# Physical transport feasibility

Status: design spike only. No physical radio has been connected or certified by this repository.

## Decision

Implement the first hardware experiment against Meshtastic's supported PhoneAPI. Keep Bitchat as a deferred native-integration candidate until its project exposes or accepts a stable application-payload boundary. Emergency Mesh owns its signed envelope, fragmentation, reassembly, queue, and custody semantics; the underlying product continues to own discovery, radio links, routing, encryption, retries, and power management.

The physical code boundary is `RawFramePort`. A physical port receives opaque, already-fragmented bytes and reports only local or routing acceptance. Neither a local device queue nor a radio routing ACK permits the sender to remove its Emergency Mesh queue entry. The reference `CustodyBridgeTransportAdapter` now implements the next layer: unicast reassembly, remote queue acceptance, a correlated protocol-level `PEER` ACK, timeout-safe sender retention, and bounded lost-ACK replay. It remains hardware-independent and does not make any radio supported.

## Feasibility matrix

| Criterion | Meshtastic | Bitchat/BLE |
| --- | --- | --- |
| Supported host boundary | PhoneAPI over BLE, serial, TCP, or HTTP; structural `@meshtastic/core` 2.6 compatibility port implemented | Native application's internal `Transport` abstraction; no documented external arbitrary-payload API found |
| Application payload | `Data.payload`, `PRIVATE_APP` port 256 | Typed Bitchat packet/application messages; adding an Emergency Mesh type requires upstream/native work |
| Payload ceiling | 233 bytes per `Data.payload`; Emergency Mesh fragmentation can target this ceiling | Link fragmentation is internal and currently described around 469-byte chunks, but it is not a stable external contract |
| Routing | Owned by Meshtastic firmware | Owned by Bitchat |
| Encryption | Owned by configured Meshtastic channel/PKI; Emergency Mesh protected payload may add end-to-end confidentiality | Owned by Bitchat for its private-message paths; public traffic remains public |
| ACK meaning | Unicast `want_ack` produces a routing response; broadcasts clear it to avoid ACK storms | Delivery/read receipts exist for private chat, but do not establish Emergency Mesh queue custody |
| Background and power | Platform/SDK/hardware-dependent; must be measured | Native duty cycling exists; still must be measured on supported phones |
| Licensing boundary | Official firmware, protobufs, and clients are GPL-3.0; isolate optional integration and review distribution obligations | iOS/macOS repository is public domain; Android repository is GPL-3.0; review each target independently |
| MVP disposition | First bench candidate | Deferred pending a stable upstream integration boundary |

Licensing notes are engineering risk flags, not legal advice. The Apache-2.0 core should not copy GPL implementation code. Any optional adapter that imports, links, modifies, or distributes GPL components needs a distribution-specific license review.

## Meshtastic mapping

- One Emergency Mesh fragment becomes one Meshtastic `Data.payload` on port 256.
- The physical frame ceiling is 233 bytes, including the complete Emergency Mesh fragment frame.
- Destination `0xFFFFFFFF` is broadcast. Broadcast never requests ACK.
- A unicast may request a Meshtastic routing ACK, but that ACK is diagnostic evidence only.
- The adapter must respect PhoneAPI queue status/backpressure and must not assume a large radio queue.
- The adapter must subscribe only to port 256 traffic intended for this application and pass the raw payload to bounded reassembly.
- `MeshtasticCoreFramePort` maps the published 2.6.x `sendPacket` and `onPrivatePacket` surface without importing the GPL runtime into the core.
- Region, frequency, duty-cycle, channel, and transmit-power configuration remain deployment responsibilities and must comply with local rules.

## Bitchat integration guardrails

- Do not reimplement or bypass Bitchat routing, discovery, Noise sessions, courier controls, quotas, or fragmentation.
- Do not encode opaque Emergency Mesh frames as public chat text: it leaks content/metadata, has the wrong retention semantics, and can create amplification or moderation problems.
- Prefer an upstream-reviewed application packet type or a small native extension that exposes opaque received bytes and send results.
- Keep iOS/macOS and Android licensing, lifecycle, security posture, and protocol drift as separate validation tracks.

## Required bench validation

1. Connect two supported Meshtastic devices through one official SDK transport.
2. Send 1-, 2-, and multi-fragment envelopes on private app port 256; verify exact byte preservation.
3. Test unicast, broadcast, packet loss, duplicate delivery, reordering, radio reboot, and full outbound queues.
4. Prove that loss of a routing ACK retains sender custody and that only a remote Emergency Mesh custody ACK releases it.
5. Measure latency, useful throughput, energy use, practical range, reconnect behavior, and background reliability.
6. Record firmware, SDK, hardware, region, modem preset, channel configuration, and test conditions with every result.

Until these steps pass on hardware, documentation and UI must say “adapter candidate,” never “supported transport” or “delivered.”
