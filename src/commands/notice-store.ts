import { DatabaseSync } from "node:sqlite";
import { canonicalReportBytes } from "../protocol/identity.ts";
import type { EmergencyReport } from "../protocol/types.ts";
import { noticeReceiptErrors } from "../mobile-client/notices.js";
import { verifyColuviReport, type ColuviAuthority } from "./authority.ts";
import { verifyAuthorizedNotice, type NoticePayload } from "./notices.ts";

interface NoticeRow { sequence: number; report_json: string; }
interface ParticipantRow { public_key: string; active: number; }
export interface NoticeProjection {
  notice: EmergencyReport; units: "devices";
  counts: { requested: number; received: number; shown: number };
  pagination: { offset: number; limit: number; total: number; hasMore: boolean };
  recipients: { deviceId: string; received: boolean; shown: boolean }[];
}
function sameReport(left: EmergencyReport, right: EmergencyReport): boolean {
  return Buffer.from(canonicalReportBytes(left)).equals(Buffer.from(canonicalReportBytes(right))) && left.signature?.value === right.signature?.value;
}
function page(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid notice pagination");
}

/** Requires the existing ColuviStore schema. Shares participants, never public report tables. */
export class NoticeStore {
  private readonly database: DatabaseSync;
  private readonly authorities: ColuviAuthority[];
  constructor(path: string, authorities: ColuviAuthority[]) {
    this.authorities = structuredClone(authorities); this.database = new DatabaseSync(path);
    try {
      if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='coluvi_participants'").get()) throw new Error("Initialize ColuviStore before NoticeStore");
      this.database.exec(`
        PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS coluvi_notices (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, notice_id TEXT NOT NULL UNIQUE, issuer_id TEXT NOT NULL,
          nonce TEXT NOT NULL, zone_id TEXT NOT NULL, report_json TEXT NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(issuer_id, nonce)
        );
        CREATE TABLE IF NOT EXISTS coluvi_notice_recipients (
          notice_id TEXT NOT NULL REFERENCES coluvi_notices(notice_id), device_id TEXT NOT NULL REFERENCES coluvi_participants(device_id),
          public_key TEXT NOT NULL, PRIMARY KEY(notice_id, device_id)
        );
        CREATE TABLE IF NOT EXISTS coluvi_notice_receipts (
          event_id TEXT PRIMARY KEY, notice_id TEXT NOT NULL, device_id TEXT NOT NULL, nonce TEXT NOT NULL,
          evidence TEXT NOT NULL, report_json TEXT NOT NULL, received_at INTEGER NOT NULL,
          FOREIGN KEY(notice_id, device_id) REFERENCES coluvi_notice_recipients(notice_id, device_id),
          UNIQUE(notice_id, device_id, evidence), UNIQUE(device_id, nonce)
        );
      `);
    } catch (error) { this.database.close(); throw error; }
  }
  issue(report: EmergencyReport, now = Date.now()): "ACCEPTED" | "DUPLICATE" {
    if (!verifyAuthorizedNotice(report, this.authorities, now)) throw new Error("Invalid or unauthorized notice");
    const notice = report.extensions!.coluvi as NoticePayload;
    return this.transaction(() => {
      const existing = this.notice(notice.noticeId);
      if (existing) { if (!sameReport(existing, report)) throw new Error("Notice id conflict"); return "DUPLICATE"; }
      const count = this.database.prepare("SELECT COUNT(*) AS n FROM coluvi_notices").get() as { n: number };
      if (count.n >= 5_000) throw new Error("Notice capacity exceeded");
      this.database.prepare("INSERT INTO coluvi_notices(notice_id, issuer_id, nonce, zone_id, report_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(notice.noticeId, notice.issuerId, notice.nonce, notice.zoneId, JSON.stringify(report), notice.expiresAt);
      this.database.prepare("INSERT INTO coluvi_notice_recipients(notice_id, device_id, public_key) SELECT ?, device_id, public_key FROM coluvi_participants WHERE zone_id=? AND active=1")
        .run(notice.noticeId, notice.zoneId);
      this.audit("NOTICE_ISSUED", notice.noticeId, now); return "ACCEPTED";
    });
  }
  notice(id: string): EmergencyReport | undefined {
    const row = this.database.prepare("SELECT report_json FROM coluvi_notices WHERE notice_id=?").get(id) as NoticeRow | undefined;
    return row ? JSON.parse(row.report_json) : undefined;
  }
  list(limit = 50): EmergencyReport[] {
    page(0, limit);
    return (this.database.prepare("SELECT report_json FROM coluvi_notices ORDER BY sequence DESC LIMIT ?").all(limit) as unknown as NoticeRow[]).map(row => JSON.parse(row.report_json));
  }
  inbox(deviceId: string, cursor = 0, limit = 50, now = Date.now()): { notices: EmergencyReport[]; cursor: number; hasMore: boolean } {
    page(cursor, limit); if (!this.participant(deviceId)?.active) throw new Error("Unknown or revoked participant");
    const rows = this.database.prepare(`SELECT n.* FROM coluvi_notices n JOIN coluvi_notice_recipients r ON n.notice_id=r.notice_id
      WHERE r.device_id=? AND n.sequence>? AND n.expires_at>? ORDER BY n.sequence LIMIT ?`).all(deviceId, cursor, now, limit + 1) as unknown as NoticeRow[];
    const selected = rows.slice(0, limit);
    return { notices: selected.map(row => JSON.parse(row.report_json) as EmergencyReport).filter(report => verifyAuthorizedNotice(report, this.authorities, now)), cursor: selected.at(-1)?.sequence ?? cursor, hasMore: rows.length > limit };
  }
  acceptReceipt(report: EmergencyReport, authenticatedDeviceId: string, now = Date.now()): "ACCEPTED" | "DUPLICATE" {
    const payload = report?.extensions?.coluvi as { noticeId?: string; evidence: string } | undefined;
    const notice = payload?.noticeId ? this.notice(payload.noticeId) : undefined;
    if (!notice || noticeReceiptErrors(report, notice).length || report.anonymousDeviceId !== authenticatedDeviceId
      || report.createdAt > now || !verifyAuthorizedNotice(notice, this.authorities, now) || !verifyColuviReport(report)) throw new Error("Invalid or unauthorized notice receipt");
    const recipient = this.database.prepare("SELECT public_key FROM coluvi_notice_recipients WHERE notice_id=? AND device_id=?").get(notice.eventId, report.anonymousDeviceId) as { public_key: string } | undefined;
    if (!this.participant(report.anonymousDeviceId)?.active || recipient?.public_key !== report.signature!.publicKey) throw new Error("Unauthorized notice receipt sender");
    return this.transaction(() => {
      const original = this.database.prepare("SELECT report_json FROM coluvi_notice_receipts WHERE event_id=?").get(report.eventId) as { report_json: string } | undefined;
      if (original) { if (!sameReport(JSON.parse(original.report_json), report)) throw new Error("Notice receipt id conflict"); return "DUPLICATE"; }
      if (this.database.prepare("SELECT 1 FROM coluvi_notice_receipts WHERE notice_id=? AND device_id=? AND evidence=?").get(notice.eventId, report.anonymousDeviceId, payload!.evidence)) return "DUPLICATE";
      this.database.prepare("INSERT INTO coluvi_notice_receipts(event_id, notice_id, device_id, nonce, evidence, report_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(report.eventId, notice.eventId, report.anonymousDeviceId, report.nonce, payload!.evidence, JSON.stringify(report), now);
      this.audit(`NOTICE_${payload!.evidence}`, report.eventId, now); return "ACCEPTED";
    });
  }
  projection(id: string, offset = 0, limit = 50): NoticeProjection {
    page(offset, limit); const notice = this.notice(id); if (!notice) throw new Error("Unknown notice");
    const counts = this.database.prepare(`SELECT COUNT(*) AS requested,
      COALESCE(SUM(EXISTS(SELECT 1 FROM coluvi_notice_receipts e WHERE e.notice_id=r.notice_id AND e.device_id=r.device_id AND evidence='RECEIVED')),0) AS received,
      COALESCE(SUM(EXISTS(SELECT 1 FROM coluvi_notice_receipts e WHERE e.notice_id=r.notice_id AND e.device_id=r.device_id AND evidence='SHOWN')),0) AS shown
      FROM coluvi_notice_recipients r WHERE r.notice_id=?`).get(id) as NoticeProjection["counts"];
    const rows = this.database.prepare(`SELECT device_id,
      EXISTS(SELECT 1 FROM coluvi_notice_receipts e WHERE e.notice_id=r.notice_id AND e.device_id=r.device_id AND evidence='RECEIVED') AS received,
      EXISTS(SELECT 1 FROM coluvi_notice_receipts e WHERE e.notice_id=r.notice_id AND e.device_id=r.device_id AND evidence='SHOWN') AS shown
      FROM coluvi_notice_recipients r WHERE notice_id=? ORDER BY device_id LIMIT ? OFFSET ?`).all(id, limit, offset) as unknown as { device_id: string; received: number; shown: number }[];
    return { notice, units: "devices", counts: { ...counts }, pagination: { offset, limit, total: counts.requested, hasMore: offset + rows.length < counts.requested }, recipients: rows.map(row => ({ deviceId: row.device_id, received: Boolean(row.received), shown: Boolean(row.shown) })) };
  }
  prune(now = Date.now(), retentionMs = 30 * 24 * 60 * 60_000): number {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0 || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid notice retention");
    const rows = this.database.prepare("SELECT notice_id FROM coluvi_notices WHERE expires_at<=?").all(now - retentionMs) as unknown as { notice_id: string }[];
    return this.transaction(() => {
      for (const { notice_id } of rows) for (const table of ["coluvi_notice_receipts", "coluvi_notice_recipients", "coluvi_notices"]) this.database.prepare(`DELETE FROM ${table} WHERE notice_id=?`).run(notice_id);
      return rows.length;
    });
  }
  private participant(id: string): ParticipantRow | undefined { return this.database.prepare("SELECT public_key, active FROM coluvi_participants WHERE device_id=?").get(id) as ParticipantRow | undefined; }
  private audit(action: string, id: string, now: number): void { this.database.prepare("INSERT INTO coluvi_audit(action, subject_id, at) VALUES (?, ?, ?)").run(action, id, now); }
  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.database.close(); }
}
