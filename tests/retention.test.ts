import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteBackend } from "../src/backend/sqlite-backend.ts";
import { canonicalReportBytes } from "../src/protocol/identity.ts";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";

test("backend retains exact signed bytes and prunes report plus arrivals after policy window", () => {
  const directory = mkdtempSync(join(tmpdir(), "emergency-mesh-retention-"));
  const backend = new SqliteBackend(join(directory, "backend.sqlite"), { reportRetentionMs: 1_000 });
  try {
    const createdAt = 1_700_000_000_000;
    const report = makeReport({ eventId: "retention-event", createdAt });
    const envelope = new SimulatedNode("origin", new DeterministicRoutingManager()).create(report);
    assert.equal(backend.ingest(envelope, createdAt).status, "ACCEPTED");
    assert.deepEqual(backend.signedReportBytes(report.eventId), canonicalReportBytes(report));
    assert.equal(backend.prune(report.validUntil + 999), 0);
    assert.equal(backend.prune(report.validUntil + 1_000), 1);
    assert.equal(backend.size(), 0);
    assert.equal(backend.arrivalCount(report.eventId), 0);
  } finally {
    backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
