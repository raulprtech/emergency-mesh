import { canonicalCbor, verifyBrowserReport, signBrowserReport } from "./crypto.js";

export const COLUVI_VERSION = 1;
export const COMMAND_EVENT = "x-coluvi-checkin-request";
export const RESPONSE_EVENT = "x-coluvi-checkin-response";
export const RECEIPT_EVENT = "x-coluvi-checkin-receipt";
export const MAX_PROMPT_MS = 24 * 60 * 60_000;
export const MAX_LATE_MS = 24 * 60 * 60_000;
const token = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const time = (value) => Number.isSafeInteger(value) && value >= 0;
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => fields.includes(key)) && fields.every((key) => Object.hasOwn(value, key));
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromBase64 = (value) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** Domain separation prevents reusing an unrelated Ed25519 signature as an instruction. */
export function coluviSigningBytes(payload) {
  const { domainSignature: _signature, ...unsigned } = payload;
  return canonicalCbor({ domain: `COLUVI/${unsigned.kind}/v1`, payload: unsigned });
}

export function commandErrors(report) {
  const errors = [];
  const command = report?.extensions?.coluvi;
  if (!exact(command, ["version", "kind", "commandId", "incidentRef", "issuerId", "zoneId", "issuedAt", "promptUntil", "responseUntil", "nonce", "domainSignature"])) return ["invalid command fields"];
  if (!exact(report, ["protocolVersion", "eventId", "incidentRef", "eventType", "reportMode", "priority", "createdAt", "observedAt", "validUntil", "anonymousDeviceId", "nonce", "location", "extensions", "signature"])
    || !exact(report.extensions, ["coluvi"])) errors.push("invalid command report fields");
  if (command.version !== 1 || command.kind !== "CHECKIN_REQUEST") errors.push("unsupported command version or kind");
  for (const key of ["commandId", "incidentRef", "issuerId", "zoneId", "nonce"]) if (!token(command[key])) errors.push(`invalid ${key}`);
  if (![command.issuedAt, command.promptUntil, command.responseUntil].every(time)
    || command.promptUntil <= command.issuedAt || command.promptUntil - command.issuedAt > MAX_PROMPT_MS
    || command.responseUntil < command.promptUntil || command.responseUntil - command.promptUntil > MAX_LATE_MS) errors.push("invalid command validity");
  if (typeof command.domainSignature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(command.domainSignature)) errors.push("invalid domain signature");
  if (report.protocolVersion !== "0.1" || report.eventType !== COMMAND_EVENT || report.reportMode !== "SELF" || report.priority !== "NORMAL"
    || report.eventId !== command.commandId || report.incidentRef !== command.incidentRef || report.anonymousDeviceId !== command.issuerId
    || report.createdAt !== command.issuedAt || report.observedAt !== command.issuedAt || report.validUntil !== command.responseUntil
    || report.nonce !== command.nonce) errors.push("command report binding mismatch");
  if (!exact(report.location, ["source", "zoneId", "timestamp"]) || report.location.source !== "ZONE"
    || report.location.zoneId !== command.zoneId || report.location.timestamp !== command.issuedAt) errors.push("invalid command zone");
  if (report.peopleAffected !== undefined || report.needs !== undefined || report.subject !== undefined || report.protectedPayload !== undefined) errors.push("command must not contain personal data");
  return errors;
}

