# Emergency Mesh

Open-source, transport-agnostic infrastructure for moving critical human information through fragmented networks during emergencies. This repository is a **reference MVP**, not an emergency dispatch service, and it never promises delivery or assistance.

## What the MVP proves

```text
offline report → signed protocol packet → local queue → mock link
→ intermediate node → Internet appears → gateway → backend
→ deduplication → privacy-preserving area aggregate → reference map
```

The semantic report never depends on BLE, Bitchat, Meshtastic, LoRa, Wi-Fi, SMS, or Internet. Adapters choose only whether to hand a packet to a transport; they do not control that transport's internal routing.

## Quick start (Ubuntu on WSL2)

Requirements: Node.js 22.18 or newer. No package installation is required.

```bash
cd /home/raulprtech/emergency-mesh
~/.nvm/versions/node/v24.18.0/bin/node --test tests/*.test.ts
~/.nvm/versions/node/v24.18.0/bin/node src/simulator/demo.ts
~/.nvm/versions/node/v24.18.0/bin/node src/server.ts
```

Open `http://127.0.0.1:8787` (redirects to `/map/`) for the public geographic map or `http://127.0.0.1:8787/mobile/` for the installable offline mobile client. The local server seeds one simulated SOS; the default three-report threshold suppresses that group, so an empty public map is expected until enough reports share an area/time bucket.

If `node` is already on `PATH`, the equivalent commands are `npm test`, `npm run demo`, and `npm start`.

## Current modules

- `src/protocol`: v0.1 data model, bounded deterministic CBOR/JSON codecs, Ed25519 pseudonymous identity, recipient-bound protected-payload encryption, and bounded MTU fragmentation/reassembly.
- `src/routing`: deterministic, replaceable adapter selection and bounded critical multipath.
- `src/storage`: bounded in-memory and SQLite store-and-forward queues with expiration, backoff, replay retention, priority-safe eviction, and atomic restart-safe custody ACK receipts.
- `src/transports`: common adapter contract, direct mock/Internet links, a custody-safe fragmented small-MTU adapter, a physical raw-frame boundary, Meshtastic policy/SDK compatibility with an isolated serial bench, and a peer-custody bridge with optional durable receiver admission and downgrade-resistant HMAC-authenticated ACKs.
- `src/simulator`: virtual nodes and the end-to-end connectivity-loss scenario.
- `src/gateway` and `src/backend`: semantics-preserving gateway, bounded ingest admission, deduplication, status projection, and policy-governed geographic/temporal aggregation.
- `src/mobile-client`: installable bilingual PWA, browser Ed25519 identity, additive IndexedDB migration, verified Coluvi enrollment/inbox, atomic offline check-in response custody and correlated backend synchronization.
- `src/web`: public aggregate view plus a separately configured operator panel, with no private content before login and no private browser cache.
- `src/commands`: explicitly configured Coluvi private API, domain-separated authority, operator sessions/CSRF, proof-of-possession enrollment, persistent scoped credentials, frozen recipients, additive SQLite state, late-response history and signed received/shown evidence.

## Safety boundary

Signatures demonstrate integrity and pseudonymous continuity, **not truth, authority, successful delivery, or responder acknowledgement**. Precise personal locations, identity details, and protected payloads must not be exposed by public consumers. The MVP offers in-memory and local SQLite stores but is not production-ready.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Emergency Protocol v0.1](docs/PROTOCOL.md)
- [Data and privacy model](docs/DATA_MODEL.md)
- [Protected payload encryption](docs/PROTECTED_PAYLOAD.md)
- [Public aggregation policy](docs/PRIVACY_AGGREGATION.md)
- [Local geographic map, offline behavior and data provenance](docs/PUBLIC_MAP.md)
- [Durable persistence](docs/PERSISTENCE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Simulator](docs/SIMULATOR.md)
- [Declarative scenario format](docs/SCENARIO_FORMAT.md)
- [Routing, egress, multipath, and energy](docs/ROUTING_AND_EGRESS.md)
- [MTU fragmentation and reassembly](docs/FRAGMENTATION.md)
- [Physical transport feasibility](docs/PHYSICAL_TRANSPORT_FEASIBILITY.md)
- [Raw-frame custody bridge](docs/CUSTODY_BRIDGE.md)
- [Meshtastic SDK compatibility and serial bench](docs/MESHTASTIC_CORE_PORT.md)
- [ACK and egress control messages](docs/CONTROL_MESSAGES.md)
- [Offline mobile client](docs/MOBILE_CLIENT.md)
- [Phone-to-command-center pilot](docs/PHONE_PILOT.md)
- [Preparación del piloto Samsung de octubre](docs/PILOT_20261002.md)
- [Reference backend API](docs/REFERENCE_API.md)
- [Roadmap](docs/ROADMAP.md)
- [Coluvi development plan for InnovaFest Mérida](docs/COLUVI_INNOVAFEST_DEVELOPMENT_PLAN.md)
- [Coluvi check-in contract and persistence decision](docs/adr/0002-coluvi-checkin-contract.md)
- [Coluvi bidirectional demonstration and verification](docs/COLUVI_DEMO.md)
- [Signed simulation notices and private receipt evidence](docs/COLUVI_NOTICES.md)
- [Contributing](CONTRIBUTING.md)

## Status

The simulated vertical slice and bilingual offline mobile PWA are implemented and tested with progressive Background Sync, focus restoration, and real Chromium offline and constrained-mobile accessibility smoke tests. Meshtastic now has a researched raw-frame policy, a structural active-SDK-compatible port and pinned serial bench, and a custody bridge with atomic SQLite custody/ACK recovery across restart, but has not been tested on physical hardware; no physical BLE, Bitchat, LoRa, Wi-Fi, or SMS integration exists yet.

The configured Coluvi panel and mobile inbox complete an authorized check-in round trip and signed simulation notices in real Chromium, including offline response, window reopening, notice expiry and backend restart. Thirty seeded fictional flood cycles reuse the actual contracts, routing and SQLite queues; their metrics are virtual, not physical measurements. See the [demo guide](docs/COLUVI_DEMO.md). The geographic public map includes local cartography, filters, guarded breakdowns and an explicitly dated offline snapshot verified after an abrupt fixture-server stop. The expanded suite passed 185 tests; physical Samsung/LAN validation remains pending. The [expanded work block](docs/COLUVI_EXPANDED_BLOCK.md) tracks state updates, pilot operations, scale tests and the remaining integrated delivery.
