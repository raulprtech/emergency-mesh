# Basic threat model

## Assets and boundaries

Assets include human safety information, precise locations, subject descriptions, pseudonymous continuity, queue availability, backend integrity, and scarce radio/battery capacity. Untrusted boundaries exist at every sender, peer, transport adapter, gateway, and public API.

## Threats and v0.1 posture

| Threat | Current control | Remaining work |
|---|---|---|
| Message tampering | Ed25519 over immutable report; device id bound to public key; published deterministic vector | Durable raw-byte storage and decoder fuzzing |
| Replay/duplicates | Unique nonce, stable `eventId`, expiration, bounded persistent SQLite replay and backend deduplication | Deployment-specific retention tuning and distributed quotas |
| Extended replay lifetime | Signed `validUntil`; envelope cannot exceed it | Clock-skew policy and trusted receipt timestamps |
| Flooding/broadcast storms | Seen set, hop limit, expiration, bounded multipath, retry backoff | Per-key/radio quotas, admission control, storage budgets |
| False reports or locations | Signatures provide continuity only; trust is explicitly unassessed | Corroboration and instance-defined moderation |
| False egress claims | Egress state distinguishes reported and confirmed conceptually | Backend ACK challenge, freshness decay, anti-spoofing |
| Precise-location disclosure | Public API exposes coarse aggregates; protected payload uses authenticated X25519/HKDF/AES-GCM recipient encryption and is never decrypted by the public backend | Authenticated key distribution, isolated decryption service, access audit, short plaintext retention |
| Linkability | No account required; pseudonymous device key | Key rotation policy and unlinkable emergency identities |
| Compromised device/gateway | End-to-end report signature detects semantic changes; gateways have no protected-payload private keys | Platform key protection, authorized endpoint hardening, key rotation and revocation |
| Malformed packet | Bounded codec, validation, MTU checks | Fuzzing and hard resource limits |
| Fragment injection or mixing | Full-payload SHA-256, digest-derived transfer id, strict frame parser, duplicate/conflict checks, bounded reassembly | Per-neighborhood admission quotas and transport-authenticated frame sessions |
| Clock manipulation | Separate created, observed, location, receipt, and expiry times | Skew scoring; never silently rewrite source times |

## Non-guarantees

A valid signature does not prove truth, location, authority, or uniqueness of a human. A backend ACK does not mean a responder saw the event. An egress advertisement is not confirmed until recent endpoint evidence exists. User interfaces must communicate all three limitations plainly.

## Abuse-sensitive defaults for production

Reject oversized/deep packets before decoding, limit extension sizes, cap queues per pseudonym and per radio neighborhood, suppress tiny public aggregates, expire precise location independently, and isolate protected payload decryption from public map services.
