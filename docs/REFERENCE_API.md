# Reference backend API

The MVP server is intentionally small and in-memory. It documents the compatibility seam, not a production deployment.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Protocol and process health. |
| `POST` | `/api/packets` | Accept `application/cbor` encoded `EmergencyEnvelope`. |
| `GET` | `/api/events` | Disabled by default; development-only raw reports when explicitly enabled. |
| `GET` | `/api/areas` | Policy metadata plus coarse, bucketed, threshold-suppressed areas. |
| `GET` | `/` | Aggregate Emergency Map. |
| `GET` | `/mobile/` | Installable offline mobile PWA. |

Ingest responses contain `ACCEPTED`, `DUPLICATE`, `EXPIRED`, or `INVALID`, the `eventId`, and signature validity. `ACCEPTED` and `DUPLICATE` responses also include signed backend acknowledgement evidence suitable for advancing a client from `GATEWAY_FOUND` to `SYNCED`. Acceptance means storage by this reference backend only; the acknowledgement never means that a responder saw the report or that assistance is coming.

A compatible backend must validate the envelope, enforce signed lifetime, deduplicate by `eventId`, preserve the immutable report and signature, retain separate arrival evidence, and avoid exposing sensitive fields through public queries, and keep protected-payload private keys outside the ingest and public-map services. It may use different languages, databases, authorization, moderation, and protected-payload policies.

## Public-map defaults

The reference server uses one-decimal coordinate cells, one-hour buckets, a minimum group size of three, and a 24-hour observation window. These are configurable through the `EMERGENCY_MESH_PUBLIC_*` variables documented in `PRIVACY_AGGREGATION.md`. Invalid values fail closed at startup. Request bodies above 65,536 bytes receive HTTP 413.
