import { randomUUID } from "node:crypto";
import { createDeviceIdentity, signReport, type DeviceIdentity } from "../protocol/identity.ts";
import { PROTOCOL_VERSION, type EmergencyReport, type EventType, type ReportMode } from "../protocol/types.ts";

export function makeReport(options: {
  identity?: DeviceIdentity;
  eventId?: string;
  eventType?: EventType;
  reportMode?: ReportMode;
  createdAt?: number;
  relatedEventId?: string;
  subjectId?: string;
  priority?: EmergencyReport["priority"];
} = {}): EmergencyReport {
  const identity = options.identity ?? createDeviceIdentity();
  const createdAt = options.createdAt ?? Date.now();
  const reportMode = options.reportMode ?? "SELF";
  const eventType = options.eventType ?? "SOS";
  const report: EmergencyReport = {
    protocolVersion: PROTOCOL_VERSION,
    eventId: options.eventId ?? randomUUID(),
    eventType,
    reportMode,
    priority: options.priority ?? (eventType === "SOS" ? "CRITICAL" : "NORMAL"),
    createdAt,
    observedAt: createdAt,
    validUntil: createdAt + 24 * 60 * 60_000,
    location: { latitude: 19.4326, longitude: -99.1332, accuracyMeters: 80, timestamp: createdAt, source: "APPROXIMATE" },
    peopleAffected: 1,
    needs: eventType === "SOS" ? [{ category: "MEDICAL_CARE" }] : undefined,
    shortMessage: eventType === "PERSON_LAST_SEEN" ? "Vista cerca del refugio" : "Reporte de demostración",
    anonymousDeviceId: identity.anonymousDeviceId,
    subject: reportMode === "SELF" ? undefined : { pseudonymousId: options.subjectId ?? "subject-demo" },
    relatedEventId: options.relatedEventId,
    nonce: randomUUID(),
    trustMetadata: { level: "UNASSESSED", corroborationCount: 0 },
  };
  return signReport(report, identity);
}
