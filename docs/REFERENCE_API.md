# Reference backend API

The MVP server is intentionally small and uses either a seeded in-memory backend or configured SQLite persistence. It documents the compatibility seam, not a production deployment.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health, protocol version, storage mode, and direct-HTTPS status. |
| `POST` | `/api/packets` | Accept `application/cbor` encoded `EmergencyEnvelope`. |
| `GET` | `/api/events` | Disabled by default; development-only raw reports when explicitly enabled. |
| `GET` | `/api/areas` | Policy metadata plus coarse, bucketed, threshold-suppressed areas. |
| `GET` | `/` | Aggregate Emergency Map. |
| `GET` | `/mobile/` | Installable offline mobile PWA. |

Ingest responses contain `ACCEPTED`, `DUPLICATE`, `EXPIRED`, or `INVALID`. Admission rejection uses HTTP 429 with `RATE_LIMITED`, a `GLOBAL`, `IDENTITY`, or `IDENTITY_CAPACITY` scope, millisecond retry guidance, and a `Retry-After` header. A rate-limited response never contains acknowledgement evidence. The reference PWA keeps custody, honors positive `retryAfterMs` or `Retry-After` guidance up to a one-hour local ceiling, and still expires the report at its signed deadline. Successful ingest responses contain the `eventId` and signature validity. `ACCEPTED` and `DUPLICATE` responses also include signed backend acknowledgement evidence suitable for advancing a client from `GATEWAY_FOUND` to `SYNCED`. Acceptance means storage by this reference backend only; the acknowledgement never means that a responder saw the report or that assistance is coming.

A compatible backend must validate the envelope, enforce signed lifetime, deduplicate by `eventId`, preserve the immutable report and signature, retain separate arrival evidence, and avoid exposing sensitive fields through public queries, and keep protected-payload private keys outside the ingest and public-map services. It may use different languages, databases, authorization, moderation, and protected-payload policies.

## Public-map and ingest defaults

The reference server uses one-decimal coordinate cells, one-hour buckets, a minimum group size of three, and a 24-hour observation window. These are configurable through the `EMERGENCY_MESH_PUBLIC_*` variables documented in `PRIVACY_AGGREGATION.md`. Invalid values fail closed at startup. Request bodies above 65,536 bytes receive HTTP 413. The in-process reference admission window defaults to 60 seconds, 600 total requests, 60 requests per pseudonymous identity, and at most 10,000 concurrently tracked identities. Configure these positive integers with `EMERGENCY_MESH_INGEST_WINDOW_SECONDS`, `EMERGENCY_MESH_INGEST_GLOBAL_REQUESTS`, `EMERGENCY_MESH_INGEST_IDENTITY_REQUESTS`, and `EMERGENCY_MESH_INGEST_MAX_IDENTITIES`; invalid values stop startup. The global counter runs before body decoding. The identity counter runs after bounded decoding but before backend ingest. These local fixed-window controls bound one process only and do not replace distributed edge limits, authenticated gateway policy, or radio-neighborhood quotas.