export function responseErrors(report, commandReport) {
  const response = report?.extensions?.coluvi;
  const command = commandReport?.extensions?.coluvi;
  if (commandErrors(commandReport).length) return ["invalid referenced command"];
  if (!exact(response, ["version", "kind", "commandId", "zoneId", "status", "domainSignature"])) return ["invalid response fields"];
  const errors = [];
  if (!exact(report, ["protocolVersion", "eventId", "incidentRef", "eventType", "reportMode", "priority", "createdAt", "observedAt", "validUntil", "anonymousDeviceId", "nonce", "relatedEventId", "extensions", "signature"])
    || !exact(report.extensions, ["coluvi"])) errors.push("invalid response report fields");
  if (response.version !== 1 || response.kind !== "CHECKIN_RESPONSE" || !["SAFE", "NEEDS_HELP"].includes(response.status)) errors.push("invalid response state");
  if (response.commandId !== command.commandId || response.zoneId !== command.zoneId || report.relatedEventId !== command.commandId
    || report.incidentRef !== command.incidentRef) errors.push("response command binding mismatch");
  if (report.protocolVersion !== "0.1" || report.eventType !== RESPONSE_EVENT || report.reportMode !== "SELF"
    || report.priority !== (response.status === "SAFE" ? "NORMAL" : "HIGH")
    || !token(report.eventId) || !token(report.nonce) || !token(report.anonymousDeviceId)) errors.push("invalid response report");
  if (![report.createdAt, report.observedAt, report.validUntil].every(time)
    || report.createdAt < command.issuedAt || report.observedAt < command.issuedAt || report.observedAt >= command.promptUntil
    || report.observedAt > report.createdAt || report.createdAt >= command.responseUntil || report.validUntil !== command.responseUntil) errors.push("invalid response validity");
  if (report.location !== undefined || report.peopleAffected !== undefined || report.subject !== undefined || report.needs !== undefined
    || report.shortMessage !== undefined || report.protectedPayload !== undefined) errors.push("minimal response must not contain personal data");
  if (typeof response.domainSignature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(response.domainSignature)) errors.push("invalid domain signature");
  return errors;
}

