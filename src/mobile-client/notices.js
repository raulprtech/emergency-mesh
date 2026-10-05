import { verifyColuviDomain, signColuviBrowserReport } from "./commands.js";

export const NOTICE_EVENT = "x-coluvi-operational-notice";
export const NOTICE_RECEIPT_EVENT = "x-coluvi-notice-receipt";
export const MAX_NOTICE_MS = 24 * 60 * 60_000;
export const NOTICE_LEVELS = Object.freeze(["INFORMATION", "WARNING"]);
export function validAuthorityKinds(kinds) {
  return Array.isArray(kinds) && kinds.length >= 1 && kinds.length <= 2 && new Set(kinds).size === kinds.length
    && kinds.every(kind => ["CHECKIN_REQUEST", "OPERATIONAL_NOTICE"].includes(kind));
}
const token = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
export const validNoticeText = (value, bytes) => typeof value === "string" && value.trim().length > 0 && new TextEncoder().encode(value).length <= bytes && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
const domainSignature = value => typeof value === "string" && /^[A-Za-z0-9_-]{86}$/.test(value);

/** Operational notices are private, explicitly simulated and independently authorized by kind. */
export function noticeErrors(report) {
  const notice = report?.extensions?.coluvi;
  if (!exact(notice, ["version", "kind", "noticeId", "incidentRef", "issuerId", "zoneId", "issuedAt", "expiresAt", "sourceLabel", "title", "message", "level", "simulation", "nonce", "domainSignature"])) return ["invalid notice fields"];
  const errors = [];
  if (!exact(report, ["protocolVersion", "eventId", "incidentRef", "eventType", "reportMode", "priority", "createdAt", "observedAt", "validUntil", "anonymousDeviceId", "nonce", "location", "extensions", "signature"])
    || !exact(report.extensions, ["coluvi"])) errors.push("invalid notice report fields");
  if (notice.version !== 1 || notice.kind !== "OPERATIONAL_NOTICE" || notice.simulation !== true || !NOTICE_LEVELS.includes(notice.level)) errors.push("invalid notice kind or simulation status");
  for (const field of ["noticeId", "incidentRef", "issuerId", "zoneId", "nonce"]) if (!token(notice[field])) errors.push(`invalid ${field}`);
  if (![notice.issuedAt, notice.expiresAt].every(time) || notice.expiresAt - notice.issuedAt < 1_000 || notice.expiresAt - notice.issuedAt > MAX_NOTICE_MS) errors.push("invalid notice validity");
  if (!validNoticeText(notice.sourceLabel, 120) || !validNoticeText(notice.title, 160) || !validNoticeText(notice.message, 1_200)) errors.push("invalid notice text");
  if (!domainSignature(notice.domainSignature)) errors.push("invalid domain signature");
  if (report.protocolVersion !== "0.1" || report.eventType !== NOTICE_EVENT || report.reportMode !== "SELF" || report.priority !== "NORMAL"
    || report.eventId !== notice.noticeId || report.incidentRef !== notice.incidentRef || report.anonymousDeviceId !== notice.issuerId
    || report.createdAt !== notice.issuedAt || report.observedAt !== notice.issuedAt || report.validUntil !== notice.expiresAt || report.nonce !== notice.nonce) errors.push("notice report binding mismatch");
  if (!exact(report.location, ["source", "zoneId", "timestamp"]) || report.location.source !== "ZONE" || report.location.zoneId !== notice.zoneId || report.location.timestamp !== notice.issuedAt) errors.push("invalid notice zone");
  return errors;
}

export async function verifyNoticeForDevice(report, trust, zoneId, now = Date.now()) {
  try {
    if (noticeErrors(report).length || !time(now)) return false;
    const notice = report.extensions.coluvi;
    const authority = trust?.find(item => item.issuerId === notice.issuerId && item.publicKey === report.signature?.publicKey);
    if (!authority || authority.revoked || !authority.kinds?.includes("OPERATIONAL_NOTICE") || !authority.zones?.includes(zoneId)
      || notice.zoneId !== zoneId || notice.issuedAt > now || notice.expiresAt <= now) return false;
    return await verifyColuviDomain(report);
  } catch { return false; }
}

export function noticeReceiptErrors(report, noticeReport) {
  if (noticeErrors(noticeReport).length) return ["invalid referenced notice"];
  const notice = noticeReport.extensions.coluvi; const receipt = report?.extensions?.coluvi;
  if (!exact(receipt, ["version", "kind", "noticeId", "zoneId", "evidence", "domainSignature"])) return ["invalid notice receipt fields"];
  const errors = [];
  if (!exact(report, ["protocolVersion", "eventId", "incidentRef", "eventType", "reportMode", "priority", "createdAt", "observedAt", "validUntil", "anonymousDeviceId", "nonce", "relatedEventId", "extensions", "signature"])
    || !exact(report.extensions, ["coluvi"])) errors.push("invalid notice receipt report fields");
  if (receipt.version !== 1 || receipt.kind !== "NOTICE_RECEIPT" || !["RECEIVED", "SHOWN"].includes(receipt.evidence) || !domainSignature(receipt.domainSignature)) errors.push("invalid notice receipt evidence");
  if (report.protocolVersion !== "0.1" || report.eventType !== NOTICE_RECEIPT_EVENT || report.reportMode !== "SELF" || report.priority !== "LOW"
    || !token(report.eventId) || !token(report.anonymousDeviceId) || !token(report.nonce)) errors.push("invalid notice receipt report");
  if (receipt.noticeId !== notice.noticeId || receipt.zoneId !== notice.zoneId || report.relatedEventId !== notice.noticeId || report.incidentRef !== notice.incidentRef) errors.push("notice receipt binding mismatch");
  if (![report.createdAt, report.observedAt, report.validUntil].every(time) || report.createdAt < notice.issuedAt || report.observedAt < notice.issuedAt
    || report.observedAt > report.createdAt || report.createdAt >= notice.expiresAt || report.validUntil !== notice.expiresAt) errors.push("invalid notice receipt validity");
  return errors;
}

export async function createNoticeReceipt(noticeReport, evidence, identity, now = Date.now()) {
  if (noticeErrors(noticeReport).length) throw new Error("Invalid notice");
  const notice = noticeReport.extensions.coluvi;
  const report = await signColuviBrowserReport({
    protocolVersion: "0.1", eventId: crypto.randomUUID(), incidentRef: notice.incidentRef,
    eventType: NOTICE_RECEIPT_EVENT, reportMode: "SELF", priority: "LOW", createdAt: now, observedAt: now,
    validUntil: notice.expiresAt, anonymousDeviceId: identity.anonymousDeviceId, nonce: crypto.randomUUID(), relatedEventId: notice.noticeId,
    extensions: { coluvi: { version: 1, kind: "NOTICE_RECEIPT", noticeId: notice.noticeId, zoneId: notice.zoneId, evidence } },
  }, identity);
  if (noticeReceiptErrors(report, noticeReport).length) throw new Error("Invalid or expired notice receipt");
  return report;
}
