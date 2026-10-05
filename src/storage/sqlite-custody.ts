import { createHash, timingSafeEqual } from "node:crypto";
import { serializeEnvelope } from "../protocol/codec.ts";
import { canonicalReportBytes, verifyReportSignature } from "../protocol/identity.ts";
import { isExpired, type EmergencyEnvelope } from "../protocol/types.ts";
import { createPeerAcknowledgement } from "../transports/ack.ts";
import type { DeliveryAcknowledgement } from "../transports/transport.ts";
import type { CustodyAcceptanceStore } from "./custody.ts";
import type { QueueLimits } from "./limits.ts";
import { SqliteStoreAndForwardQueue } from "./sqlite-store.ts";

const priorityRank = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 } as const;

type ReceiptRow = {
  acknowledgement_json: string;
  expires_at: number;
  report_digest: Uint8Array;
};

/** SQLite queue whose new custody record and envelope enqueue commit atomically. */
export class SqliteCustodyQueue extends SqliteStoreAndForwardQueue implements CustodyAcceptanceStore {
  constructor(path: string, limits: QueueLimits = {}) {
    super(path, limits);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS custody_receipts (
        event_id TEXT NOT NULL,
        packet_id TEXT NOT NULL,
        acknowledgement_json TEXT NOT NULL,
        report_digest BLOB NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(event_id, packet_id)
      );
      CREATE INDEX IF NOT EXISTS custody_receipts_expiry_idx
        ON custody_receipts(expires_at);
    `);
  }

  acceptCustody(
    envelope: EmergencyEnvelope,
    issuerId: string,
    acknowledgedAt = Date.now(),
  ): DeliveryAcknowledgement | undefined {
    this.prune(acknowledgedAt);
    if (!issuerId) throw new Error("custody issuerId is required");
    if (isExpired(envelope, acknowledgedAt) || !verifyReportSignature(envelope.report)) return undefined;
    const binary = serializeEnvelope(envelope);
    if (binary.length > this.limits.maxBytes) return undefined;
    const reportDigest = createHash("sha256").update(canonicalReportBytes(envelope.report)).digest();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.readReceiptRow(envelope.report.eventId, envelope.packetId);
      if (existing && this.matchesReport(existing.report_digest, reportDigest)) {
        this.database.exec("COMMIT");
        return JSON.parse(existing.acknowledgement_json) as DeliveryAcknowledgement;
      }
      if (existing) {
        this.database.exec("ROLLBACK");
        return undefined;
      }

      const seen = Boolean(this.database.prepare("SELECT 1 FROM seen_events WHERE event_id = ?")
        .get(envelope.report.eventId));
      const acknowledgement = createPeerAcknowledgement(issuerId, envelope, acknowledgedAt);
      if (seen) {
        const prior = this.database.prepare(`
          SELECT report_digest FROM custody_receipts
          WHERE event_id = ? LIMIT 1
        `).get(envelope.report.eventId) as Pick<ReceiptRow, "report_digest"> | undefined;
        if (!prior || !this.matchesReport(prior.report_digest, reportDigest)) {
          this.database.exec("ROLLBACK");
          return undefined;
        }
        acknowledgement.status = "DUPLICATE";
      } else {
        if (!this.makeRoom(binary.length, priorityRank[envelope.report.priority])) {
          this.database.exec("ROLLBACK");
          return undefined;
        }
        this.database.prepare(
          "INSERT INTO seen_events(event_id, first_seen_at, expires_at) VALUES (?, ?, ?)",
        ).run(envelope.report.eventId, acknowledgedAt, envelope.expiresAt + this.limits.replayRetentionMs);
        this.database.prepare(`
          INSERT INTO forward_queue(event_id, envelope, priority_rank, received_at, attempts, next_attempt_at)
          VALUES (?, ?, ?, ?, 0, ?)
        `).run(
          envelope.report.eventId,
          binary,
          priorityRank[envelope.report.priority],
          acknowledgedAt,
          acknowledgedAt,
        );
      }
      this.database.prepare(`
        INSERT INTO custody_receipts(event_id, packet_id, acknowledgement_json, report_digest, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        envelope.report.eventId,
        envelope.packetId,
        JSON.stringify(acknowledgement),
        reportDigest,
        envelope.expiresAt,
      );
      this.database.exec("COMMIT");
      return structuredClone(acknowledgement);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  custodyReceipt(eventId: string, packetId: string, now = Date.now()): DeliveryAcknowledgement | undefined {
    this.pruneCustody(now);
    return this.readReceipt(eventId, packetId);
  }

  pruneCustody(now = Date.now()): number {
    return Number(this.database.prepare("DELETE FROM custody_receipts WHERE expires_at <= ?").run(now).changes);
  }

  override prune(now = Date.now()): number {
    const removed = super.prune(now);
    this.pruneCustody(now);
    return removed;
  }

  private readReceipt(eventId: string, packetId: string): DeliveryAcknowledgement | undefined {
    const row = this.readReceiptRow(eventId, packetId);
    return row ? JSON.parse(row.acknowledgement_json) as DeliveryAcknowledgement : undefined;
  }

  private readReceiptRow(eventId: string, packetId: string): ReceiptRow | undefined {
    return this.database.prepare(`
      SELECT acknowledgement_json, expires_at, report_digest
      FROM custody_receipts WHERE event_id = ? AND packet_id = ?
    `).get(eventId, packetId) as ReceiptRow | undefined;
  }

  private matchesReport(stored: Uint8Array, candidate: Uint8Array): boolean {
    return stored.length === candidate.length && timingSafeEqual(stored, candidate);
  }
}