export async function verifyColuviDomain(report, webCrypto = globalThis.crypto) {
  try {
    if (!await verifyBrowserReport(report, webCrypto)) return false;
    const key = await webCrypto.subtle.importKey("spki", fromBase64(report.signature.publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await webCrypto.subtle.verify("Ed25519", key, fromBase64(report.extensions.coluvi.domainSignature), coluviSigningBytes(report.extensions.coluvi));
  } catch { return false; }
}

/** Trust must be provisioned outside this inbox; a server-supplied issuer is not trust. */
export async function verifyCommandForDevice(report, trust, zoneId, now = Date.now(), allowExpired = false) {
  try {
    if (commandErrors(report).length || !time(now)) return false;
    const command = report.extensions.coluvi;
    const authority = trust?.find((item) => item.issuerId === command.issuerId && item.publicKey === report.signature?.publicKey);
    if (!authority || authority.revoked || !authority.zones?.includes(zoneId) || command.zoneId !== zoneId
      || !authority.kinds?.includes(command.kind) || command.issuedAt > now
      || (allowExpired ? command.responseUntil <= now : command.promptUntil <= now)) return false;
    return await verifyColuviDomain(report);
  } catch { return false; }
}

export async function signColuviBrowserReport(report, identity, webCrypto = globalThis.crypto) {
  if (identity.mode !== "ED25519") throw new Error("Check-in requires an enrolled signing identity");
  const key = await webCrypto.subtle.importKey("jwk", identity.privateKeyJwk, { name: "Ed25519" }, false, ["sign"]);
  const domainSignature = toBase64(new Uint8Array(await webCrypto.subtle.sign("Ed25519", key, coluviSigningBytes(report.extensions.coluvi))));
  return signBrowserReport({ ...report, extensions: { coluvi: { ...report.extensions.coluvi, domainSignature } } }, identity, webCrypto);
}

export async function createCheckinResponse(commandReport, status, identity, now = Date.now()) {
  const command = commandReport?.extensions?.coluvi;
  if (commandErrors(commandReport).length || !["SAFE", "NEEDS_HELP"].includes(status)
    || !time(now) || now < command.issuedAt || now >= command.promptUntil) throw new Error("Check-in is invalid or no longer open");
  const report = await signColuviBrowserReport({
    protocolVersion: "0.1", eventId: globalThis.crypto.randomUUID(), incidentRef: command.incidentRef,
    eventType: RESPONSE_EVENT, reportMode: "SELF", priority: status === "SAFE" ? "NORMAL" : "HIGH",
    createdAt: now, observedAt: now, validUntil: command.responseUntil, anonymousDeviceId: identity.anonymousDeviceId,
    relatedEventId: command.commandId, nonce: globalThis.crypto.randomUUID(),
    extensions: { coluvi: { version: 1, kind: "CHECKIN_RESPONSE", commandId: command.commandId, zoneId: command.zoneId, status } },
  }, identity);
  return {
    eventId: report.eventId, envelope: { packetId: globalThis.crypto.randomUUID(), report, expiresAt: report.validUntil, hopCount: 0, hopLimit: 12, transportHistory: [] },
    state: "QUEUED", createdAt: now, updatedAt: now, attempts: 0,
    history: [{ state: "CREATED", at: now }, { state: "QUEUED", at: now }], evidence: [],
  };
}

export function receiptErrors(report, commandReport) {
  if (commandErrors(commandReport).length) return ["invalid referenced command"];
  const receipt = report?.extensions?.coluvi;
  const command = commandReport.extensions.coluvi;
  if (!exact(receipt, ["version", "kind", "commandId", "zoneId", "evidence", "domainSignature"])) return ["invalid receipt fields"];
  const errors = [];
  if (!exact(report, ["protocolVersion", "eventId", "incidentRef", "eventType", "reportMode", "priority", "createdAt", "observedAt", "validUntil", "anonymousDeviceId", "nonce", "relatedEventId", "extensions", "signature"])
    || !exact(report.extensions, ["coluvi"])) errors.push("invalid receipt report fields");
  if (receipt.version !== 1 || receipt.kind !== "CHECKIN_RECEIPT" || !["RECEIVED", "SHOWN"].includes(receipt.evidence)) errors.push("invalid receipt evidence");
  if (report.protocolVersion !== "0.1" || report.eventType !== RECEIPT_EVENT || report.reportMode !== "SELF" || report.priority !== "LOW"
    || !token(report.eventId) || !token(report.anonymousDeviceId) || !token(report.nonce)) errors.push("invalid receipt report");
  if (receipt.commandId !== command.commandId || receipt.zoneId !== command.zoneId || report.relatedEventId !== command.commandId || report.incidentRef !== command.incidentRef) errors.push("receipt command binding mismatch");
  if (![report.createdAt, report.observedAt, report.validUntil].every(time) || report.createdAt < command.issuedAt
    || report.observedAt < command.issuedAt || report.observedAt > report.createdAt || report.createdAt >= command.responseUntil
    || report.validUntil !== command.responseUntil || (receipt.evidence === "SHOWN" && report.observedAt >= command.promptUntil)) errors.push("invalid receipt validity");
  if (typeof receipt.domainSignature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(receipt.domainSignature)) errors.push("invalid domain signature");
  return errors;
}

export async function createCheckinReceipt(commandReport, evidence, identity, now = Date.now()) {
  if (commandErrors(commandReport).length) throw new Error("Invalid command");
  const command = commandReport.extensions.coluvi;
  const report = await signColuviBrowserReport({
    protocolVersion: "0.1", eventId: globalThis.crypto.randomUUID(), incidentRef: command.incidentRef,
    eventType: RECEIPT_EVENT, reportMode: "SELF", priority: "LOW", createdAt: now, observedAt: now,
    validUntil: command.responseUntil, anonymousDeviceId: identity.anonymousDeviceId,
    relatedEventId: command.commandId, nonce: globalThis.crypto.randomUUID(),
    extensions: { coluvi: { version: 1, kind: "CHECKIN_RECEIPT", commandId: command.commandId, zoneId: command.zoneId, evidence } },
  }, identity);
  if (receiptErrors(report, commandReport).length) throw new Error("Receipt is invalid or expired");
  return report;
}
