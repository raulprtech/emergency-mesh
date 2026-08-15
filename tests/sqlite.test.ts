import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteBackend } from "../src/backend/sqlite-backend.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { SqliteStoreAndForwardQueue } from "../src/storage/sqlite-store.ts";

const base = 1_700_000_000_000;

function temporaryDatabase(name: string): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "emergency-mesh-"));
  return { directory, path: join(directory, name) };
}

test("SQLite queue survives restart and retains its replay window", () => {
  const temporary = temporaryDatabase("queue.sqlite");
  try {
    const report = makeReport({ eventId: "durable-queue-event", createdAt: base });
    const origin = new SimulatedNode("origin", new DeterministicRoutingManager());
    const envelope = origin.create(report);

    const first = new SqliteStoreAndForwardQueue(temporary.path);
    assert.equal(first.enqueue(envelope, base), true);
    assert.equal(first.size(), 1);
    first.close();

    const reopened = new SqliteStoreAndForwardQueue(temporary.path);
    assert.equal(reopened.size(), 1);
    assert.equal(reopened.ready(base)[0].envelope.report.eventId, report.eventId);
    assert.equal(reopened.enqueue(envelope, base), false, "restart must not reset deduplication");
    reopened.recordFailure(report.eventId, base);
    assert.equal(reopened.ready(base + 1_999).length, 0);
    assert.equal(reopened.ready(base + 2_000).length, 1);
    assert.equal(reopened.remove(report.eventId), true);
    assert.equal(reopened.hasSeen(report.eventId), true, "custody removal does not erase replay memory");
    reopened.close();
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test("SQLite backend deduplicates across restart while retaining arrivals", () => {
  const temporary = temporaryDatabase("backend.sqlite");
  try {
    const report = makeReport({ eventId: "durable-backend-event", createdAt: base });
    const origin = new SimulatedNode("origin", new DeterministicRoutingManager());
    const envelope = origin.create(report);

    const first = new SqliteBackend(temporary.path);
    assert.equal(first.ingest(envelope, base).status, "ACCEPTED");
    assert.equal(first.size(), 1);
    first.close();

    const reopened = new SqliteBackend(temporary.path);
    assert.equal(reopened.size(), 1);
    assert.equal(reopened.ingest(envelope, base + 1).status, "DUPLICATE");
    assert.equal(reopened.size(), 1);
    assert.equal(reopened.arrivalCount(report.eventId), 2);
    assert.equal(reopened.aggregate()[0].critical, 1);
    reopened.close();
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});
