import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { IngestAdmissionController } from "../backend/admission.ts";
import { createBackendAcknowledgement } from "../transports/ack.ts";
import type { EmergencyEnvelope, EmergencyReport } from "../protocol/types.ts";
import { MAX_LATE_MS, MAX_PROMPT_MS } from "../mobile-client/commands.js";
import { authorityFingerprint, createCheckinCommand } from "./authority.ts";
import type { LoadedColuviConfiguration } from "./config.ts";
import { ColuviStore } from "./store.ts";
import { NoticeStore } from "./notice-store.ts";
import { createOperationalNotice } from "./notices.ts";
import { MAX_NOTICE_MS, NOTICE_LEVELS, NOTICE_RECEIPT_EVENT, validNoticeText } from "../mobile-client/notices.js";

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "vary": "Cookie, Authorization", ...headers });
  response.end(JSON.stringify(value));
}
function fields(body: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => ![...required, ...optional].includes(key))
    || required.some((key) => !Object.hasOwn(body, key))) throw new ApiError(400, "Invalid request fields");
  return body as Record<string, unknown>;
}
function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") { request.resume(); throw new ApiError(415, "JSON content type required"); }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let tooLarge = false;
    const timer = setTimeout(() => { request.resume(); reject(new ApiError(408, "Request body timed out")); }, 5_000);
    request.on("data", (chunk) => { size += chunk.length; if (size > 16_384) tooLarge = true; else chunks.push(chunk); });
    request.once("end", () => {
      clearTimeout(timer);
      if (tooLarge) return reject(new ApiError(413, "Request exceeds 16384 bytes"));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new ApiError(400, "Invalid JSON")); }
    });
    request.once("error", () => { clearTimeout(timer); reject(new ApiError(400, "Request interrupted")); });
    request.once("aborted", () => { clearTimeout(timer); reject(new ApiError(400, "Request interrupted")); });
  });
}

export class ColuviApi {
  readonly store: ColuviStore;
  readonly notices: NoticeStore;
  private readonly config: LoadedColuviConfiguration;
  private readonly admission = new IngestAdmissionController({ maximumGlobalRequests: 600, maximumRequestsPerIdentity: 120, maximumTrackedIdentities: 1_000 });
  constructor(databasePath: string, config: LoadedColuviConfiguration) {
    this.config = config; this.store = new ColuviStore(databasePath, [config.authority]);
    try { this.notices = new NoticeStore(databasePath, [config.authority]); }
    catch (error) { this.store.close(); throw error; }
  }

