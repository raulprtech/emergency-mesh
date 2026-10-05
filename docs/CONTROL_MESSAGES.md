# Routing control messages v0.1

ACK and egress advertisements describe delivery infrastructure, not human emergency semantics. They live above transport adapters and outside `EmergencyReport`.

## ACK

An acknowledgement contains its id, `eventId`, `packetId`, level, time, issuer, and status.

- `PEER / CUSTODY_ACCEPTED`: a peer accepted the packet into its queue.
- `GATEWAY / STORED`: a gateway accepted it for synchronization.
- `BACKEND / STORED`: a backend stored the first report.
- `BACKEND / DUPLICATE`: a backend already held the same `eventId` and recorded another arrival.

Only GATEWAY or BACKEND evidence may confirm egress. No ACK means a person read the message, validated its truth, dispatched help, or guaranteed future retention.

The raw-frame custody bridge carries a compact `PEER` ACK only after the configured receiver accepts a fully reassembled envelope. Local-port and radio-routing ACKs remain below this level. The inner control v0.1 record remains unsigned. A bridge may require an authenticated-control wrapper with a peer-shared key; when configured, it rejects legacy unwrapped ACKs, unknown key ids, altered tags, and wrong keys without releasing sender custody.

## Egress lifecycle

```text
UNKNOWN → REPORTED → CONFIRMED
              ↘          ↓
                 STALE ←─┘
```

`REPORTED` comes from current local/link evidence. `CONFIRMED` requires a recent gateway/backend ACK. Evidence becomes `STALE` after its configured TTL or immediately when the link disconnects. Stale evidence has zero routing quality until refreshed.

## Binary representation

Routing control messages use deterministic CBOR arrays with control version `0.1`. Kind `0` is ACK; kind `1` is EGRESS_ADVERTISEMENT. The latter carries explicit creation and validity times plus a nonce. Decoders reject unknown versions, malformed shapes, invalid quality, and inverted validity windows.

Authenticated-control wrapper v0.1 uses outer kind `2`, a deployment key id, the exact inner control bytes, and a 16-byte HMAC-SHA-256 tag. The MAC covers a domain separator plus the deterministic unsigned wrapper and therefore binds the sender/issuer fields, event, packet, status, and timestamp carried by the inner ACK. Secrets must contain at least 32 bytes. Frames are checked for canonical CBOR after constant-time tag verification.

The wrapper proves only that a holder of the configured peer-shared secret produced the bytes. It does not establish a civil identity, truth, responder receipt, or future retention. Secret generation, authenticated provisioning, rotation, revocation, and secure storage are deployment responsibilities. Unwrapped v0.1 records remain correlation-only evidence for compatibility.
