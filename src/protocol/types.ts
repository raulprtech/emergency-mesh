import { validateProtectedPayloadFormat } from "./protected-payload.ts";

export const PROTOCOL_VERSION = "0.1" as const;

export const EVENT_TYPES = [
  "SAFE",
  "RESOURCE_REQUEST",
  "ASSISTANCE_REQUEST",
  "SOS",
  "RESOURCE_AVAILABLE",
  "AREA_STATUS",
  "PERSON_LAST_SEEN",
  "PERSON_FOUND",
] as const;
export type EventType = (typeof EVENT_TYPES)[number] | `x-${string}`;

export const REPORT_MODES = ["SELF", "THIRD_PARTY", "LAST_SEEN"] as const;
export type ReportMode = (typeof REPORT_MODES)[number];

export const PRIORITIES = ["CRITICAL", "HIGH", "NORMAL", "LOW"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const NEED_CATEGORIES = [
  "WATER",
  "FOOD",
  "MEDICATION",
  "MEDICAL_CARE",
  "EXTRACTION",
  "SHELTER",
  "ENERGY",
  "TRANSPORT",
  "COMMUNICATION",
] as const;
export type NeedCategory = (typeof NEED_CATEGORIES)[number] | `x-${string}`;

export type LocationSource =
  | "GPS_CURRENT"
  | "LAST_KNOWN"
  | "MANUAL"
  | "APPROXIMATE"
  | "ZONE"
  | "OTHER_DEVICE";

export interface Location {
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  timestamp: number;
  source: LocationSource;
  zoneId?: string;
}

export interface Need {
  category: NeedCategory;
  quantity?: number;
  unit?: string;
  note?: string;
}

export interface Subject {
  pseudonymousId?: string;
  name?: string;
  description?: string;
  ageRange?: string;
  distinguishingFeatures?: string;
}

export interface TrustMetadata {
  level?: "UNASSESSED" | "CORROBORATED" | "DISPUTED";
  corroborationCount?: number;
  extensions?: Record<string, unknown>;
}

export interface Signature {
  algorithm: "Ed25519";
  publicKey: string;
  value: string;
}

/** Immutable semantic report. The signature covers this object without signature. */
export interface EmergencyReport {
  protocolVersion: typeof PROTOCOL_VERSION | string;
  eventId: string;
  incidentRef?: string;
  eventType: EventType;
  reportMode: ReportMode;
  priority: Priority;
  createdAt: number;
  observedAt: number;
  validUntil: number;
  location?: Location;
  peopleAffected?: number;
  needs?: Need[];
  shortMessage?: string;
  anonymousDeviceId: string;
  subject?: Subject;
  relatedEventId?: string;
  nonce: string;
  publicPayload?: Record<string, unknown>;
  protectedPayload?: string;
  identityMetadata?: Record<string, unknown>;
  trustMetadata?: TrustMetadata;
  signature?: Signature;
  extensions?: Record<string, unknown>;
}

export interface TransportHop {
  transportId: string;
  forwardedAt: number;
  nodeId?: string;
}

/** Mutable delivery envelope; deliberately excluded from the report signature. */
export interface EmergencyEnvelope {
  packetId: string;
  report: EmergencyReport;
  expiresAt: number;
  hopCount: number;
  hopLimit: number;
  lastForwardedAt?: number;
  transportHistory?: TransportHop[];
}

export type DeliveryState =
  | "CREATED"
  | "QUEUED"
  | "FORWARDED"
  | "GATEWAY_FOUND"
  | "SYNCED"
  | "EXPIRED";

export function isExpired(envelope: EmergencyEnvelope, now = Date.now()): boolean {
  return envelope.expiresAt <= now;
}

export function canForward(envelope: EmergencyEnvelope, now = Date.now()): boolean {
  return !isExpired(envelope, now) && envelope.hopCount < envelope.hopLimit;
}

export function validateReport(report: EmergencyReport): string[] {
  const errors: string[] = [];
  if (!report.protocolVersion) errors.push("protocolVersion is required");
  if (!report.eventId) errors.push("eventId is required");
  if (!/^0\.1(?:\.\d+)?$/.test(report.protocolVersion)) errors.push("unsupported protocolVersion");
  if (report.validUntil <= report.createdAt) errors.push("validUntil must follow createdAt");
  if (!EVENT_TYPES.includes(report.eventType as (typeof EVENT_TYPES)[number]) && !report.eventType.startsWith("x-")) {
    errors.push("eventType must be registered or use the x- extension prefix");
  }
  if (!REPORT_MODES.includes(report.reportMode)) errors.push("invalid reportMode");
  if (!PRIORITIES.includes(report.priority)) errors.push("invalid priority");
  if (report.observedAt > report.createdAt + 5 * 60_000) errors.push("observedAt is implausibly after createdAt");
  if (report.shortMessage && Buffer.byteLength(report.shortMessage, "utf8") > 280) errors.push("shortMessage exceeds 280 UTF-8 bytes");
  if (report.protectedPayload) errors.push(...validateProtectedPayloadFormat(report.protectedPayload));
  if ((report.reportMode === "THIRD_PARTY" || report.reportMode === "LAST_SEEN") && !report.subject) {
    errors.push("subject is required for THIRD_PARTY and LAST_SEEN");
  }
  if (report.eventType === "PERSON_FOUND" && !report.relatedEventId && !report.subject?.pseudonymousId) {
    errors.push("PERSON_FOUND must reference an event or pseudonymous subject");
  }
  return errors;
}

export function validateEnvelope(envelope: EmergencyEnvelope): string[] {
  const errors = validateReport(envelope.report);
  if (!envelope.packetId) errors.push("packetId is required");
  if (envelope.expiresAt <= envelope.report.createdAt) errors.push("expiresAt must follow createdAt");
  if (envelope.expiresAt > envelope.report.validUntil) errors.push("expiresAt cannot exceed signed validUntil");
  if (!Number.isInteger(envelope.hopCount) || envelope.hopCount < 0) errors.push("hopCount must be a non-negative integer");
  if (!Number.isInteger(envelope.hopLimit) || envelope.hopLimit < 1) errors.push("hopLimit must be a positive integer");
  return errors;
}
