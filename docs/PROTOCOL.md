# Emergency Protocol v0.1

Status: MVP draft. Wire version: `0.1` (optional patch suffix accepted). Normative words MUST, MUST NOT, SHOULD, and MAY describe interoperability requirements.

## Two-layer packet

An emergency packet has an immutable `EmergencyReport` inside a mutable `EmergencyEnvelope`.

### EmergencyEnvelope

| Field | Meaning |
|---|---|
| `packetId` | Identifier for this transport envelope; not used to correlate real incidents. |
| `report` | Signed semantic report. |
| `expiresAt` | Millisecond Unix time after which this copy MUST NOT be forwarded. MUST be no later than signed `validUntil`. |
| `hopCount` | Forwarding hops already performed. |
| `hopLimit` | Maximum forwarding hops (hop TTL). |
| `lastForwardedAt` | Optional local forwarding time. |
| `transportHistory` | Optional, bounded diagnostic history; consumers MUST NOT require it. |

### EmergencyReport

| Field | Required | Meaning |
|---|---:|---|
| `protocolVersion` | yes | Protocol compatibility version. |
| `eventId` | yes | Globally unique immutable report/idempotency identifier. |
| `incidentRef` | no | Optional grouping hint; never automatic proof of equivalence. |
| `eventType` | yes | Registered type or an `x-` extension. |
| `reportMode` | yes | `SELF`, `THIRD_PARTY`, or `LAST_SEEN`. |
| `priority` | yes | `CRITICAL`, `HIGH`, `NORMAL`, or `LOW`. |
| `createdAt` | yes | Report creation time in Unix milliseconds. |
| `observedAt` | yes | Time the reported fact was observed, distinct from creation. |
| `validUntil` | yes | Signed maximum lifetime in Unix milliseconds. |
| `location` | no | Location, accuracy, timestamp, source, and/or zone. |
| `peopleAffected` | no | Non-negative approximate count. |
| `needs` | no | Extensible structured need list. |
| `shortMessage` | no | At most 280 UTF-8 bytes in v0.1. |
| `anonymousDeviceId` | yes | Pseudonymous identifier derived from the signing key. |
| `subject` | conditional | Required for `THIRD_PARTY` and `LAST_SEEN`. |
| `relatedEventId` | no | Explicit relation such as `PERSON_FOUND` → previous observation. |
| `nonce` | yes | Unique anti-replay input for a newly created report. |
| `publicPayload` | no | Additional instance-approved public data. |
| `protectedPayload` | no | Versioned opaque X25519/HKDF-SHA-256/AES-256-GCM container; recipients come only from authenticated deployment policy. |
| `identityMetadata` | no | Policy-controlled identity metadata; not public by default. |
| `trustMetadata` | no | Assessment metadata; never proof by itself. |
| `signature` | recommended | Ed25519 signature and public key. Unsigned acceptance is an instance policy. |
| `extensions` | no | Additive namespaced fields. |

## Registered semantics

Event types: `SAFE`, `RESOURCE_REQUEST`, `ASSISTANCE_REQUEST`, `SOS`, `RESOURCE_AVAILABLE`, `AREA_STATUS`, `PERSON_LAST_SEEN`, and `PERSON_FOUND`.

Need categories: `WATER`, `FOOD`, `MEDICATION`, `MEDICAL_CARE`, `EXTRACTION`, `SHELTER`, `ENERGY`, `TRANSPORT`, and `COMMUNICATION`. New categories use an `x-` prefix until registered.

`LAST_SEEN` always describes a historical observation. A UI MUST display `observedAt` and MUST NOT present its location as the subject's current position. `PERSON_FOUND` creates a new report referencing a previous report or pseudonymous subject; it does not overwrite history.

## Location

`source` is one of `GPS_CURRENT`, `LAST_KNOWN`, `MANUAL`, `APPROXIMATE`, `ZONE`, or `OTHER_DEVICE`. `timestamp` is the time the location itself was obtained. Consumers MUST use source, accuracy, and age rather than assuming coordinates are current or precise.

## Encodings

JSON uses the field names in this document and is intended for development and APIs. Binary transport uses deterministic CBOR with short stable keys. The implementation rejects indefinite-length objects, trailing bytes, unsafe or non-canonical integers, non-finite floats, malformed UTF-8, duplicate map keys, and short/long field aliases that expand to the same protocol name. Default decode limits are 65,536 input bytes, depth 32, 16,384 total values, 4,096 array items, 2,048 map entries, and 65,536 bytes per byte or text string. Map construction treats names such as `__proto__` as ordinary own data rather than inherited setters.

Signatures cover deterministic CBOR of the expanded `EmergencyReport`, excluding only `signature` and properties whose value is undefined. They do not cover mutable envelope fields.

The repository publishes a deterministic Ed25519/CBOR vector in `examples/protocol-vector-v0.1.json`; compatible implementations MUST reproduce it byte for byte. Unknown additive fields MUST be preserved when relaying where transport constraints permit. Implementations reject unsupported compatibility versions rather than guessing semantics.

## MTU fragmentation

An encoded envelope MAY be carried in versioned deterministic-CBOR fragment frames. Each frame identifies the transfer through the prefix and full SHA-256 digest of the complete encoded envelope. Reassembly MUST be bounded by frame size, payload size, fragment count, concurrent transfers, buffered bytes, and idle time. Fragment receipt is not report authentication or packet custody; a peer acknowledgement requires full digest-checked reconstruction, normal envelope validation, and receiving-queue acceptance. See [MTU fragmentation and reassembly](FRAGMENTATION.md).

## Deduplication and correlation

Copies with the same `eventId` are one report, regardless of `packetId`, path, or arrival count. Distinct reports about the same real-world incident retain different `eventId` values and MAY share `incidentRef`. Matching people or incidents is explicitly outside v0.1.

## Priority, TTL, and expiration

Queues service `CRITICAL`, `HIGH`, `NORMAL`, then `LOW`, with FIFO ordering inside a priority. Expired packets and packets at `hopLimit` MUST NOT be forwarded. Nodes SHOULD use bounded exponential backoff and MUST suppress already-seen `eventId` values to limit storms.

## Protected payload

The `emesh-protected-v1:` container encrypts up to 8,192 bytes for one to eight explicitly configured X25519 recipients. Authenticated additional data binds it to `protocolVersion`, `eventId`, `anonymousDeviceId`, `createdAt`, and `validUntil`; the outer Ed25519 signature covers the complete encoded container. Relays and the reference backend validate and preserve it but do not decrypt it. Recipient discovery from report or transport content is forbidden. See [Protected payload encryption v1](PROTECTED_PAYLOAD.md).

## Privacy

Protocol capability is not permission to disclose. Public consumers SHOULD use coarse zones or aggregates. Precise coordinates, personal descriptions, and contact or identity data belong in protected or policy-controlled storage and SHOULD expire as soon as operationally possible.
