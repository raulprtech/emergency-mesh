import { DatabaseSync } from "node:sqlite";
import { canonicalReportBytes, verifyReportSignature } from "../protocol/identity.ts";
import { isExpired, validateEnvelope, type EmergencyEnvelope, type EmergencyReport } from "../protocol/types.ts";
import type { AggregationPolicy, AggregationResult, EmergencyBackend, IngestResult } from "./backend.ts";
import { aggregateReports, INTERNAL_AGGREGATION_POLICY, PUBLIC_AGGREGATION_POLICY } from "./aggregation.ts";

type ReportRow = { report_json: string; signed_cbor?: Uint8Array };

export interface BackendRetentionOptions { reportRetentionMs?: number; }

export class SqliteBackend implements EmergencyBackend {
  private readonly database: DatabaseSync;
  private readonly reportRetentionMs: number;

  constructor(path: string, options: BackendRetentionOptions = {}) {
    this.reportRetentionMs = options.reportRetentionMs ?? 30 * 24 * 60 * 60_000;
    if (!Number.isFinite(this.reportRetentionMs) || this.reportRetentionMs < 0) throw new Error("reportRetentionMs must be non-negative");
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        event_id TEXT PRIMARY KEY,
        report_json TEXT NOT NULL,
        signed_cbor BLOB,
        valid_until INTEGER,
        signature_valid INTEGER NOT NULL,
        first_received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS arrivals (
        arrival_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        packet_id TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        signature_valid INTEGER NOT NULL,
        transport_history_json TEXT
      );
      CREATE INDEX IF NOT EXISTS arrivals_event_idx ON arrivals(event_id, received_at);
    `);
    this.ensureColumn("reports", "signed_cbor", "BLOB");
    this.ensureColumn("reports", "valid_until", "INTEGER");
    for (const row of this.database.prepare("SELECT event_id, report_json FROM reports WHERE valid_until IS NULL").all() as unknown as { event_id: string; report_json: string }[]) {
      const report = JSON.parse(row.report_json) as EmergencyReport;
      this.database.prepare("UPDATE reports SET signed_cbor = ?, valid_until = ? WHERE event_id = ?")
        .run(canonicalReportBytes(report), report.validUntil, row.event_id);
    }
  }

  ingest(envelope: EmergencyEnvelope, now = Date.now()): IngestResult {
    const errors = validateEnvelope(envelope);
    if (errors.length) return { status: "INVALID", eventId: envelope.report.eventId, signatureValid: false, errors };
    if (isExpired(envelope, now)) return { status: "EXPIRED", eventId: envelope.report.eventId, signatureValid: false };
    const signatureValid = verifyReportSignature(envelope.report);
    let exists = false;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      exists = Boolean(this.database.prepare("SELECT 1 FROM reports WHERE event_id = ?").get(envelope.report.eventId));
      this.database.prepare(`
        INSERT INTO arrivals(event_id, packet_id, received_at, signature_valid, transport_history_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(envelope.report.eventId, envelope.packetId, now, signatureValid ? 1 : 0, JSON.stringify(envelope.transportHistory ?? []));
      if (!exists) {
        this.database.prepare(`
          INSERT INTO reports(event_id, report_json, signed_cbor, valid_until, signature_valid, first_received_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(envelope.report.eventId, JSON.stringify(envelope.report), canonicalReportBytes(envelope.report), envelope.report.validUntil, signatureValid ? 1 : 0, now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { status: exists ? "DUPLICATE" : "ACCEPTED", eventId: envelope.report.eventId, signatureValid };
  }

  get(eventId: string): EmergencyReport | undefined {
    const row = this.database.prepare("SELECT report_json FROM reports WHERE event_id = ?").get(eventId) as ReportRow | undefined;
    return row ? JSON.parse(row.report_json) as EmergencyReport : undefined;
  }
  list(): EmergencyReport[] {
    return (this.database.prepare("SELECT report_json FROM reports ORDER BY first_received_at, event_id").all() as unknown as ReportRow[])
      .map((row) => JSON.parse(row.report_json) as EmergencyReport);
  }
  arrivalCount(eventId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM arrivals WHERE event_id = ?").get(eventId) as { count: number };
    return Number(row.count);
  }
  size(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM reports").get() as { count: number };
    return Number(row.count);
  }
  activePersonCases(): EmergencyReport[] {
    const reports = this.list();
    const foundRefs = new Set(reports.filter((item) => item.eventType === "PERSON_FOUND").map((item) => item.relatedEventId).filter(Boolean));
    return reports.filter((item) => item.eventType === "PERSON_LAST_SEEN" && !foundRefs.has(item.eventId));
  }
  aggregate(policy: AggregationPolicy = INTERNAL_AGGREGATION_POLICY, now = Date.now()) { return aggregateReports(this.list(), policy, now).areas; }
  publicAggregate(policy: AggregationPolicy = PUBLIC_AGGREGATION_POLICY, now = Date.now()): AggregationResult { return aggregateReports(this.list(), policy, now); }
  signedReportBytes(eventId: string): Uint8Array | undefined {
    const row = this.database.prepare("SELECT signed_cbor FROM reports WHERE event_id = ?").get(eventId) as { signed_cbor: Uint8Array | null } | undefined;
    return row?.signed_cbor ? Uint8Array.from(row.signed_cbor) : undefined;
  }
  prune(now = Date.now()): number {
    const cutoff = now - this.reportRetentionMs;
    const ids = this.database.prepare("SELECT event_id FROM reports WHERE valid_until <= ?").all(cutoff) as unknown as { event_id: string }[];
    if (!ids.length) return 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removeArrivals = this.database.prepare("DELETE FROM arrivals WHERE event_id = ?");
      const removeReport = this.database.prepare("DELETE FROM reports WHERE event_id = ?");
      for (const { event_id } of ids) { removeArrivals.run(event_id); removeReport.run(event_id); }
      this.database.exec("COMMIT");
      return ids.length;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!columns.some((item) => item.name === column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  close(): void { this.database.close(); }
}
