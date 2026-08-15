import { DatabaseSync } from "node:sqlite";
import { deserializeEnvelope, serializeEnvelope } from "../protocol/codec.ts";
import { resolveQueueLimits, type QueueLimits } from "./limits.ts";
import { canForward, isExpired, type EmergencyEnvelope } from "../protocol/types.ts";
import type { StoreAndForwardStore } from "./queue.ts";
import type { QueueRecord } from "./store.ts";

const priorityRank = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 } as const;

type QueueRow = {
  event_id: string;
  envelope: Uint8Array;
  received_at: number;
  attempts: number;
  next_attempt_at: number;
};

export class SqliteStoreAndForwardQueue implements StoreAndForwardStore {
  protected readonly database: DatabaseSync;
  protected readonly limits: Required<QueueLimits>;

  constructor(path: string, limits: QueueLimits = {}) {
    this.limits = resolveQueueLimits(limits);
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS seen_events (
        event_id TEXT PRIMARY KEY,
        first_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS forward_queue (
        event_id TEXT PRIMARY KEY REFERENCES seen_events(event_id),
        envelope BLOB NOT NULL,
        priority_rank INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queue_ready_idx
        ON forward_queue(next_attempt_at, priority_rank, received_at);
    `);
  }

  enqueue(envelope: EmergencyEnvelope, now = Date.now()): boolean {
    this.prune(now);
    if (isExpired(envelope, now)) return false;
    const binary = serializeEnvelope(envelope);
    if (binary.length > this.limits.maxBytes) return false;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.makeRoom(binary.length, priorityRank[envelope.report.priority])) {
        this.database.exec("ROLLBACK");
        return false;
      }
      const seen = this.database.prepare(
        "INSERT OR IGNORE INTO seen_events(event_id, first_seen_at, expires_at) VALUES (?, ?, ?)",
      ).run(envelope.report.eventId, now, envelope.expiresAt + this.limits.replayRetentionMs);
      if (Number(seen.changes) === 0) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.database.prepare(`
        INSERT INTO forward_queue(event_id, envelope, priority_rank, received_at, attempts, next_attempt_at)
        VALUES (?, ?, ?, ?, 0, ?)
      `).run(envelope.report.eventId, binary, priorityRank[envelope.report.priority], now, now);
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  ready(now = Date.now()): QueueRecord[] {
    this.prune(now);
    const rows = this.database.prepare(`
      SELECT event_id, envelope, received_at, attempts, next_attempt_at, length(envelope) AS byte_size
      FROM forward_queue
      WHERE next_attempt_at <= ?
      ORDER BY priority_rank ASC, received_at ASC
    `).all(now) as unknown as QueueRow[];
    return rows
      .map((row) => ({
        envelope: deserializeEnvelope(row.envelope),
        receivedAt: row.received_at,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        byteSize: Number((row as QueueRow & { byte_size: number }).byte_size),
      }))
      .filter((record) => canForward(record.envelope, now));
  }

  recordFailure(eventId: string, now = Date.now()): void {
    const row = this.database.prepare("SELECT attempts FROM forward_queue WHERE event_id = ?").get(eventId) as { attempts: number } | undefined;
    if (!row) return;
    const attempts = row.attempts + 1;
    const nextAttemptAt = now + Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
    this.database.prepare("UPDATE forward_queue SET attempts = ?, next_attempt_at = ? WHERE event_id = ?")
      .run(attempts, nextAttemptAt, eventId);
  }

  remove(eventId: string): boolean {
    return Number(this.database.prepare("DELETE FROM forward_queue WHERE event_id = ?").run(eventId).changes) > 0;
  }
  has(eventId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM forward_queue WHERE event_id = ?").get(eventId));
  }
  size(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM forward_queue").get() as { count: number };
    return Number(row.count);
  }
  hasSeen(eventId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM seen_events WHERE event_id = ?").get(eventId));
  }

  prune(now = Date.now()): number {
    const rows = this.database.prepare("SELECT event_id, envelope FROM forward_queue").all() as unknown as Pick<QueueRow, "event_id" | "envelope">[];
    let removed = 0;
    const remove = this.database.prepare("DELETE FROM forward_queue WHERE event_id = ?");
    for (const row of rows) {
      const envelope = deserializeEnvelope(row.envelope);
      if (isExpired(envelope, now) || envelope.hopCount >= envelope.hopLimit) {
        removed += Number(remove.run(row.event_id).changes);
      }
    }
    this.database.prepare("DELETE FROM seen_events WHERE expires_at <= ? AND event_id NOT IN (SELECT event_id FROM forward_queue)").run(now);
    return removed;
  }

  protected makeRoom(byteSize: number, incomingRank: number): boolean {
    const totals = this.database.prepare("SELECT COUNT(*) AS items, COALESCE(SUM(length(envelope)), 0) AS bytes FROM forward_queue").get() as { items: number; bytes: number };
    let items = Number(totals.items) + 1;
    let bytes = Number(totals.bytes) + byteSize;
    if (items <= this.limits.maxItems && bytes <= this.limits.maxBytes) return true;
    const candidates = this.database.prepare(`
      SELECT event_id, length(envelope) AS byte_size
      FROM forward_queue WHERE priority_rank > ?
      ORDER BY priority_rank DESC, received_at DESC
    `).all(incomingRank) as unknown as { event_id: string; byte_size: number }[];
    for (const candidate of candidates) {
      this.database.prepare("DELETE FROM forward_queue WHERE event_id = ?").run(candidate.event_id);
      items -= 1; bytes -= Number(candidate.byte_size);
      if (items <= this.limits.maxItems && bytes <= this.limits.maxBytes) return true;
    }
    return false;
  }

  close(): void { this.database.close(); }
}
