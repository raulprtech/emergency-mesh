import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeterministicRoutingManager } from "../src/routing/manager.ts";
import { makeReport } from "../src/simulator/fixtures.ts";
import { SimulatedNode } from "../src/simulator/node.ts";
import { SqliteCustodyQueue } from "../src/storage/sqlite-custody.ts";

const now = 1_800_000_000_000;
const origin = new SimulatedNode("origin", new DeterministicRoutingManager());

function temporaryDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "emergency-mesh-custody-"));
  return { directory, path: join(directory, "custody.sqlite") };
}

function envelope(eventId: string, priority: "CRITICAL" | "LOW" = "CRITICAL") {
  return origin.create(makeReport({
    eventId,
    priority,
    eventType: priority === "CRITICAL" ? "SOS" : "AREA_STATUS",
    createdAt: now,
  }));
}

test("SQLite commits custody and its replayable ACK atomically across restart", () => {
  const temporary = temporaryDatabase();
  try {
    const value = envelope("durable-custody");
    const first = new SqliteCustodyQueue(temporary.path);
    const acknowledgement = first.acceptCustody(value, "node-b", now);
    assert.equal(acknowledgement?.status, "CUSTODY_ACCEPTED");
    assert.equal(first.size(), 1);
    assert.deepEqual(first.custodyReceipt(value.report.eventId, value.packetId, now), acknowledgement);
    first.close();

    const reopened = new SqliteCustodyQueue(temporary.path);
    assert.deepEqual(reopened.acceptCustody(value, "node-b", now + 1), acknowledgement);
    assert.equal(reopened.size(), 1, "an exact retry must not enqueue twice");
    assert.equal(reopened.remove(value.report.eventId), true);
    assert.deepEqual(reopened.acceptCustody(value, "node-b", now + 2), acknowledgement);
    assert.equal(reopened.size(), 0, "ACK replay must not restore released custody");
    reopened.close();
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test("SQLite only acknowledges duplicates bound to the same signed report", () => {
  const temporary = temporaryDatabase();
  try {
    const firstPacket = envelope("digest-bound-event");
    const queue = new SqliteCustodyQueue(temporary.path);
    assert.equal(queue.acceptCustody(firstPacket, "node-b", now)?.status, "CUSTODY_ACCEPTED");
    queue.remove(firstPacket.report.eventId);

    const retryPacket = { ...structuredClone(firstPacket), packetId: "second-packet-id" };
    const duplicate = queue.acceptCustody(retryPacket, "node-b", now + 1);
    assert.equal(duplicate?.status, "DUPLICATE");
    assert.equal(queue.size(), 0);

    const conflictingPacket = envelope("digest-bound-event");
    conflictingPacket.packetId = "conflicting-packet-id";
    assert.equal(queue.acceptCustody(conflictingPacket, "node-b", now + 2), undefined);
    assert.equal(queue.custodyReceipt(conflictingPacket.report.eventId, conflictingPacket.packetId, now + 2), undefined);
    queue.close();
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test("capacity rejection leaves neither queue custody nor an ACK receipt", () => {
  const temporary = temporaryDatabase();
  try {
    const queue = new SqliteCustodyQueue(temporary.path, { maxItems: 1 });
    const protectedPacket = envelope("protected-critical");
    const rejectedPacket = envelope("rejected-low", "LOW");
    assert.ok(queue.acceptCustody(protectedPacket, "node-b", now));
    assert.equal(queue.acceptCustody(rejectedPacket, "node-b", now + 1), undefined);
    assert.equal(queue.has(rejectedPacket.report.eventId), false);
    assert.equal(queue.hasSeen(rejectedPacket.report.eventId), false);
    assert.equal(queue.custodyReceipt(rejectedPacket.report.eventId, rejectedPacket.packetId, now + 1), undefined);
    queue.close();
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test("invalid signatures never receive durable custody", () => {
  const temporary = temporaryDatabase();
  try {
    const value = envelope("invalid-signature");
    value.report.signature = { ...value.report.signature!, value: "invalid" };
    const queue = new SqliteCustodyQueue(temporary.path);
    assert.equal(queue.acceptCustody(value, "node-b", now), undefined);
    assert.equal(queue.size(), 0);
    assert.equal(queue.hasSeen(value.report.eventId), false);
    queue.close();
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test("custody receipts expire with their envelope", () => {
  const temporary = temporaryDatabase();
  try {
    const value = envelope("expired-receipt");
    const queue = new SqliteCustodyQueue(temporary.path);
    assert.ok(queue.acceptCustody(value, "node-b", now));
    assert.equal(queue.custodyReceipt(value.report.eventId, value.packetId, value.expiresAt), undefined);
    queue.close();
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});
