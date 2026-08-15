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

## Loss, duplicates, and restart

The simple `receive()` path keeps a bounded in-memory ACK cache keyed by `(eventId, packetId)`. It replays a lost ACK without invoking the queue callback twice, but does not survive restart. Entries expire at the earlier of envelope expiration and the configured cache TTL and use oldest-entry eviction.

For durable deployments, `connectCustodyReceiver()` accepts an explicit ACK-producing admission function and is mutually exclusive with `receive()`. Pair it with `SqliteCustodyQueue.acceptCustody()`: signature verification, capacity admission, queue insertion, and ACK-receipt insertion commit in one immediate transaction. Exact retries replay the original ACK after restart. A new packet for the same event receives `DUPLICATE` only when its canonical signed-report digest matches a prior custody receipt; a conflicting reuse of `eventId` is rejected. Receipts expire with the envelope.

## Security boundary

Control v0.1 ACKs are not signed. Matching a reported physical source address and node identifier provides correlation, not cryptographic peer authentication. A concrete raw-frame port must document whether its addressing is authenticated. Until control messages are cryptographically bound to an authenticated session, ACK evidence must not be treated as proof of a real-world identity, truth, human receipt, or responder action.

Reassembly limits, frame MTU, timeout, pending sends, and accepted-ACK memory are bounded. The adapter is unicast-only to avoid broadcast ACK storms and ambiguous custody.

## Remaining physical work

1. Connect `MeshtasticCoreFramePort` to a pinned official BLE, serial, TCP, or HTTP transport and two physical radios.
2. Run crash-injection and abrupt-power-loss tests against the target device filesystem and select an appropriate SQLite synchronization mode.
3. Exercise device queue backpressure, disconnects, reboots, loss, duplicate delivery, and reordering on two radios.
4. Measure end-to-end timing so the bridge ACK timeout is appropriate for each modem preset and fragment count.
5. Add authenticated control messages or bind them to a transport session with an explicit trust model.
