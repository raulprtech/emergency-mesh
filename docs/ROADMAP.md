# Roadmap

## Completed: vertical slice v0.1

- Immutable signed report plus mutable delivery envelope, with bounded canonical CBOR decoding and multi-seed deterministic malformed-input fuzz coverage in pull requests and scheduled CI.
- Deterministic CBOR and readable JSON.
- SELF, THIRD_PARTY, LAST_SEEN, and PERSON_FOUND semantics.
- Prioritized store-and-forward, hop TTL, signed expiration, deduplication, retry backoff.
- Replaceable deterministic routing and bounded SOS multipath.
- Mock and Internet adapters, gateway, in-memory backend, aggregate map.
- Automated end-to-end and protocol tests.
- Restart-safe SQLite queue/backend, persistent deduplication, virtual time, seeded packet loss, and battery accounting.
- Published deterministic Ed25519/CBOR interoperability vector.
- Bounded memory/SQLite queues with priority-safe eviction and honest custody rejection.
- Exact signed-byte retention, configurable backend pruning, and declarative topology/timeline scenarios.
- Configurable public spatial/time aggregation with low-count suppression and raw-event API disabled by default, plus bounded global/per-pseudonym ingest admission with explicit retry semantics and no false custody ACK.
- Versioned CBOR ACK/egress control messages with freshness-based UNKNOWN, REPORTED, CONFIRMED, and STALE states, plus an optional canonical HMAC-SHA-256-128 wrapper with downgrade rejection for peer custody ACKs.
- Installable mobile PWA with four primary actions plus third-party, last-seen, and person-found flows, including progressive one-shot Background Sync with serialized IndexedDB retries.
- Offline IndexedDB custody, browser Ed25519 identity, deterministic CBOR interoperability, manual synchronization, and honest CREATED/QUEUED/FORWARDED/GATEWAY_FOUND/SYNCED/EXPIRED states.
- Approximate-location minimization, unsigned fallback disclosure, bilingual Spanish/English high-stress UI, keyboard/focus restoration and Escape dismissal, reduced-motion/high-contrast preferences, real-browser offline smoke coverage, and automated Chromium AX/constrained-mobile validation.
- Versioned X25519/HKDF-SHA-256/AES-256-GCM protected payload with report-bound AAD, authenticated recipient policy, Node/browser interoperability, strict size limits, and zero-decryption public backend.
- Versioned deterministic-CBOR MTU fragmentation with exact frame sizing, SHA-256 reassembly integrity, bounded memory/time/count, duplicate/conflict handling, custody-safe retry, and declarative 180-byte-link simulation.
- Physical raw-frame boundary, Meshtastic private-app policy, active-SDK-compatible structural port, isolated exact-version serial bench and contract check, Bitchat/Meshtastic feasibility decision, and unicast reassembly-to-queue custody ACK bridge with bounded in-memory recovery and atomic restart-safe SQLite receipts.
- Phone-pilot receiver mode with configurable network binding, durable SQLite ingest across restart, optional direct TLS, short-lived non-overwriting local certificate generation, explicit low-threshold privacy warnings, and a documented trusted-HTTPS boundary.

## Next: Coluvi bidirectional climate-resilience pilot

The Coluvi master product document and the InnovaFest Mérida preparation now guide the next increment. See the [development plan](COLUVI_INNOVAFEST_DEVELOPMENT_PLAN.md) for scope, dependencies, acceptance tests, proposed contracts, and the conservative submission timeline.

- Stabilize the existing trusted-HTTPS Android-to-Ubuntu WSL2 pilot.
- Specify authorized CHECKIN_REQUEST, correlated SAFE/NEEDS_HELP responses, and operational notices without conflating them with routing ACKs.
- Add durable command storage, scoped operator access, a verified mobile inbox, and honest requested/received/responded metrics.
- Add a geographic aggregate view with local map fallback, while preserving privacy suppression and separating devices from people.
- Demonstrate a fictional flood/refuge scenario through deterministic simulation and measured Android/LAN tests. Physical mesh remains unvalidated.
- Freeze a reproducible prototype and record evidence for the climate-change category; this is adaptation/resilience, not disaster prediction or a production emergency service.

Implemented foundations include shared Node/browser check-in validators, domain-separated signatures, a published fictitious command vector, private additive SQLite storage, frozen recipients, bounded scoped inbox/detail queries, signed receipts, late-response history and deadline-derived UNKNOWN. Explicit private configuration now enables authenticated HTTP endpoints, proof-of-possession enrollment, persistent hashed participant credentials, scrypt operator login, expiring Secure/HttpOnly/SameSite sessions, Origin/Host/CSRF checks and access audit. The PWA cache excludes API/operator responses and outbox custody requires correlated BACKEND evidence. See the [contract decision](adr/0002-coluvi-checkin-contract.md) and [API instructions](REFERENCE_API.md). PWA enrollment/inbox UI, operator panel and the bidirectional scenario are still pending; unconfigured operational ingest remains closed.

Native apps, responder credentials/matching, external hazard feeds, federation, and ecosystem integrations are later product stages, not prerequisites for this pilot.

Hito 0 preparation is recorded in the [October Android pilot record](PILOT_20261002.md): refreshed non-overwriting TLS material, isolated pilot database, extended HTTPS restart/privacy coverage, and strict browser offline custody with the entire fixture backend stopped. Windows LAN forwarding and physical Samsung validation remain pending; the hito is not complete.

## Client hardening

- Validate with screen readers, reduced-motion settings, low-end phones, and high-stress usability sessions.
- Evaluate native secure-key storage without weakening the web fallback; progressive background transport is now implemented.

## Physical transport experiments

1. Run the prepared `MeshtasticSdkFramePort` serial bench against two physical devices and record the complete matrix.
2. Crash-test the SQLite custody transaction and synchronization policy on the target device filesystem.
3. Revisit Bitchat only when a stable upstream arbitrary-application-payload boundary is available.
4. Measure MTU, packet loss, reordering, background behavior, battery, custody acknowledgement, and practical range under recorded conditions.
5. Validate authenticated shared-key provisioning, protected storage, rotation, and revocation on target devices.

Physical Wi-Fi Direct/Aware, SMS, satellite, digital radio, and other community transports remain later adapters. The direct HTTPS phone pilot can use an existing LAN without proving mesh connectivity. Kubernetes, Kafka, blockchain, machine-learning routing, automatic dispatch, mandatory government integration, and custom hardware remain out of scope for this delivery. Optional responder credentials and external hazard sources belong to later Coluvi phases.
