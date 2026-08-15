import type { DeliveryAcknowledgement, EgressAdvertisement, EgressState } from "./transport.ts";

export interface EgressFreshnessPolicy {
  reportedTtlMs: number;
  confirmedTtlMs: number;
}

export const DEFAULT_EGRESS_FRESHNESS: EgressFreshnessPolicy = {
  reportedTtlMs: 30_000,
  confirmedTtlMs: 2 * 60_000,
};

export class EgressTracker {
  private lastReportedAt?: number;
  private lastConfirmedAt?: number;
  private lastAcknowledgement?: DeliveryAcknowledgement;
  private reportedQuality = 0;
  private connected = false;
  private readonly supportedTransports: string[];
  private readonly policy: EgressFreshnessPolicy;

  constructor(supportedTransports: string[], policy: EgressFreshnessPolicy = DEFAULT_EGRESS_FRESHNESS) {
    this.supportedTransports = [...supportedTransports];
    this.policy = policy;
  }

  report(quality: number, now = Date.now()): void {
    this.connected = true;
    this.lastReportedAt = now;
    this.reportedQuality = Math.max(0, Math.min(1, quality));
  }

  disconnect(): void { this.connected = false; }

  confirm(acknowledgement: DeliveryAcknowledgement): boolean {
    if (acknowledgement.level !== "GATEWAY" && acknowledgement.level !== "BACKEND") return false;
    this.connected = true;
    this.lastConfirmedAt = acknowledgement.acknowledgedAt;
    this.lastAcknowledgement = structuredClone(acknowledgement);
    return true;
  }

  advertisement(now = Date.now()): EgressAdvertisement {
    let state: EgressState = "UNKNOWN";
    if (this.lastConfirmedAt !== undefined && this.connected && now - this.lastConfirmedAt <= this.policy.confirmedTtlMs) state = "CONFIRMED";
    else if (this.lastReportedAt !== undefined && this.connected && now - this.lastReportedAt <= this.policy.reportedTtlMs) state = "REPORTED";
    else if (this.lastReportedAt !== undefined || this.lastConfirmedAt !== undefined) state = "STALE";
    const quality = state === "CONFIRMED" ? Math.max(0.8, this.reportedQuality) : state === "REPORTED" ? this.reportedQuality * 0.6 : 0;
    return {
      state,
      quality,
      lastReportedAt: this.lastReportedAt,
      lastConfirmedAt: this.lastConfirmedAt,
      supportedTransports: [...this.supportedTransports],
      evidenceLevel: this.lastAcknowledgement?.level,
    };
  }
}
