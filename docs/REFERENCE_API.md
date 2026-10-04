# Reference backend API

The MVP server is intentionally small and uses either a seeded in-memory backend or configured SQLite persistence. It documents the compatibility seam, not a production deployment.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health, protocol version, storage mode, and direct-HTTPS status. |
| `POST` | `/api/packets` | Accept `application/cbor` encoded `EmergencyEnvelope`. |
| `GET` | `/api/events` | Disabled by default; development-only raw reports when explicitly enabled. |
| `GET` | `/api/areas` | Policy metadata plus coarse, bucketed, threshold-suppressed areas. |
| `GET` | `/` | Redirects to `/map/`. |
| `GET` / `HEAD` | `/map/` | Geographic public map with local cartography, client-side filters and dated offline snapshot. |
| `GET` | `/mobile/` | Installable offline mobile PWA. |

Ingest responses contain `ACCEPTED`, `DUPLICATE`, `EXPIRED`, or `INVALID`. Admission rejection uses HTTP 429 with `RATE_LIMITED`, a `GLOBAL`, `IDENTITY`, or `IDENTITY_CAPACITY` scope, millisecond retry guidance, and a `Retry-After` header. A rate-limited response never contains acknowledgement evidence. The reference PWA keeps custody, honors positive `retryAfterMs` or `Retry-After` guidance up to a one-hour local ceiling, and still expires the report at its signed deadline. Successful ingest responses contain the `eventId` and signature validity. `ACCEPTED` and `DUPLICATE` responses also include structured BACKEND acknowledgement evidence suitable for advancing a client from `GATEWAY_FOUND` to `SYNCED`. The client requires matching event/packet IDs, level, status and plausible acknowledgement time before releasing custody. This acknowledgement has no independent cryptographic signature; trusted HTTPS authenticates the phone-facing server response. Acceptance means storage by this reference backend only; the acknowledgement never means that a responder saw the report or that assistance is coming.

A compatible backend must validate the envelope, enforce signed lifetime, deduplicate by `eventId`, preserve the immutable report and signature, retain separate arrival evidence, and avoid exposing sensitive fields through public queries, and keep protected-payload private keys outside the ingest and public-map services. It may use different languages, databases, authorization, moderation, and protected-payload policies.

## Public-map and ingest defaults

The reference server uses one-decimal coordinate cells, one-hour buckets, a minimum group size of three, and a 24-hour observation window. These are configurable through the `EMERGENCY_MESH_PUBLIC_*` variables documented in `PRIVACY_AGGREGATION.md`. Invalid values fail closed at startup. Request bodies above 65,536 bytes receive HTTP 413. The in-process reference admission window defaults to 60 seconds, 600 total requests, 60 requests per pseudonymous identity, and at most 10,000 concurrently tracked identities. Configure these positive integers with `EMERGENCY_MESH_INGEST_WINDOW_SECONDS`, `EMERGENCY_MESH_INGEST_GLOBAL_REQUESTS`, `EMERGENCY_MESH_INGEST_IDENTITY_REQUESTS`, and `EMERGENCY_MESH_INGEST_MAX_IDENTITIES`; invalid values stop startup. The global counter runs before body decoding. The identity counter runs after bounded decoding but before backend ingest. These local fixed-window controls bound one process only and do not replace distributed edge limits, authenticated gateway policy, or radio-neighborhood quotas.

## Optional Coluvi private API

Set `EMERGENCY_MESH_COLUVI_CONFIG_PATH` and an explicit `EMERGENCY_MESH_DATABASE_PATH` to enable this service. Without configuration, the routes are unavailable and operational packets fail closed. Commands, recipients, responses and receipt history use separate private SQLite tables and never enter `/api/events` or `/api/areas`. Existing general reports remain compatible.

| Method | Path | Access and purpose |
|---|---|---|
| `GET` | `/command-center/` | Static operator shell only when configured; no private data before authentication, `no-store`, self-only CSP. |
| `POST` | `/api/operator/login` | Same-origin JSON `{password}`; returns CSRF token and expiring session cookie. |
| `GET` | `/api/operator/session` | Operator cookie; returns session expiry, CSRF, zones, authorized kinds and authority fingerprint. |
| `POST` | `/api/operator/logout` | Operator cookie, same Origin and `X-Coluvi-CSRF`; body `{}`. |
| `GET` | `/api/operator/participants?zoneId=north&state=all&offset=0&limit=20` | Operator cookie; authorized zones only, optional zone filter, state `all`/`active`/`revoked`, maximum limit 100. No keys or tokens. |
| `POST` | `/api/operator/participants/:deviceId/revoke` | Operator cookie, Origin and CSRF; body `{confirmDeviceId}` must match the path. Idempotent revocation, never deletion. |
| `POST` | `/api/operator/checkins` | Operator cookie, Origin and CSRF; JSON `{incidentRef, zoneId, promptMs, lateMs}`. |
| `GET` | `/api/operator/checkins` | Operator cookie; latest 50 commands and complete per-command counts, without private histories. |
| `GET` | `/api/operator/checkins/:id?offset=0&limit=50` | Operator cookie; complete counts and a bounded recipient/history page. Maximum limit 100. |
| `POST` | `/api/operator/notices` | Operator cookie, Origin, CSRF and `OPERATIONAL_NOTICE` capability; JSON `{incidentRef, zoneId, sourceLabel, title, message, level, validMs, simulation:true}`. |
| `GET` | `/api/operator/notices` | Operator cookie; latest 50 signed notices with recipient/received/shown counts. |
| `GET` | `/api/operator/notices/:id?offset=0&limit=50` | Operator cookie; complete counts and paginated private recipient evidence, maximum limit 100. |
| `POST` | `/api/mobile/enrollment/challenge` | Same-origin JSON `{code, publicKey, zoneId}`; returns a one-use two-minute challenge. |
| `POST` | `/api/mobile/enrollment` | Same-origin JSON `{challengeId, signature}`; proves key possession, returns scoped participant token. |
| `GET` | `/api/mobile/inbox?cursor=0&limit=50` | `Authorization: Bearer <participant token>`; frozen recipient scope, cursor pagination, maximum limit 100. |
| `GET` | `/api/mobile/notices?cursor=0&limit=50` | Participant token; authorized, unexpired notices for frozen recipients; cursor independent of check-ins. |
| `POST` | `/api/mobile/receipts` | Participant token and same Origin; JSON `{report}` with signed check-in or notice RECEIVED/SHOWN report. |
| `POST` | `/api/packets` | Existing bounded CBOR route; configured Coluvi accepts signed state responses and linked needs details from frozen active enrolled recipients. |

