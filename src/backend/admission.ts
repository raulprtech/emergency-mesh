export interface IngestAdmissionLimits {
  windowMs?: number;
  maximumGlobalRequests?: number;
  maximumRequestsPerIdentity?: number;
  maximumTrackedIdentities?: number;
}

export interface AdmissionRejection {
  allowed: false;
  scope: "GLOBAL" | "IDENTITY" | "IDENTITY_CAPACITY";
  retryAfterMs: number;
}

export type AdmissionDecision = { allowed: true } | AdmissionRejection;

export const DEFAULT_INGEST_ADMISSION_LIMITS = {
  windowMs: 60_000,
  maximumGlobalRequests: 600,
  maximumRequestsPerIdentity: 60,
  maximumTrackedIdentities: 10_000,
} as const;

type Window = { startedAt: number; count: number };

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

export class IngestAdmissionController {
  private readonly limits: Required<IngestAdmissionLimits>;
  private globalWindow?: Window;
  private readonly identities = new Map<string, Window>();

  constructor(limits: IngestAdmissionLimits = {}) {
    this.limits = {
      windowMs: positiveInteger(limits.windowMs ?? DEFAULT_INGEST_ADMISSION_LIMITS.windowMs, "windowMs"),
      maximumGlobalRequests: positiveInteger(limits.maximumGlobalRequests ?? DEFAULT_INGEST_ADMISSION_LIMITS.maximumGlobalRequests, "maximumGlobalRequests"),
      maximumRequestsPerIdentity: positiveInteger(limits.maximumRequestsPerIdentity ?? DEFAULT_INGEST_ADMISSION_LIMITS.maximumRequestsPerIdentity, "maximumRequestsPerIdentity"),
      maximumTrackedIdentities: positiveInteger(limits.maximumTrackedIdentities ?? DEFAULT_INGEST_ADMISSION_LIMITS.maximumTrackedIdentities, "maximumTrackedIdentities"),
    };
  }

  admitRequest(now = Date.now()): AdmissionDecision {
    this.validateNow(now);
    this.globalWindow = this.currentWindow(this.globalWindow, now);
    if (this.globalWindow.count >= this.limits.maximumGlobalRequests) {
      return this.rejected("GLOBAL", this.globalWindow, now);
    }
    this.globalWindow.count += 1;
    return { allowed: true };
  }

  admitIdentity(identity: string, now = Date.now()): AdmissionDecision {
    this.validateNow(now);
    if (!identity) throw new Error("identity is required");
    this.pruneIdentities(now);
    let window = this.identities.get(identity);
    if (!window && this.identities.size >= this.limits.maximumTrackedIdentities) {
      const retryAfterMs = Math.max(1, Math.min(...[...this.identities.values()].map((item) => item.startedAt + this.limits.windowMs - now)));
      return { allowed: false, scope: "IDENTITY_CAPACITY", retryAfterMs };
    }
    window = this.currentWindow(window, now);
    this.identities.set(identity, window);
    if (window.count >= this.limits.maximumRequestsPerIdentity) return this.rejected("IDENTITY", window, now);
    window.count += 1;
    return { allowed: true };
  }

  trackedIdentities(): number { return this.identities.size; }

  private currentWindow(window: Window | undefined, now: number): Window {
    if (!window || now >= window.startedAt + this.limits.windowMs) return { startedAt: now, count: 0 };
    return window;
  }

  private pruneIdentities(now: number): void {
    for (const [identity, window] of this.identities) {
      if (now >= window.startedAt + this.limits.windowMs) this.identities.delete(identity);
    }
  }

  private rejected(scope: "GLOBAL" | "IDENTITY", window: Window, now: number): AdmissionDecision {
    return { allowed: false, scope, retryAfterMs: Math.max(1, window.startedAt + this.limits.windowMs - now) };
  }

  private validateNow(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("now must be a non-negative safe integer");
  }
}
