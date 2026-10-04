import type { DeviceIdentity } from "../protocol/identity.ts";
import type { EmergencyReport } from "../protocol/types.ts";
import { noticeErrors, NOTICE_EVENT } from "../mobile-client/notices.js";
import { signColuviReport, verifyColuviReport, type ColuviAuthority } from "./authority.ts";

export interface NoticePayload {
  version: 1; kind: "OPERATIONAL_NOTICE"; simulation: true;
  noticeId: string; incidentRef: string; issuerId: string; zoneId: string; issuedAt: number; expiresAt: number;
  sourceLabel: string; title: string; message: string; level: "INFORMATION" | "WARNING"; nonce: string;
}

export function verifyAuthorizedNotice(report: EmergencyReport, authorities: ColuviAuthority[], now = Date.now()): boolean {
  try {
    if (noticeErrors(report).length || !Number.isSafeInteger(now) || now < 0) return false;
    const notice = report.extensions!.coluvi as NoticePayload;
    const authority = authorities.find(item => item.issuerId === notice.issuerId && item.publicKey === report.signature?.publicKey);
    return Boolean(authority && !authority.revoked && authority.kinds.includes(notice.kind) && authority.zones.includes(notice.zoneId)
      && notice.issuedAt <= now && notice.expiresAt > now && verifyColuviReport(report));
  } catch { return false; }
}

export function createOperationalNotice(identity: DeviceIdentity, authority: ColuviAuthority, input: Omit<NoticePayload, "version" | "kind" | "simulation" | "issuerId">): EmergencyReport {
  const notice: NoticePayload = { ...input, version: 1, kind: "OPERATIONAL_NOTICE", simulation: true, issuerId: identity.anonymousDeviceId };
  const report = signColuviReport({
    protocolVersion: "0.1", eventId: input.noticeId, incidentRef: input.incidentRef, eventType: NOTICE_EVENT, reportMode: "SELF", priority: "NORMAL",
    createdAt: input.issuedAt, observedAt: input.issuedAt, validUntil: input.expiresAt, nonce: input.nonce, anonymousDeviceId: identity.anonymousDeviceId,
    location: { source: "ZONE", zoneId: input.zoneId, timestamp: input.issuedAt }, extensions: { coluvi: notice },
  }, identity);
  if (!verifyAuthorizedNotice(report, [authority], input.issuedAt)) throw new Error("Invalid or unauthorized operational notice");
  return report;
}
