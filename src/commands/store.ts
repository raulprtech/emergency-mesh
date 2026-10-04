import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalReportBytes } from "../protocol/identity.ts";
import { validateEnvelope, type EmergencyEnvelope, type EmergencyReport } from "../protocol/types.ts";
import { receiptErrors, responseErrors, RESPONSE_EVENT } from "../mobile-client/commands.js";
import { verifyAuthorizedCommand, verifyColuviReport, type ColuviAuthority } from "./authority.ts";

interface ParticipantRow { device_id: string; public_key: string; zone_id: string; active: number; }
interface CommandRow { sequence: number; command_id: string; report_json: string; prompt_until: number; response_until: number; }
interface ResponseRow { event_id: string; report_json: string; received_at: number; observed_at: number; created_at: number; late: number; }
export interface CheckinPayload {
  commandId: string; incidentRef: string; issuerId: string; zoneId: string; issuedAt: number; promptUntil: number; responseUntil: number; nonce: string;
}
export interface CheckinProjection {
  command: EmergencyReport;
  units: "devices";
  counts: { requested: number; received: number; shown: number; responded: number; safe: number; needsHelp: number; unknown: number; pending: number; late: number };
  pagination: { offset: number; limit: number; total: number; hasMore: boolean };
  recipients: { deviceId: string; state: "SAFE" | "NEEDS_HELP" | "UNKNOWN" | "PENDING"; received: boolean; shown: boolean; history: { report: EmergencyReport; receivedAt: number; late: boolean }[] }[];
}

