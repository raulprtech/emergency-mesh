import { verifyReportSignature } from "../protocol/identity.ts";
import { aggregateReports, INTERNAL_AGGREGATION_POLICY, PUBLIC_AGGREGATION_POLICY, type AggregationPolicy, type AggregationResult } from "./aggregation.ts";
export type { AreaAggregate, AggregationPolicy, AggregationResult } from "./aggregation.ts";
import { isExpired, validateEnvelope, type EmergencyEnvelope, type EmergencyReport } from "../protocol/types.ts";

export interface IngestResult {
  status: "ACCEPTED" | "DUPLICATE" | "EXPIRED" | "INVALID";
  eventId: string;
  signatureValid: boolean;
  errors?: string[];
}

export interface EmergencyBackend {
  ingest(envelope: EmergencyEnvelope, now?: number): IngestResult;
}

export class ReferenceBackend implements EmergencyBackend {
  private readonly events = new Map<string, EmergencyReport>();
  private readonly arrivals = new Map<string, number>();

  ingest(envelope: EmergencyEnvelope, now = Date.now()): IngestResult {
    const errors = validateEnvelope(envelope);
    if (errors.length) return { status: "INVALID", eventId: envelope.report.eventId, signatureValid: false, errors };
    if (isExpired(envelope, now)) return { status: "EXPIRED", eventId: envelope.report.eventId, signatureValid: false };
    const signatureValid = verifyReportSignature(envelope.report);
    if (this.events.has(envelope.report.eventId)) {
      this.arrivals.set(envelope.report.eventId, (this.arrivals.get(envelope.report.eventId) ?? 1) + 1);
      return { status: "DUPLICATE", eventId: envelope.report.eventId, signatureValid };
    }
    this.events.set(envelope.report.eventId, structuredClone(envelope.report));
    this.arrivals.set(envelope.report.eventId, 1);
    return { status: "ACCEPTED", eventId: envelope.report.eventId, signatureValid };
  }

  get(eventId: string): EmergencyReport | undefined {
    const report = this.events.get(eventId);
    return report ? structuredClone(report) : undefined;
  }
  list(): EmergencyReport[] { return [...this.events.values()].map((report) => structuredClone(report)); }
  arrivalCount(eventId: string): number { return this.arrivals.get(eventId) ?? 0; }
  size(): number { return this.events.size; }

  activePersonCases(): EmergencyReport[] {
    const foundRefs = new Set(this.list().filter((item) => item.eventType === "PERSON_FOUND").map((item) => item.relatedEventId).filter(Boolean));
    return this.list().filter((item) => item.eventType === "PERSON_LAST_SEEN" && !foundRefs.has(item.eventId));
  }

  aggregate(policy: AggregationPolicy = INTERNAL_AGGREGATION_POLICY, now = Date.now()) {
    return aggregateReports(this.events.values(), policy, now).areas;
  }
  publicAggregate(policy: AggregationPolicy = PUBLIC_AGGREGATION_POLICY, now = Date.now()): AggregationResult {
    return aggregateReports(this.events.values(), policy, now);
  }
}
