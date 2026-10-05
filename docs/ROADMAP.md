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

## Implemented Coluvi software pilot and pending field validation

The Coluvi master product document and the InnovaFest Mérida preparation now guide the next increment. See the [development plan](COLUVI_INNOVAFEST_DEVELOPMENT_PLAN.md) for scope, dependencies, acceptance tests, proposed contracts, and the conservative submission timeline.

- RC1 implements authorized CHECKIN_REQUEST and OPERATIONAL_NOTICE, correlated SAFE/NEEDS_HELP updates and separately queued needs, durable private command storage, scoped operator access and verified mobile inboxes.
- The public geographic map has local cartography, guarded aggregate filters and an explicitly dated offline snapshot. Private operational events do not enter public aggregation.
- RC1 is frozen as `coluvi-simulacro-20261004-rc1`, with integrated Chromium, 204 tests and recorded HTTP load evidence. See [the completed block](COLUVI_EXPANDED_BLOCK.md); these results do not establish physical mesh or guaranteed capacity.
- RC2 adds pilot preflight, private-safe PWA diagnostics, six checkpoint-based rehearsal scenarios and real-browser crash/upgrade/failure recovery. Mixed-load limits and the completed three-hour observation are documented; its revised clock-chronology verifier awaits final qualification. See [RC2 criteria and evidence](COLUVI_RC2.md).
- The next human-dependent step is the [two-Samsung test session](COLUVI_SAMSUNG_TEST_SESSION.md): trusted HTTPS, enrollment, offline custody, recovery and operator observations over the actual LAN.
- Application material for the climate-change category must distinguish software evidence from physical observations. The project concerns adaptation and resilience, not disaster prediction or a production emergency service.

Shared Node/browser validators, domain-separated signatures, a published fictitious command vector, private additive SQLite storage, frozen recipients, signed receipts, late-response history and deadline-derived UNKNOWN are implemented. Private configuration enables proof-of-possession enrollment, persistent hashed participant credentials, scrypt operator login, expiring Secure/HttpOnly/SameSite sessions, Origin/Host/CSRF checks and access audit. The panel supports participant revocation without deleting histories. Startup, online backup and non-overwriting restore have automated coverage; restoring an older snapshot requires explicit review of revocation rollback. See the [demo guide](COLUVI_DEMO.md), [contract decision](adr/0002-coluvi-checkin-contract.md), [API instructions](REFERENCE_API.md) and [operations](COLUVI_OPERATIONS.md). Unconfigured operational ingest remains closed. Physical Samsung/LAN validation remains pending.

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