  handles(url: string | undefined): boolean { return Boolean(url?.startsWith("/api/operator/") || url?.startsWith("/api/mobile/")); }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const now = Date.now();
      const origin = new URL(this.config.origin);
      if (request.headers.host !== origin.host || request.headers["sec-fetch-site"] === "cross-site") throw new ApiError(403, "Origin not allowed");
      const url = new URL(request.url!, this.config.origin);
      if (url.search.length > 512) throw new ApiError(400, "Query too large");
      const source = request.socket.remoteAddress ?? "unknown";
      const decision = this.admission.admitRequest(now);
      if (!decision.allowed || !this.admission.admitIdentity(source, now).allowed) throw new ApiError(429, "API rate limited");
      if (request.method === "POST" && request.headers.origin !== this.config.origin) throw new ApiError(403, "Same origin required");
      if (request.method !== "GET" && request.method !== "POST") throw new ApiError(405, "Method not allowed");
      const auth = this.config.auth;
      if (request.method === "POST" && url.pathname === "/api/operator/login") {
        const input = fields(await body(request), ["password"]);
        const result = await auth.login(input.password, source, now);
        this.store.recordAccess(result ? "OPERATOR_LOGIN" : "OPERATOR_LOGIN_FAILED", now);
        if (!result) throw new ApiError(401, "Access denied");
        return json(response, 200, { csrf: result.session.csrf, expiresAt: result.session.expiresAt }, {
          "set-cookie": `coluvi_operator=${result.token}; Path=/api/operator/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict`,
        });
      }
      if (url.pathname.startsWith("/api/operator/")) {
        const session = auth.session(request.headers.cookie, now);
        if (!session) throw new ApiError(401, "Operator login required");
        if (request.method === "POST" && !auth.csrfValid(request.headers.cookie, request.headers["x-coluvi-csrf"], now)) throw new ApiError(403, "CSRF verification required");
        if (request.method === "GET" && url.pathname === "/api/operator/session") return json(response, 200, {
          csrf: session.csrf, expiresAt: session.expiresAt, zones: this.config.authority.zones, kinds: this.config.authority.kinds, fingerprint: authorityFingerprint(this.config.authority),
        });
        if (request.method === "POST" && url.pathname === "/api/operator/logout") {
          fields(await body(request), []); auth.logout(request.headers.cookie); this.store.recordAccess("OPERATOR_LOGOUT", now);
          return json(response, 200, { status: "LOGGED_OUT" }, { "set-cookie": "coluvi_operator=; Path=/api/operator/; Max-Age=0; Secure; HttpOnly; SameSite=Strict" });
        }
        if (request.method === "POST" && url.pathname === "/api/operator/checkins") {
          const input = fields(await body(request), ["incidentRef", "zoneId", "promptMs", "lateMs"]);
          const issuedAt = Date.now();
          if (!auth.csrfValid(request.headers.cookie, request.headers["x-coluvi-csrf"], issuedAt)) throw new ApiError(403, "Session expired before mutation");
          if (typeof input.incidentRef !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(input.incidentRef)
            || typeof input.zoneId !== "string" || !this.config.authority.zones.includes(input.zoneId) || this.config.authority.revoked) throw new ApiError(403, "Command scope not authorized");
          if (!Number.isSafeInteger(input.promptMs) || Number(input.promptMs) < 1_000 || Number(input.promptMs) > MAX_PROMPT_MS
            || !Number.isSafeInteger(input.lateMs) || Number(input.lateMs) < 0 || Number(input.lateMs) > MAX_LATE_MS) throw new ApiError(400, "Invalid command deadlines");
          const command = createCheckinCommand(this.config.identity, this.config.authority, {
            commandId: randomUUID(), nonce: randomUUID(), incidentRef: input.incidentRef, zoneId: input.zoneId,
            issuedAt, promptUntil: issuedAt + Number(input.promptMs), responseUntil: issuedAt + Number(input.promptMs) + Number(input.lateMs),
          });
          this.store.issue(command, issuedAt);
          return json(response, 201, this.store.projection(command.eventId, issuedAt));
        }
        if (request.method === "POST" && url.pathname === "/api/operator/notices") {
          const input = fields(await body(request), ["incidentRef", "zoneId", "sourceLabel", "title", "message", "level", "validMs", "simulation"]);
          const issuedAt = Date.now();
          if (!auth.csrfValid(request.headers.cookie, request.headers["x-coluvi-csrf"], issuedAt)) throw new ApiError(403, "Session expired before mutation");
          if (this.config.authority.revoked || !this.config.authority.kinds.includes("OPERATIONAL_NOTICE") || typeof input.zoneId !== "string" || !this.config.authority.zones.includes(input.zoneId)) throw new ApiError(403, "Notice scope not authorized");
          if (input.simulation !== true || !Number.isSafeInteger(input.validMs) || Number(input.validMs) < 1_000 || Number(input.validMs) > MAX_NOTICE_MS
            || typeof input.incidentRef !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(input.incidentRef)
            || !validNoticeText(input.sourceLabel, 120) || !validNoticeText(input.title, 160) || !validNoticeText(input.message, 1_200) || !NOTICE_LEVELS.includes(input.level as string)) throw new ApiError(400, "Invalid simulation notice");
          const notice = createOperationalNotice(this.config.identity, this.config.authority, {
            noticeId: randomUUID(), nonce: randomUUID(), incidentRef: input.incidentRef, zoneId: input.zoneId,
            issuedAt, expiresAt: issuedAt + Number(input.validMs), sourceLabel: input.sourceLabel as string, title: input.title as string, message: input.message as string, level: input.level as "INFORMATION" | "WARNING",
          });
          this.notices.issue(notice, issuedAt); return json(response, 201, this.notices.projection(notice.eventId));
        }
        if (request.method === "GET" && url.pathname === "/api/operator/notices") {
          if (url.search) throw new ApiError(400, "Unexpected query");
          return json(response, 200, { notices: this.notices.list().map(notice => { const projection = this.notices.projection(notice.eventId); return { notice, units: projection.units, counts: projection.counts }; }) });
        }
        const noticeDetail = url.pathname.match(/^\/api\/operator\/notices\/([A-Za-z0-9_-]{1,80})$/);
        if (request.method === "GET" && noticeDetail) {
          for (const key of url.searchParams.keys()) if (!["offset", "limit"].includes(key) || url.searchParams.getAll(key).length > 1) throw new ApiError(400, "Invalid notice query");
          if (!this.notices.notice(noticeDetail[1])) throw new ApiError(404, "Unknown notice");
          return json(response, 200, this.notices.projection(noticeDetail[1], Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("limit") ?? 50)));
        }
        if (request.method === "GET" && url.pathname === "/api/operator/checkins") {
          if (url.search) throw new ApiError(400, "Unexpected query");
          return json(response, 200, { checkins: this.store.listCommands().map((command) => {
            const projection = this.store.projection(command.eventId, now);
            return { command: projection.command, units: projection.units, counts: projection.counts };
          }) });
        }
        const detail = url.pathname.match(/^\/api\/operator\/checkins\/([A-Za-z0-9_-]{1,80})$/);
        if (request.method === "GET" && detail) {
          for (const key of url.searchParams.keys()) if (!["offset", "limit"].includes(key) || url.searchParams.getAll(key).length > 1) throw new ApiError(400, "Invalid detail query");
          if (!this.store.command(detail[1])) throw new ApiError(404, "Unknown check-in");
          return json(response, 200, this.store.projection(detail[1], now, Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("limit") ?? 50)));
        }
        throw new ApiError(404, "Not found");
      }
      if (request.method === "POST" && url.pathname === "/api/mobile/enrollment/challenge") {
        const input = fields(await body(request), ["code", "publicKey", "zoneId"]);
        if (this.config.authority.revoked) throw new ApiError(403, "Enrollment disabled");
        return json(response, 200, auth.challenge(input.code, input.publicKey, input.zoneId, this.config.authority.zones, source, now));
      }
      if (request.method === "POST" && url.pathname === "/api/mobile/enrollment") {
        const input = fields(await body(request), ["challengeId", "signature"]);
        const completedAt = Date.now();
        const challenge = auth.complete(input.challengeId, input.signature, completedAt);
        const deviceId = this.store.enroll(challenge.publicKey, challenge.zoneId, completedAt);
        const credential = this.store.grantCredential(deviceId, completedAt);
        return json(response, 201, { deviceId, zoneId: challenge.zoneId, ...credential });
      }
      const participant = this.store.authenticateCredential(request.headers.authorization, now);
      if (!participant) throw new ApiError(401, "Participant credential required");
      if (request.method === "GET" && url.pathname === "/api/mobile/inbox") {
        for (const key of url.searchParams.keys()) if (!["cursor", "limit"].includes(key) || url.searchParams.getAll(key).length > 1) throw new ApiError(400, "Invalid inbox query");
        const cursor = Number(url.searchParams.get("cursor") ?? 0); const limit = Number(url.searchParams.get("limit") ?? 50);
        return json(response, 200, this.store.inbox(participant.device_id, cursor, limit, now));
      }
      if (request.method === "GET" && url.pathname === "/api/mobile/notices") {
        for (const key of url.searchParams.keys()) if (!["cursor", "limit"].includes(key) || url.searchParams.getAll(key).length > 1) throw new ApiError(400, "Invalid notice query");
        return json(response, 200, this.notices.inbox(participant.device_id, Number(url.searchParams.get("cursor") ?? 0), Number(url.searchParams.get("limit") ?? 50), now));
      }
      if (request.method === "POST" && url.pathname === "/api/mobile/receipts") {
        const input = fields(await body(request), ["report"]);
        const receivedAt = Date.now();
        if (!this.store.authenticateCredential(request.headers.authorization, receivedAt)) throw new ApiError(401, "Participant credential expired");
        const report = input.report as EmergencyReport;
        const status = report?.eventType === NOTICE_RECEIPT_EVENT ? this.notices.acceptReceipt(report, participant.device_id, receivedAt) : this.store.acceptReceipt(report, participant.device_id, receivedAt);
        return json(response, 202, { status });
      }
      throw new ApiError(404, "Not found");
    } catch (error) {
      request.resume();
      const message = error instanceof Error ? error.message : "Invalid request";
      const status = error instanceof ApiError ? error.status : /rate limited|capacity exceeded/.test(message) ? 429 : /not authorized|unauthorized/.test(message) ? 403 : 400;
      // Do not expose database diagnostics, configuration values or submitted credentials.
      json(response, status, { error: error instanceof ApiError ? message : status === 429 ? "Request rate or capacity limit exceeded" : status === 403 ? "Access denied" : "Request validation failed" }, status === 429 ? { "retry-after": "60" } : {});
    }
  }

  acceptPacket(envelope: EmergencyEnvelope, now = Date.now()) {
    const result = this.store.acceptResponse(envelope, now);
    return { ...result, evidence: createBackendAcknowledgement("coluvi-backend", envelope, now, result.status === "DUPLICATE") };
  }
  close(): void { this.notices.close(); this.store.close(); }
}
