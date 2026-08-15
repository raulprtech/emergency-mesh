# Simulator

The simulator runs the protocol and routing code used by real adapters; it does not implement a separate semantic model.

The initial end-to-end scenario contains:

```text
Node A: Mock link only, offline
Node B: Mock link + Internet adapter, initially offline
Gateway: backend-connected

A creates SOS → A forwards to B → B stores it
→ Internet is enabled on B → B forwards to Gateway → Backend
```

Run it with:

```bash
node src/simulator/demo.ts
```

Tests additionally model two simultaneous Internet adapters delivering the same SOS. The backend records two arrivals and one semantic event.

The simulator now includes a monotonic virtual clock, seeded pseudo-random source, reproducible lossy links, retry timing, battery accounting, bounded frame reassembly, and validated JSON topology/timeline scenarios. `examples/scenario-small-mtu.json` proves a signed envelope can cross a 180-byte link and later reach the backend. Next increments should add movement, bandwidth budgets, recurring actions, and delayed egress advertisements. These belong in the simulator before comparable physical-radio behavior is claimed.
