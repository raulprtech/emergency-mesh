import type { EmergencyEnvelope } from "../protocol/types.ts";
import type { TransportAdapter } from "../transports/transport.ts";

export interface RoutingContext {
  batteryPercent: number;
  energyMode: "NORMAL" | "EMERGENCY" | "LOW_BATTERY";
  maxCriticalPaths?: number;
  now?: number;
}

export interface RouteDecision {
  adapters: TransportAdapter[];
  reason: string;
}

export interface EmergencyRoutingManager {
  select(envelope: EmergencyEnvelope, adapters: TransportAdapter[], context: RoutingContext): RouteDecision;
}

const energyWeight = { LOW: 1, MEDIUM: 2, HIGH: 4 } as const;

/** Deterministic v0.1 strategy. It selects adapters, never their internal hops. */
export class DeterministicRoutingManager implements EmergencyRoutingManager {
  select(envelope: EmergencyEnvelope, adapters: TransportAdapter[], context: RoutingContext): RouteDecision {
    const eligible = adapters
      .filter((adapter) => adapter.available())
      .filter((adapter) => adapter.maximumPayloadSize() > 0)
      .map((adapter) => {
        const capability = adapter.capabilities();
        const advertisement = adapter.egressAdvertisement?.(context.now);
        const egress = advertisement
          ? advertisement.state === "CONFIRMED" ? 90 + advertisement.quality * 20
            : advertisement.state === "REPORTED" ? 45 + advertisement.quality * 20 : 0
          : adapter.hasEgress() ? 80 + adapter.egressQuality() * 20 : 0;
        const latency = Math.max(0, 15 - (capability.latencyMs ?? 5_000) / 1_000);
        const energyPenalty = energyWeight[capability.energyCost] * (context.energyMode === "LOW_BATTERY" ? 10 : 3);
        const monetaryPenalty = adapter.estimatedCost(envelope) * 10;
        return { adapter, score: egress + latency - energyPenalty - monetaryPenalty };
      })
      .sort((a, b) => b.score - a.score || a.adapter.id.localeCompare(b.adapter.id));

    if (!eligible.length) return { adapters: [], reason: "No transport is currently available" };
    const isCritical = envelope.report.priority === "CRITICAL" || envelope.report.eventType === "SOS";
    const limit = isCritical && context.energyMode !== "LOW_BATTERY"
      ? Math.max(1, context.maxCriticalPaths ?? 2)
      : 1;
    return {
      adapters: eligible.slice(0, limit).map(({ adapter }) => adapter),
      reason: isCritical && limit > 1 ? "Bounded multipath for critical report" : "Highest deterministic delivery score",
    };
  }
}