/** Private, additive tables. Never use these reports for public aggregation. */
export class ColuviStore {
  private readonly database: DatabaseSync;
  private readonly authorities: ColuviAuthority[];
  private readonly maximumParticipants: number;
  constructor(path: string, authorities: ColuviAuthority[], maximumParticipants = 1_000) {
    if (!Number.isSafeInteger(maximumParticipants) || maximumParticipants < 1 || maximumParticipants > 10_000) throw new Error("Invalid participant capacity");
    this.authorities = structuredClone(authorities);
    this.maximumParticipants = maximumParticipants;
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS coluvi_participants (
        device_id TEXT PRIMARY KEY, public_key TEXT NOT NULL UNIQUE, zone_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, enrolled_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coluvi_commands (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE, issuer_id TEXT NOT NULL, nonce TEXT NOT NULL,
        zone_id TEXT NOT NULL, report_json TEXT NOT NULL, prompt_until INTEGER NOT NULL, response_until INTEGER NOT NULL, UNIQUE(issuer_id, nonce)
      );
      CREATE TABLE IF NOT EXISTS coluvi_recipients (
        command_id TEXT NOT NULL REFERENCES coluvi_commands(command_id), device_id TEXT NOT NULL REFERENCES coluvi_participants(device_id),
        public_key TEXT NOT NULL, PRIMARY KEY(command_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS coluvi_responses (
        event_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, device_id TEXT NOT NULL, nonce TEXT NOT NULL,
        report_json TEXT NOT NULL, received_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL, late INTEGER NOT NULL,
        FOREIGN KEY(command_id, device_id) REFERENCES coluvi_recipients(command_id, device_id), UNIQUE(device_id, nonce)
      );
      CREATE INDEX IF NOT EXISTS coluvi_responses_command ON coluvi_responses(command_id, device_id, observed_at, created_at, event_id);
      CREATE TABLE IF NOT EXISTS coluvi_receipts (
        event_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, device_id TEXT NOT NULL, nonce TEXT NOT NULL, kind TEXT NOT NULL, report_json TEXT NOT NULL, received_at INTEGER NOT NULL,
        FOREIGN KEY(command_id, device_id) REFERENCES coluvi_recipients(command_id, device_id), UNIQUE(command_id, device_id, kind), UNIQUE(device_id, nonce)
      );
      CREATE TABLE IF NOT EXISTS coluvi_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, subject_id TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coluvi_credentials (
        device_id TEXT PRIMARY KEY REFERENCES coluvi_participants(device_id), token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL
      );
    `);
  }

  /** The API must authenticate enrollment and prove possession before calling this trusted method. */
  enroll(publicKey: string, zoneId: string, now = Date.now()): string {
    if (!this.authorities.some((item) => !item.revoked && item.zones.includes(zoneId))) throw new Error("Unauthorized enrollment zone");
    if (!/^[A-Za-z0-9_-]{59}$/.test(publicKey)) throw new Error("Invalid Ed25519 public key");
    const bytes = Buffer.from(publicKey, "base64url");
    if (bytes.length !== 44 || bytes.toString("base64url") !== publicKey || bytes.subarray(0, 12).toString("hex") !== "302a300506032b6570032100") throw new Error("Invalid Ed25519 public key");
    const deviceId = createHash("sha256").update(bytes).digest("base64url").slice(0, 22);
    const existing = this.participant(deviceId);
    if (existing) {
      if (existing.public_key !== publicKey || existing.zone_id !== zoneId || !existing.active) throw new Error("Participant enrollment conflict");
      return deviceId;
    }
    const total = this.database.prepare("SELECT COUNT(*) AS n FROM coluvi_participants").get() as { n: number };
    if (total.n >= this.maximumParticipants) throw new Error("Participant capacity exceeded");
    this.transaction(() => {
      this.database.prepare("INSERT INTO coluvi_participants(device_id, public_key, zone_id, enrolled_at) VALUES (?, ?, ?, ?)").run(deviceId, publicKey, zoneId, now);
      this.audit("ENROLLED", deviceId, now);
    });
    return deviceId;
  }

  revokeParticipant(deviceId: string, now = Date.now()): void {
    this.transaction(() => {
      if (!this.database.prepare("UPDATE coluvi_participants SET active=0 WHERE device_id=?").run(deviceId).changes) throw new Error("Unknown participant");
      this.audit("PARTICIPANT_REVOKED", deviceId, now);
    });
  }

  participant(deviceId: string): ParticipantRow | undefined {
    return this.database.prepare("SELECT device_id, public_key, zone_id, active FROM coluvi_participants WHERE device_id=?").get(deviceId) as ParticipantRow | undefined;
  }

  /** Called only after successful one-use proof of possession, never by device id alone. */
  grantCredential(deviceId: string, now = Date.now()): { token: string; expiresAt: number } {
    if (!this.participant(deviceId)?.active || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid credential participant or time");
    const token = randomBytes(32).toString("base64url"); const expiresAt = now + 7 * 24 * 60 * 60_000;
    this.transaction(() => {
      this.database.prepare("INSERT INTO coluvi_credentials(device_id, token_hash, expires_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET token_hash=excluded.token_hash, expires_at=excluded.expires_at")
        .run(deviceId, createHash("sha256").update(token).digest("hex"), expiresAt);
      this.audit("CREDENTIAL_GRANTED", deviceId, now);
    });
    return { token, expiresAt };
  }

  authenticateCredential(header: string | undefined, now = Date.now()): ParticipantRow | undefined {
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return undefined;
    const hash = createHash("sha256").update(header.slice(7)).digest("hex");
    return this.database.prepare(`SELECT p.device_id, p.public_key, p.zone_id, p.active FROM coluvi_credentials c JOIN coluvi_participants p ON p.device_id=c.device_id
      WHERE c.token_hash=? AND c.expires_at>? AND p.active=1`).get(hash, now) as ParticipantRow | undefined;
  }

  recordAccess(action: "OPERATOR_LOGIN" | "OPERATOR_LOGIN_FAILED" | "OPERATOR_LOGOUT", now = Date.now()): void {
    this.audit(action, "pilot-operator", now);
  }

  issue(report: EmergencyReport, now = Date.now()): "ACCEPTED" | "DUPLICATE" {
    if (!verifyAuthorizedCommand(report, this.authorities, now)) throw new Error("Invalid or unauthorized command");
    const command = report.extensions!.coluvi as CheckinPayload;
    return this.transaction(() => {
      const existing = this.command(command.commandId);
      if (existing) {
        if (!Buffer.from(canonicalReportBytes(existing)).equals(Buffer.from(canonicalReportBytes(report))) || existing.signature!.value !== report.signature!.value) throw new Error("Command id conflict");
        return "DUPLICATE";
      }
      this.database.prepare("INSERT INTO coluvi_commands(command_id, issuer_id, nonce, zone_id, report_json, prompt_until, response_until) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(command.commandId, command.issuerId, command.nonce, command.zoneId, JSON.stringify(report), command.promptUntil, command.responseUntil);
      this.database.prepare("INSERT INTO coluvi_recipients(command_id, device_id, public_key) SELECT ?, device_id, public_key FROM coluvi_participants WHERE zone_id=? AND active=1")
        .run(command.commandId, command.zoneId);
      this.audit("CHECKIN_ISSUED", command.commandId, now);
      return "ACCEPTED";
    });
  }

  command(commandId: string): EmergencyReport | undefined {
    const row = this.database.prepare("SELECT report_json FROM coluvi_commands WHERE command_id=?").get(commandId) as { report_json: string } | undefined;
    return row ? JSON.parse(row.report_json) : undefined;
  }

  listCommands(limit = 50): EmergencyReport[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid command limit");
    return (this.database.prepare("SELECT report_json FROM coluvi_commands ORDER BY sequence DESC LIMIT ?").all(limit) as unknown as CommandRow[]).map((row) => JSON.parse(row.report_json));
  }

  inbox(deviceId: string, cursor = 0, limit = 50, now = Date.now()): { commands: EmergencyReport[]; cursor: number; hasMore: boolean } {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid inbox pagination");
    if (!this.participant(deviceId)?.active) throw new Error("Unknown or revoked participant");
    const rows = this.database.prepare(`SELECT c.* FROM coluvi_commands c JOIN coluvi_recipients r ON r.command_id=c.command_id
      WHERE r.device_id=? AND c.sequence>? AND c.response_until>? ORDER BY c.sequence LIMIT ?`).all(deviceId, cursor, now, limit + 1) as unknown as CommandRow[];
    const selected = rows.slice(0, limit);
    // Revocation also stops delivery; previously stored clients must refresh trust before online display.
    const commands = selected.map((row) => JSON.parse(row.report_json) as EmergencyReport).filter((report) => verifyAuthorizedCommand(report, this.authorities, now, true));
    return { commands, cursor: selected.at(-1)?.sequence ?? cursor, hasMore: rows.length > limit };
  }

  acceptResponse(envelope: EmergencyEnvelope, now = Date.now()): { status: "ACCEPTED" | "DUPLICATE"; eventId: string; signatureValid: true } {
    const report = envelope.report;
    const payload = report.extensions?.coluvi as { commandId?: string } | undefined;
    const command = payload?.commandId ? this.command(payload.commandId) : undefined;
    if (report.eventType !== RESPONSE_EVENT || !command || validateEnvelope(envelope).length || responseErrors(report, command).length
      || envelope.expiresAt <= now || report.createdAt > now || !verifyAuthorizedCommand(command, this.authorities, now, true)
      || !verifyColuviReport(report)) throw new Error("Invalid, expired or unauthorized check-in response");
    const recipient = this.database.prepare("SELECT public_key FROM coluvi_recipients WHERE command_id=? AND device_id=?").get(command.eventId, report.anonymousDeviceId) as { public_key: string } | undefined;
    if (!this.participant(report.anonymousDeviceId)?.active || recipient?.public_key !== report.signature!.publicKey) throw new Error("Response sender is not an authorized recipient");
    const commandPayload = command.extensions!.coluvi as CheckinPayload;
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT report_json FROM coluvi_responses WHERE event_id=?").get(report.eventId) as { report_json: string } | undefined;
      if (existing) {
        const original = JSON.parse(existing.report_json) as EmergencyReport;
        if (!Buffer.from(canonicalReportBytes(original)).equals(Buffer.from(canonicalReportBytes(report))) || original.signature!.value !== report.signature!.value) throw new Error("Response id conflict");
        return { status: "DUPLICATE", eventId: report.eventId, signatureValid: true };
      }
      const count = this.database.prepare("SELECT COUNT(*) AS n FROM coluvi_responses WHERE command_id=? AND device_id=?").get(command.eventId, report.anonymousDeviceId) as { n: number };
      if (count.n >= 100) throw new Error("Response history capacity exceeded");
      this.database.prepare("INSERT INTO coluvi_responses(event_id, command_id, device_id, nonce, report_json, received_at, observed_at, created_at, late) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(report.eventId, command.eventId, report.anonymousDeviceId, report.nonce, JSON.stringify(report), now, report.observedAt, report.createdAt, now >= commandPayload.promptUntil ? 1 : 0);
      this.audit("CHECKIN_RESPONSE", report.eventId, now);
      return { status: "ACCEPTED", eventId: report.eventId, signatureValid: true };
    });
  }

  acceptReceipt(report: EmergencyReport, authenticatedDeviceId: string, now = Date.now()): "ACCEPTED" | "DUPLICATE" {
    const payload = report.extensions?.coluvi as { commandId: string; evidence: string } | undefined;
    const command = payload?.commandId ? this.command(payload.commandId) : undefined;
    if (!command || receiptErrors(report, command).length || report.anonymousDeviceId !== authenticatedDeviceId
      || report.createdAt > now || !verifyAuthorizedCommand(command, this.authorities, now, true) || !verifyColuviReport(report)) throw new Error("Invalid or unauthorized receipt");
    const recipient = this.database.prepare("SELECT public_key FROM coluvi_recipients WHERE command_id=? AND device_id=?").get(command.eventId, report.anonymousDeviceId) as { public_key: string } | undefined;
    if (!this.participant(report.anonymousDeviceId)?.active || recipient?.public_key !== report.signature!.publicKey) throw new Error("Receipt sender is not an authorized recipient");
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT report_json FROM coluvi_receipts WHERE event_id=?").get(report.eventId) as { report_json: string } | undefined;
      if (existing) {
        const original = JSON.parse(existing.report_json) as EmergencyReport;
        if (!Buffer.from(canonicalReportBytes(original)).equals(Buffer.from(canonicalReportBytes(report))) || original.signature!.value !== report.signature!.value) throw new Error("Receipt id conflict");
        return "DUPLICATE";
      }
      const sameEvidence = this.database.prepare("SELECT 1 FROM coluvi_receipts WHERE command_id=? AND device_id=? AND kind=?").get(command.eventId, report.anonymousDeviceId, payload!.evidence);
      if (sameEvidence) return "DUPLICATE";
      this.database.prepare("INSERT INTO coluvi_receipts(event_id, command_id, device_id, nonce, kind, report_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(report.eventId, command.eventId, report.anonymousDeviceId, report.nonce, payload!.evidence, JSON.stringify(report), now);
      this.audit(`CHECKIN_${payload!.evidence}`, report.eventId, now);
      return "ACCEPTED";
    });
  }

  projection(commandId: string, now = Date.now(), offset = 0, limit = 50): CheckinProjection {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid projection pagination");
    const command = this.command(commandId);
    if (!command) throw new Error("Unknown command");
    const payload = command.extensions!.coluvi as CheckinPayload;
    // Count all intended recipients in SQL, but return only a bounded page of private histories.
    const totals = this.database.prepare(`WITH latest AS (
      SELECT device_id, late, json_extract(report_json, '$.extensions.coluvi.status') AS state,
        ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY observed_at DESC, created_at DESC, event_id DESC) AS ordinal
      FROM coluvi_responses WHERE command_id=?
    ) SELECT COUNT(*) AS requested,
      COALESCE(SUM(EXISTS(SELECT 1 FROM coluvi_receipts e WHERE e.command_id=r.command_id AND e.device_id=r.device_id AND e.kind='RECEIVED')),0) AS received,
      COALESCE(SUM(EXISTS(SELECT 1 FROM coluvi_receipts e WHERE e.command_id=r.command_id AND e.device_id=r.device_id AND e.kind='SHOWN')),0) AS shown,
      COALESCE(SUM(l.state IS NOT NULL),0) AS responded,
      COALESCE(SUM(l.state='SAFE'),0) AS safe, COALESCE(SUM(l.state='NEEDS_HELP'),0) AS needsHelp,
      COALESCE(SUM(l.state IS NULL AND ? >= ?),0) AS unknown, COALESCE(SUM(l.state IS NULL AND ? < ?),0) AS pending,
      COALESCE(SUM(l.late),0) AS late
      FROM coluvi_recipients r LEFT JOIN latest l ON l.device_id=r.device_id AND l.ordinal=1 WHERE r.command_id=?`)
      .get(commandId, now, payload.promptUntil, now, payload.promptUntil, commandId) as CheckinProjection["counts"];
    const counts = { ...totals };
    const rows = this.database.prepare("SELECT device_id FROM coluvi_recipients WHERE command_id=? ORDER BY device_id LIMIT ? OFFSET ?").all(commandId, limit, offset) as unknown as { device_id: string }[];
    const recipients: CheckinProjection["recipients"] = rows.map(({ device_id }) => {
      const responses = this.database.prepare("SELECT * FROM coluvi_responses WHERE command_id=? AND device_id=? ORDER BY observed_at, created_at, event_id").all(commandId, device_id) as unknown as ResponseRow[];
      const receipts = this.database.prepare("SELECT kind FROM coluvi_receipts WHERE command_id=? AND device_id=?").all(commandId, device_id) as unknown as { kind: string }[];
      const history = responses.map((row) => ({ report: JSON.parse(row.report_json) as EmergencyReport, receivedAt: row.received_at, late: Boolean(row.late) }));
      const latest = history.at(-1);
      const state = latest ? (latest.report.extensions!.coluvi as { status: "SAFE" | "NEEDS_HELP" }).status : now >= payload.promptUntil ? "UNKNOWN" : "PENDING";
      const received = receipts.some((row) => row.kind === "RECEIVED");
      const shown = receipts.some((row) => row.kind === "SHOWN");
      return { deviceId: device_id, state, received, shown, history };
    });
    return { command, units: "devices", counts, recipients, pagination: { offset, limit, total: counts.requested, hasMore: offset + rows.length < counts.requested } };
  }

  prune(now = Date.now(), retentionMs = 30 * 24 * 60 * 60_000): number {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error("Invalid retention");
    const expired = this.database.prepare("SELECT command_id FROM coluvi_commands WHERE response_until<=?").all(now - retentionMs) as unknown as { command_id: string }[];
    return this.transaction(() => {
      for (const { command_id } of expired) {
        for (const table of ["coluvi_responses", "coluvi_receipts", "coluvi_recipients", "coluvi_commands"]) this.database.prepare(`DELETE FROM ${table} WHERE command_id=?`).run(command_id);
      }
      this.database.prepare("DELETE FROM coluvi_audit WHERE at<?").run(now - retentionMs);
      return expired.length;
    });
  }

  private audit(action: string, subjectId: string, now: number): void {
    this.database.prepare("INSERT INTO coluvi_audit(action, subject_id, at) VALUES (?, ?, ?)").run(action, subjectId, now);
  }
  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.database.close(); }
}
