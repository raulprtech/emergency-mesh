# Protected payload encryption v1

`EmergencyReport.protectedPayload` can carry instance-approved sensitive data without exposing its plaintext to relays, gateways, storage, or the public aggregation service. This capability is not permission to collect sensitive data. The reference mobile UI continues to omit precise location, names, and contact details until a deployment provisions an approved recipient policy.

## Cryptographic container

The signed report contains one opaque string:

```text
emesh-protected-v1:<base64url deterministic-CBOR container>
```

Version 1 uses an ephemeral X25519 sender key, HKDF-SHA-256, and AES-256-GCM. A random 256-bit content key encrypts deterministic-CBOR plaintext once. That key is independently wrapped for one to eight recipients. AES-GCM output stores its 128-bit authentication tag after the ciphertext.

| CBOR key | Meaning |
|---|---|
| `v` | Container version, exactly `1`. |
| `s` | `X25519-HKDF-SHA256+A256GCM`. |
| `e` | Ephemeral X25519 public key in DER SPKI form. |
| `n` | 96-bit content nonce. |
| `c` | Protected content ciphertext plus authentication tag. |
| `w` | Sorted recipient entries. |
| `w[].r` | Recipient id derived from SHA-256 of its DER SPKI key. |
| `w[].n` | Independent 96-bit key-wrap nonce. |
| `w[].k` | Wrapped 256-bit content key plus authentication tag. |

The content limit is 8,192 plaintext bytes, the recipient limit is eight, and the complete encoded field limit is 32,768 UTF-8 bytes. Parsers reject non-canonical base64url, malformed CBOR, incorrect key types or sizes, duplicate recipients, unknown suites, and truncated ciphertext.

## Report binding

Authenticated additional data binds encryption to these immutable report fields:

- `protocolVersion`
- `eventId`
- `anonymousDeviceId`
- `createdAt`
- `validUntil`

The recipient id and ephemeral public key are also bound while wrapping each content key. Moving a protected payload to a different report, changing an authorized recipient, or altering ciphertext causes authentication failure. The outer Ed25519 report signature independently covers the entire protected string.

## Recipient policy

A deployment MUST distribute recipient public keys through an authenticated configuration channel. Reports, nearby peers, QR codes without a verified signature, and transport advertisements MUST NOT be treated as authoritative key discovery.

Each configured key has a derived `recipientId`, status, optional validity window, and purpose. Encryption fails closed when a key is malformed, mismatched, duplicated, not yet valid, retired, revoked, or expired. Rotation should publish an overlap containing both old and new active keys; new reports stop using the old key after the overlap. Revocation prevents future encryption but cannot make already encrypted data unreadable to a previously authorized key.

Private keys belong only in an isolated authorized processing service or platform-backed key store. They MUST NOT be shipped in the PWA, relay, gateway, public-map process, repository, logs, telemetry, or general backend database. Decryption should be separately authorized and audited, and plaintext should have a shorter retention period than the signed report whenever operations allow it.

## Security boundaries

The container provides confidentiality and integrity against nodes that do not hold an authorized private key. It does not hide packet size, timing, sender pseudonym, event type, coarse public fields, or recipient ids. It does not establish that a recipient is trustworthy, protect plaintext after an authorized endpoint decrypts it, or provide forward secrecy against later compromise of a long-lived recipient private key.

The reference backend validates and stores the opaque signed container but never decrypts it. Public aggregation reads only explicitly public report fields.

## Implementations

- Node sealing, opening, key generation, and policy checks: `src/protocol/protected-payload.ts`
- Browser-compatible sealing: `src/mobile-client/protected.js`
- Runnable local demonstration: `node examples/protected-payload-demo.ts`

Node and browser implementations use identical CBOR, AAD, KDF, and AES-GCM semantics. Cross-runtime tests require a browser-created payload to decrypt in Node.
