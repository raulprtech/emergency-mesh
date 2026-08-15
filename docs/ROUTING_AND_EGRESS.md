# Routing, egress, multipath, and energy

## Adapter contract

Every transport exposes `available`, `capabilities`, `send`, `receive`, `estimatedCost`, `estimatedEnergyCost`, `maximumPayloadSize`, `hasEgress`, and `egressQuality`. Capabilities describe range, bandwidth, latency, infrastructure and hardware requirements, energy, MTU, broadcast, bidirectionality, and Internet reachability.

Calling `send(packet)` is the routing boundary. Bitchat remains responsible for BLE discovery, internal hops, store-and-forward, and its own cryptography. Meshtastic remains responsible for its LoRa network. Emergency Mesh neither names nor chooses their internal relays.

## Small-MTU framing

For fragmentation-capable adapters, `maximumPayloadSize` is the physical encoded-frame MTU rather than the maximum reassembled envelope size. The routing contract still hands the adapter one semantic envelope. The adapter serializes and fragments it internally, and claims peer custody only after complete digest-checked reassembly and receiver queue acceptance. Direct adapters may continue rejecting envelopes larger than their MTU. See [MTU fragmentation and reassembly](FRAGMENTATION.md).

Energy estimation for the reference fragmenting adapter scales with frame count. A physical adapter must additionally account for link headers, retransmission, radio duty cycle, and any lower-layer fragmentation already performed by its transport.

## Egress model

An advertisement has a state:

- `UNKNOWN`: no usable evidence.
- `REPORTED`: a peer claims a route but it has not been independently demonstrated.
- `CONFIRMED`: a recent gateway handshake or backend ACK proves the path worked.
- `STALE`: prior evidence exists but is too old for normal scoring.

It also carries bounded quality, last-confirmed time, and supported transports. Version 0.1 implements freshness decay, explicit ACK evidence, and compact control-message encoding. It does not yet distribute advertisements across a mesh or build an egress gradient. Untrusted peer claims never become confirmed without gateway or backend evidence.

## Multipath policy

Normal reports use one highest-scoring eligible adapter. CRITICAL and SOS reports may use two independent adapters when energy mode is not `LOW_BATTERY`. The limit is configurable. Backend idempotency makes duplicate arrival safe; `eventId` remains unchanged across paths.

Redundancy is bounded per routing attempt. Retry backoff, hop limit, expiration, and seen-event suppression prevent unlimited replication. Future scoring should reward genuinely independent failure domains rather than two adapters backed by the same upstream link.

## Energy strategy

The common context supports `NORMAL`, `EMERGENCY`, and `LOW_BATTERY` modes. In v0.1, declared adapter energy cost affects scoring and low-battery mode disables multipath. A physical implementation should additionally adjust discovery intervals, scan windows, synchronization cadence, enabled radios, retry budgets, and queue compaction. Permanent aggressive scanning is not an acceptable default.

Suggested policy:

| Mode | Discovery | Redundancy | Synchronization |
|---|---|---|---|
| NORMAL | moderate | critical only | opportunistic |
| EMERGENCY | more frequent, bounded | critical up to configured limit | prompt |
| LOW_BATTERY | sparse | one best route | batch unless critical |

Battery policy must never silently downgrade the semantic priority stored in the signed report.
