# Durable persistence

The MVP provides in-memory implementations for fast simulation and SQLite implementations for restart-safe local operation. Both satisfy the same structural contracts.

## Device queue

`SqliteStoreAndForwardQueue` stores canonical binary envelopes, priority rank, custody time, retry count, and next-attempt time. A separate `seen_events` table preserves deduplication after a packet leaves the active queue. Removing custody therefore does not immediately reopen the node to replay.

Schema initialization, deduplication, capacity eviction, and enqueue are transactional. Defaults allow 1,000 active records or 4 MiB and retain replay ids for 24 hours after signed expiration. Limits are configurable. A new packet may evict only strictly lower-priority custody; equal or higher priority is never silently displaced. A capacity rejection is not recorded as custody or replay. WAL mode and normal synchronization are enabled. A production mobile client should revisit durability settings based on its filesystem and power-loss guarantees, tune byte/count quotas, and migrate schema explicitly.

Example:

```ts
const queue = new SqliteStoreAndForwardQueue("device-queue.sqlite");
const node = new SimulatedNode("node-a", routing, context, queue);
```

## Backend

`SqliteBackend` stores one immutable JSON report, the exact canonical CBOR bytes covered by its signature, and every arrival separately. The duplicate check and first insert run inside one immediate transaction, so concurrent ingests cannot create two semantic reports. Arrival evidence retains packet id, receipt time, signature result, and transport history.

```ts
const backend = new SqliteBackend("backend.sqlite");
const gateway = new Gateway("community-gateway", backend);
```

Closing and reopening either implementation preserves queued packets, replay memory, reports, signed bytes, and arrival counts. Backend retention defaults to 30 days after signed `validUntil`; pruning deletes the report and its arrival metadata atomically. Automated tests exercise these restart boundaries using real temporary SQLite files.

## Deliberate limitations

- SQLite files are not encrypted by this MVP.
- Protected payload key management is instance-defined and not implemented.
- There is no multi-process migration coordinator.
- PostgreSQL/PostGIS remains the target for a multi-gateway deployment.
