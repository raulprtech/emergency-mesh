import { createHash, sign, verify } from "node:crypto";
import { signReport, verifyReportSignature, type DeviceIdentity } from "../protocol/identity.ts";
import type { EmergencyReport } from "../protocol/types.ts";
import { COMMAND_EVENT, commandErrors, coluviSigningBytes } from "../mobile-client/commands.js";

export interface ColuviAuthority {
  issuerId: string;
  publicKey: string;
  zones: string[];
  kinds: string[];
  revoked?: boolean;
}

export function authorityFor(identity: DeviceIdentity, zones: string[]): ColuviAuthority {
  return { issuerId: identity.anonymousDeviceId, publicKey: identity.publicKey.export({ type: "spki", format: "der" }).toString("base64url"), zones: [...zones], kinds: ["CHECKIN_REQUEST"] };
}

export function authorityFingerprint(authority: ColuviAuthority): string {
  return createHash("sha256").update(Buffer.from(authority.publicKey, "base64url")).digest("hex");
}

export function signColuviReport(report: EmergencyReport, identity: DeviceIdentity): EmergencyReport {
  const payload = report.extensions?.coluvi as Record<string, unknown>;
  const domainSignature = sign(null, coluviSigningBytes(payload), identity.privateKey).toString("base64url");
  return signReport({ ...report, extensions: { coluvi: { ...payload, domainSignature } } }, identity);
}

export function verifyColuviReport(report: EmergencyReport): boolean {
  try {
    if (!verifyReportSignature(report)) return false;
    const payload = report.extensions?.coluvi as Record<string, unknown>;
    return verify(null, coluviSigningBytes(payload), { key: Buffer.from(report.signature!.publicKey, "base64url"), type: "spki", format: "der" }, Buffer.from(payload.domainSignature as string, "base64url"));
  } catch { return false; }
}

export function verifyAuthorizedCommand(report: EmergencyReport, authorities: ColuviAuthority[], now = Date.now(), allowExpired = false): boolean {
  try {
    if (commandErrors(report).length) return false;
    const command = report.extensions!.coluvi as { issuerId: string; zoneId: string; kind: string; issuedAt: number; promptUntil: number; responseUntil: number };
    const authority = authorities.find((item) => item.issuerId === command.issuerId && item.publicKey === report.signature?.publicKey);
    return Boolean(authority && !authority.revoked && authority.zones.includes(command.zoneId) && authority.kinds.includes(command.kind)
      && command.issuedAt <= now && (allowExpired ? command.responseUntil > now : command.promptUntil > now) && verifyColuviReport(report));
  } catch { return false; }
}

export function createCheckinCommand(identity: DeviceIdentity, authority: ColuviAuthority, input: {
  commandId: string; incidentRef: string; zoneId: string; nonce: string; issuedAt: number; promptUntil: number; responseUntil: number;
}): EmergencyReport {
  const report = signColuviReport({
    protocolVersion: "0.1", eventId: input.commandId, incidentRef: input.incidentRef, eventType: COMMAND_EVENT,
    reportMode: "SELF", priority: "NORMAL", createdAt: input.issuedAt, observedAt: input.issuedAt, validUntil: input.responseUntil,
    anonymousDeviceId: identity.anonymousDeviceId, nonce: input.nonce,
    location: { source: "ZONE", zoneId: input.zoneId, timestamp: input.issuedAt },
    extensions: { coluvi: { version: 1, kind: "CHECKIN_REQUEST", ...input, issuerId: identity.anonymousDeviceId } },
  }, identity);
  if (!verifyAuthorizedCommand(report, [authority], input.issuedAt)) throw new Error("Invalid or unauthorized check-in command");
  return report;
}
