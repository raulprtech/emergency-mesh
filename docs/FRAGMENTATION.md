# MTU fragmentation and reassembly v1

The fragmentation layer transports an already serialized `EmergencyEnvelope` across links whose frame MTU is smaller than the envelope. It is independent of BLE, LoRa, Bitchat, Meshtastic, or any other adapter.

## Fragment frame

Each fragment is deterministic CBOR with short keys:

| Key | Expanded field | Meaning |
|---|---|---|
| `v` | `version` | Frame format version, exactly `1`. |
| `t` | `transferId` | 128-bit prefix of the complete-payload SHA-256 digest, base64url encoded. |
| `i` | `index` | Zero-based fragment index. |
| `n` | `count` | Total non-empty fragments. |
| `l` | `totalLength` | Exact reassembled byte length. |
| `h` | `digest` | Complete 32-byte SHA-256 digest. |
| `d` | `data` | Non-empty payload slice. |

`fragmentBytes` calculates the largest usable chunk dynamically because CBOR metadata size changes with integer and byte-string lengths. Every encoded frame is checked against the requested MTU; no fixed overhead estimate is assumed.

Version 1 permits at most 256 fragments and a 65,536-byte reassembled payload. An MTU too small for metadata or one that would require more fragments fails before transmission.

## Reassembly policy

`FragmentReassembler` accepts frames in any order and treats byte-identical repeats as duplicates. It rejects:

- malformed or oversized frames;
- unknown fields or versions;
- invalid digest-derived transfer ids;
- conflicting metadata or duplicate indexes with different bytes;
- fragment counts, payload sizes, or buffered bytes above policy;
- inconsistent layouts and final digest mismatches.

Default limits are 32 concurrent transfers, 1 MiB of buffered chunks, 65,536 bytes per payload, 256 fragments, and a five-minute idle timeout. Deployments should lower them to match the radio and device. Admission failure does not imply custody. Duplicate frames do not extend the idle timeout, preventing a trivial keep-alive attack.

Partial state remains available for a bounded retry. The reference sender retries the whole frame set; already received frames are idempotent. Selective fragment ACKs and congestion control remain transport-specific future work.

## Integrity and custody

The full SHA-256 digest detects accidental loss, mixing, and corruption. It is not sender authentication: an attacker can fabricate fragment metadata and consume bounded reassembly capacity. Authenticity can only be assessed after the complete envelope is decoded. Ed25519 verification and any policy for unsigned reports remain part of the normal receiving/backend path.

The reference fragmenting adapter emits a `PEER` custody acknowledgement only after all frames reconstruct a valid envelope and the receiving node accepts it into its queue. Losing one frame or rejecting the receiver queue leaves custody with the sender.

Fragmentation is not encryption. Protected fields must use the separate protected-payload container before the envelope is fragmented. Relays can observe frame count, timing, transfer id, and total size.

## Reference integration

- Pure framing and bounded reassembly: `src/protocol/fragmentation.ts`
- Reference small-MTU adapter: `src/transports/fragmented-mock.ts`
- Declarative scenario: `examples/scenario-small-mtu.json`

Run the scenario with:

```bash
node examples/run-scenario.ts examples/scenario-small-mtu.json
```

The scenario uses a 180-byte directed link, reconstructs the signed envelope at an intermediate node, and then forwards it through the normal Internet adapter.
