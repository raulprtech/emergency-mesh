# Declarative simulator scenarios v1

Scenario files describe topology and time without embedding transport logic. They are JSON objects with `version`, `name`, `startAt`, deterministic `seed`, `nodes`, directed `links`, and ordered `actions`.

## Nodes

A node declares `id`, optional `batteryPercent`, energy mode, and initial Internet state. Every node receives an Internet adapter; whether it is usable is controlled by the timeline.

## Links

A directed link declares `id`, `from`, `to`, optional `lossRate`, initial availability, MTU, and an optional `fragmentation` boolean. When enabled, MTU applies to each encoded fragment and loss is sampled per frame; otherwise an oversized envelope is rejected by the direct lossy link. Each link receives a deterministic random stream derived from the scenario seed. Two executions with the same definition therefore make the same packet-loss decisions.

Bidirectional connectivity is represented by two directed links. This makes asymmetric outages explicit.

## Actions

- `CREATE`: creates a signed emergency report on a node.
- `FLUSH`: runs one routing/forwarding attempt for a node.
- `SET_LINK`: activates or deactivates a link.
- `SET_INTERNET`: changes direct egress availability.
- `SET_BATTERY`: changes a node's battery level.

`at` is a non-negative millisecond offset from `startAt`. Actions with equal timestamps retain file order. The same virtual clock is injected into nodes and Internet adapters, so expiration, retry, forwarding, and backend receipt share one timeline.

Run the included scenario:

```bash
node examples/run-scenario.ts examples/scenario-fragmented-network.json
node examples/run-scenario.ts examples/scenario-small-mtu.json
```

The runner validates duplicate ids and unknown node/link references before execution. Version 1 intentionally omits movement, link bandwidth budgets, recurring actions, and distributed egress advertisements.