All private responses use `Cache-Control: no-store` and vary on Cookie/Authorization. The session cookie is Secure, HttpOnly and SameSite=Strict, scoped to `/api/operator/`, with a one-hour lifetime. A restart invalidates operator sessions and enrollment challenges; hashed participant credentials survive and expire after seven days. Re-enrollment with successful key proof rotates the token and invalidates its predecessor. Revocation blocks the credential as well as signed response admission.

The participant list returns counts across the selected authorized zones, filtered pagination and pseudonymous IDs, zones, enrollment/revocation times and credential status/expiry only. Revocation returns `REVOKED` or `ALREADY_REVOKED`, deletes the credential, preserves frozen recipients and all operational history, and excludes the device from future issuances. The same identity cannot be reactivated through enrollment. See [pilot operation and recovery](COLUVI_OPERATIONS.md) for the confirmation UI, foreground launcher and private SQLite backup/restore commands.

Mutations require the exact configured Origin, and operator mutations also require CSRF. The private API checks Host and rejects cross-site fetch metadata; proxy-forwarded headers do not override these checks. Direct TLS is required for HTTPS origins and network access. The only HTTP exception is explicit loopback development bound to loopback; it does not authorize phone access over plain HTTP. Chromium verifies operator login with HttpOnly cookie, issuance, restart invalidation and logout through the panel. The panel keeps CSRF in memory, pages ten recipients at a time and bounds response bytes; it never stores credentials in localStorage or caches private responses.

Private JSON requests are limited to 16,384 bytes with a five-second body timeout. Local API admission is 600 global and 120 per source address per minute; operator login and enrollment challenges have additional narrower limits. These are single-process pilot limits, not production capacity claims. Each recipient has at most 100 immutable responses and 100 immutable needs details per command. Commands use a 1-second to 24-hour initial prompt window and at most 24 additional hours for queued responses, late first observations and state updates. V1 responses retain their initial-window observation constraint; v2 explicitly permits later observations and signed predecessor/revision fields. Audit rows record enrollment, grants, command creation, evidence, state/needs custody and operator login/logout; no password or token is recorded.

Check-in detail adds global `needsCounts` by category and, per recipient, current `needs` (or null), immutable `needsHistory` and a `link` status on history entries. `applies` marks only the current needs detail. Counts cover all recipients regardless of page size and use devices, never claimed people. An orphan needs detail receives storage acknowledgement but does not affect current needs until the same-device referenced help response arrives. State snapshots remain independently valid with missing predecessors, which are labeled `MISSING`, not claimed as verified chains. See the [state and needs contract](COLUVI_DEMO.md#estado-y-necesidades-contrato-y-límites).

## Generate private pilot material

Run in Ubuntu WSL2 using a new directory. The example is localhost-only development; use the verified HTTPS origin and existing TLS paths for a phone pilot.

```bash
mkdir -p .data
node scripts/create-coluvi-pilot.mjs http://127.0.0.1:8797 .data/coluvi-dev-20261004 refugio-norte refugio-sur
PORT=8797 EMERGENCY_MESH_HOST=127.0.0.1 \
EMERGENCY_MESH_DATABASE_PATH=.data/coluvi-dev-20261004/pilot.sqlite \
EMERGENCY_MESH_COLUVI_CONFIG_PATH=.data/coluvi-dev-20261004/operator-config.json \
node src/server.ts
```

The generator uses a fresh Ed25519 authority with explicit check-in and simulation-notice capabilities and random operator password/enrollment code. Existing check-in-only configurations remain supported without implicit capability expansion. It creates a 0700 directory with exclusive 0600 files and refuses to overwrite it. The private configuration contains the signing key and password verifier; `operator-secrets.txt` is operator-only. Keep both in Ubuntu and outside Git. Standard output lists paths and a public fingerprint, not secrets.

Only `mobile-trust.json`, containing public authority information, is intended for participant provisioning; share the enrollment code separately with consenting pilot participants, never the operator password or complete secrets file. Verify its fingerprint through an independent trusted channel before accepting commands. Receiving authority data through the inbox is not a trust bootstrap. The PWA imports the public file and requires the independently checked fingerprint, zone, code and consent. Its private API calls require confirmation that the updated v10 service worker excludes private caches. Follow the [bidirectional demo guide](COLUVI_DEMO.md) and [notice contract](COLUVI_NOTICES.md) for the UI and reproducible browser smoke.
