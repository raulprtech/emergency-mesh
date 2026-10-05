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

## Coluvi fictional flood drill

`node examples/coluvi-drill.ts 30 20261004` runs thirty bidirectional check-in cycles using shared authority/browser validators, immutable signed requests/responses, real SQLite queues, deterministic routing, seeded lossy links and the existing gateway. Five conditions each run six times: local network without external Internet, total isolation, intermittent routes, late backend delivery and expired delivery. Four recipients are frozen per request; a fifth device in another zone is excluded. Each cycle closes/reopens the private store and custody queues, derives UNKNOWN honestly and checks duplicate responses and receipts.

JSON output contains only fictional aggregate metrics, seeds and virtual time samples, not keys or device identifiers. It separates imposed center outages from remaining delivery delay and reports non-delivery separately. The complete suite compares two thirty-cycle executions for identical metrics. [Demo evidence](COLUVI_DEMO.md) records parameters, results and important caveats: a test actor supplies simulated SHOWN, clean restarts are not power cuts, and virtual timing is not physical-network performance.
