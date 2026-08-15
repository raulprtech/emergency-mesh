# Roadmap

## Completed: vertical slice v0.1

- Immutable signed report plus mutable delivery envelope.
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
- Configurable public spatial/time aggregation with low-count suppression and raw-event API disabled by default.
- Versioned CBOR ACK/egress control messages with freshness-based UNKNOWN, REPORTED, CONFIRMED, and STALE states, plus an optional canonical HMAC-SHA-256-128 wrapper with downgrade rejection for peer custody ACKs.
- Installable mobile PWA with four primary actions plus third-party, last-seen, and person-found flows, including progressive one-shot Background Sync with serialized IndexedDB retries.
- Offline IndexedDB custody, browser Ed25519 identity, deterministic CBOR interoperability, manual synchronization, and honest CREATED/QUEUED/FORWARDED/GATEWAY_FOUND/SYNCED/EXPIRED states.
- Approximate-location minimization, unsigned fallback disclosure, bilingual Spanish/English high-stress UI, keyboard/focus support, reduced-motion/high-contrast preferences, and real-browser offline smoke coverage.
- Versioned X25519/HKDF-SHA-256/AES-256-GCM protected payload with report-bound AAD, authenticated recipient policy, Node/browser interoperability, strict size limits, and zero-decryption public backend.
- Versioned deterministic-CBOR MTU fragmentation with exact frame sizing, SHA-256 reassembly integrity, bounded memory/time/count, duplicate/conflict handling, custody-safe retry, and declarative 180-byte-link simulation.
- Physical raw-frame boundary, Meshtastic private-app policy, active-SDK-compatible structural port, isolated exact-version serial bench and contract check, Bitchat/Meshtastic feasibility decision, and unicast reassembly-to-queue custody ACK bridge with bounded in-memory recovery and atomic restart-safe SQLite receipts.

## Next: client hardening

- Validate with screen readers, reduced-motion settings, low-end phones, and high-stress usability sessions.
- Evaluate native secure-key storage and background transport without weakening the web fallback.

## Physical transport experiments

1. Run the prepared `MeshtasticSdkFramePort` serial bench against two physical devices and record the complete matrix.
2. Crash-test the SQLite custody transaction and synchronization policy on the target device filesystem.
3. Revisit Bitchat only when a stable upstream arbitrary-application-payload boundary is available.
4. Measure MTU, packet loss, reordering, background behavior, battery, custody acknowledgement, and practical range under recorded conditions.
5. Validate authenticated shared-key provisioning, protected storage, rotation, and revocation on target devices.

Wi-Fi Direct/Aware, LAN, SMS, satellite, digital radio, and other community transports remain later adapters. Kubernetes, Kafka, blockchain, machine-learning routing, responder verification, dispatch, government integration, and custom hardware remain out of scope.
