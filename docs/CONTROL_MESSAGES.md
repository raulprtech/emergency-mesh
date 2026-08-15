# Routing control messages v0.1

ACK and egress advertisements describe delivery infrastructure, not human emergency semantics. They live above transport adapters and outside `EmergencyReport`.

## ACK

An acknowledgement contains its id, `eventId`, `packetId`, level, time, issuer, and status.

- `PEER / CUSTODY_ACCEPTED`: a peer accepted the packet into its queue.
- `GATEWAY / STORED`: a gateway accepted it for synchronization.
- `BACKEND / STORED`: a backend stored the first report.
- `BACKEND / DUPLICATE`: a backend already held the same `eventId` and recorded another arrival.

Only GATEWAY or BACKEND evidence may confirm egress. No ACK means a person read the message, validated its truth, dispatched help, or guaranteed future retention.

## Egress lifecycle

```text
UNKNOWN → REPORTED → CONFIRMED
              ↘          ↓
                 STALE ←─┘
```

`REPORTED` comes from current local/link evidence. `CONFIRMED` requires a recent gateway/backend ACK. Evidence becomes `STALE` after its configured TTL or immediately when the link disconnects. Stale evidence has zero routing quality until refreshed.

## Binary representation

Routing control messages use deterministic CBOR arrays with control version `0.1`. Kind `0` is ACK; kind `1` is EGRESS_ADVERTISEMENT. The latter carries explicit creation and validity times plus a nonce. Decoders reject unknown versions, malformed shapes, invalid quality, and inverted validity windows.

These v0.1 records are evidence containers, not cryptographic proofs. A future revision may sign advertisements or bind them to authenticated transport sessions without changing `Emergency Protocol`.
