import { randomUUID } from "node:crypto";
import type { EmergencyEnvelope, EmergencyReport } from "../protocol/types.ts";
import type { EmergencyRoutingManager, RoutingContext } from "../routing/manager.ts";
import { StoreAndForwardQueue } from "../storage/store.ts";
import type { StoreAndForwardStore } from "../storage/queue.ts";
import type { DeliveryAcknowledgement, TransportAdapter } from "../transports/transport.ts";

export interface FlushResult {
  eventId: string;
  selected: string[];
  accepted: string[];
}

export class SimulatedNode {
  readonly id: string;
  readonly queue: StoreAndForwardStore;
  readonly deliveryStates = new Map<string, string>();
  readonly deliveryEvidence = new Map<string, DeliveryAcknowledgement[]>();
  private readonly adapters: TransportAdapter[] = [];
  private readonly routing: EmergencyRoutingManager;
  private readonly context: RoutingContext;

  constructor(
    id: string,
    routing: EmergencyRoutingManager,
    context: RoutingContext = { batteryPercent: 100, energyMode: "NORMAL", maxCriticalPaths: 2 },
    queue: StoreAndForwardStore = new StoreAndForwardQueue(),
  ) { this.id = id; this.routing = routing; this.context = context; this.queue = queue; }

  addTransport(adapter: TransportAdapter): void { this.adapters.push(adapter); }
  batteryPercent(): number { return this.context.batteryPercent; }
  setBatteryPercent(value: number): void { this.context.batteryPercent = Math.max(0, Math.min(100, value)); }
  setEnergyMode(mode: RoutingContext["energyMode"]): void { this.context.energyMode = mode; }

  create(report: EmergencyReport, lifetimeMs = 24 * 60 * 60_000, hopLimit = 12): EmergencyEnvelope {
    const envelope: EmergencyEnvelope = {
      packetId: randomUUID(),
      report: structuredClone(report),
      expiresAt: Math.min(report.createdAt + lifetimeMs, report.validUntil),
      hopCount: 0,
      hopLimit,
      transportHistory: [],
    };
    this.deliveryStates.set(report.eventId, "CREATED");
    this.receive(envelope, report.createdAt);
    return envelope;
  }

  receive(envelope: EmergencyEnvelope, now = Date.now()): boolean {
    const accepted = this.queue.enqueue(envelope, now);
    if (accepted) this.deliveryStates.set(envelope.report.eventId, "QUEUED");
    return accepted;
  }

  async flush(now = Date.now()): Promise<FlushResult[]> {
    const results: FlushResult[] = [];
    this.context.now = now;
    for (const record of this.queue.ready(now)) {
      const decision = this.routing.select(record.envelope, this.adapters, this.context);
      if (!decision.adapters.length) {
        this.queue.recordFailure(record.envelope.report.eventId, now);
        results.push({ eventId: record.envelope.report.eventId, selected: [], accepted: [] });
        continue;
      }
      const accepted: string[] = [];
      for (const adapter of decision.adapters) {
        const forwarded: EmergencyEnvelope = {
          ...structuredClone(record.envelope),
          hopCount: record.envelope.hopCount + 1,
          lastForwardedAt: now,
          transportHistory: [
            ...(record.envelope.transportHistory ?? []),
            { transportId: adapter.id, forwardedAt: now, nodeId: this.id },
          ],
        };
        if (this.context.batteryPercent <= 0) continue;
        const outcome = await adapter.send(forwarded);
        this.context.batteryPercent = Math.max(0, this.context.batteryPercent - adapter.estimatedEnergyCost(forwarded) * 0.1);
        if (outcome.accepted) {
          accepted.push(adapter.id);
          if (outcome.evidence) {
            const evidence = this.deliveryEvidence.get(record.envelope.report.eventId) ?? [];
            evidence.push(structuredClone(outcome.evidence));
            this.deliveryEvidence.set(record.envelope.report.eventId, evidence);
          }
          this.deliveryStates.set(record.envelope.report.eventId, outcome.acknowledgement === "BACKEND" ? "SYNCED" : "FORWARDED");
        }
      }
      if (accepted.length) this.queue.remove(record.envelope.report.eventId);
      else this.queue.recordFailure(record.envelope.report.eventId, now);
      results.push({ eventId: record.envelope.report.eventId, selected: decision.adapters.map((adapter) => adapter.id), accepted });
    }
    return results;
  }
}
