# Raw-frame custody bridge

`CustodyBridgeTransportAdapter` connects the existing `TransportAdapter` contract to one peer-addressed `RawFramePort`. It is a reference protocol implementation for tests and future physical adapters; it does not make any radio or hardware supported by itself.

## Transfer sequence

```text
sender queue
  → deterministic envelope fragments
  → unicast raw frames
  → remote bounded reassembly
  → remote envelope validation
  → remote queue callback
  → compact PEER / CUSTODY_ACCEPTED control ACK
  → sender removes its queue entry
```

Local device acceptance and radio routing ACKs never advance the final step. If any frame is rejected, the remote queue rejects the envelope, or the custody ACK times out, `send()` returns `accepted: false` and the sender retains custody for its normal retry policy.

## Wire discrimination

- Envelope fragments retain their existing canonical CBOR map representation and consume the full physical frame budget.
- Custody acknowledgements reuse the deterministic CBOR array from control protocol v0.1.
- The bridge accepts frames only from its configured peer address.
- A custody ACK must match the pending `eventId` and `packetId`, identify the configured peer as both sender and issuer, use level `PEER`, and not be implausibly future-dated.
- Before sending fragments, the bridge verifies that the expected custody ACK fits in one physical frame.

## Loss and duplicates

After a receiver accepts an envelope, it stores the generated ACK in a bounded in-memory cache keyed by `(eventId, packetId)`. If the ACK is lost and the sender repeats the fragments, the receiver replays the cached ACK without invoking its queue callback twice. Cache entries expire at the earlier of envelope expiration and the configured cache TTL; capacity is bounded with oldest-entry eviction.

This cache is not restart-durable. A concrete deployment must either persist accepted packet/ACK correlation alongside its queue or provide an atomic duplicate decision that can safely regenerate the prior ACK after restart.

## Security boundary

Control v0.1 ACKs are not signed. Matching a reported physical source address and node identifier provides correlation, not cryptographic peer authentication. A concrete raw-frame port must document whether its addressing is authenticated. Until control messages are cryptographically bound to an authenticated session, ACK evidence must not be treated as proof of a real-world identity, truth, human receipt, or responder action.

Reassembly limits, frame MTU, timeout, pending sends, and accepted-ACK memory are bounded. The adapter is unicast-only to avoid broadcast ACK storms and ambiguous custody.

## Remaining physical work

1. Implement a Meshtastic `RawFramePort` with an official PhoneAPI SDK.
2. Persist receiver duplicate/ACK correlation atomically with durable custody.
3. Exercise device queue backpressure, disconnects, reboots, loss, duplicate delivery, and reordering on two radios.
4. Measure end-to-end timing so the bridge ACK timeout is appropriate for each modem preset and fragment count.
5. Add authenticated control messages or bind them to a transport session with an explicit trust model.
