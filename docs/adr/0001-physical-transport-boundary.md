# ADR 0001: Physical transport boundary

- Status: accepted for feasibility testing
- Date: 2026-08-15

## Context

Emergency Mesh needs to move signed envelopes over third-party mesh products without taking over their routing or overstating delivery. The first candidates are Meshtastic and Bitchat. Their integration surfaces and acknowledgement semantics differ materially.

## Decision

Expose a narrow `RawFramePort` below the existing `TransportAdapter`. It moves bounded opaque frames and may report local queue or routing acceptance, neither of which is Emergency Mesh custody. Build the first concrete hardware spike for Meshtastic through an official PhoneAPI client, using private application port 256 and a 233-byte frame ceiling. Defer Bitchat until a supported native application-data extension exists.

## Consequences

- Core fragmentation stays transport-neutral and third-party routing remains untouched.
- A future bridge must add remote reassembly-and-enqueue acknowledgements before it can implement `TransportAdapter.send()` with `accepted: true`.
- Meshtastic routing ACKs remain useful diagnostics without becoming false delivery claims.
- Physical integration code and its license obligations can remain optional and isolated from the Apache-2.0 core.
- Hardware testing is mandatory before the adapter can be advertised as supported.
