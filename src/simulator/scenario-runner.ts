import { createHash } from "node:crypto";
import { ReferenceBackend } from "../backend/backend.ts";
import { Gateway } from "../gateway/gateway.ts";
import { createDeviceIdentityFromSeed } from "../protocol/identity.ts";
import type { EventType, Priority, ReportMode } from "../protocol/types.ts";
import { DeterministicRoutingManager } from "../routing/manager.ts";
import { InternetAdapter } from "../transports/internet.ts";
import { FragmentedMockTransportAdapter } from "../transports/fragmented-mock.ts";
import { VirtualClock } from "./clock.ts";
import { makeReport } from "./fixtures.ts";
import { LossyLinkAdapter } from "./lossy-link.ts";
import { SimulatedNode, type FlushResult } from "./node.ts";
import { SeededRandom } from "./random.ts";

export interface ScenarioNodeDefinition {
  id: string;
  batteryPercent?: number;
  energyMode?: "NORMAL" | "EMERGENCY" | "LOW_BATTERY";
  internetInitiallyOnline?: boolean;
}

export interface ScenarioLinkDefinition {
  id: string;
  from: string;
  to: string;
  lossRate?: number;
  initiallyAvailable?: boolean;
  maximumPayloadSize?: number;
  fragmentation?: boolean;
}

export type ScenarioAction =
  | { at: number; type: "CREATE"; nodeId: string; eventId: string; eventType?: EventType; reportMode?: ReportMode; priority?: Priority; subjectId?: string; relatedEventId?: string }
  | { at: number; type: "FLUSH"; nodeId: string }
  | { at: number; type: "SET_LINK"; linkId: string; available: boolean }
  | { at: number; type: "SET_INTERNET"; nodeId: string; online: boolean }
  | { at: number; type: "SET_BATTERY"; nodeId: string; batteryPercent: number };

export interface ScenarioDefinition {
  version: 1;
  name: string;
  startAt: number;
  seed: number;
  nodes: ScenarioNodeDefinition[];
  links: ScenarioLinkDefinition[];
  actions: ScenarioAction[];
}

export interface ScenarioTraceEntry {
  at: number;
  action: ScenarioAction;
  flush?: FlushResult[];
  backendEvents: number;
}

export interface ScenarioResult {
  name: string;
  trace: ScenarioTraceEntry[];
  backend: ReferenceBackend;
  nodes: Map<string, SimulatedNode>;
}

function requireEntry<T>(map: Map<string, T>, id: string, kind: string): T {
  const value = map.get(id);
  if (!value) throw new Error(`Unknown ${kind}: ${id}`);
  return value;
}

export function validateScenario(definition: ScenarioDefinition): string[] {
  const errors: string[] = [];
  if (definition.version !== 1) errors.push("unsupported scenario version");
  if (!definition.name) errors.push("scenario name is required");
  const nodeIds = new Set<string>();
  for (const node of definition.nodes ?? []) {
    if (!node.id || nodeIds.has(node.id)) errors.push(`duplicate or empty node id: ${node.id}`);
    nodeIds.add(node.id);
  }
  const linkIds = new Set<string>();
  for (const link of definition.links ?? []) {
    if (!link.id || linkIds.has(link.id)) errors.push(`duplicate or empty link id: ${link.id}`);
    linkIds.add(link.id);
    if (!nodeIds.has(link.from) || !nodeIds.has(link.to)) errors.push(`link ${link.id} references an unknown node`);
    if ((link.lossRate ?? 0) < 0 || (link.lossRate ?? 0) > 1) errors.push(`link ${link.id} has invalid lossRate`);
    if (link.maximumPayloadSize !== undefined && (!Number.isInteger(link.maximumPayloadSize) || link.maximumPayloadSize < 1)) errors.push(`link ${link.id} has invalid maximumPayloadSize`);
    if (link.fragmentation !== undefined && typeof link.fragmentation !== "boolean") errors.push(`link ${link.id} has invalid fragmentation flag`);
  }
  for (const action of definition.actions ?? []) {
    if (!Number.isFinite(action.at) || action.at < 0) errors.push("action time must be non-negative");
    if ("nodeId" in action && !nodeIds.has(action.nodeId)) errors.push(`action references unknown node: ${action.nodeId}`);
    if (action.type === "SET_LINK" && !linkIds.has(action.linkId)) errors.push(`action references unknown link: ${action.linkId}`);
  }
  return errors;
}

export async function runScenario(definition: ScenarioDefinition): Promise<ScenarioResult> {
  const errors = validateScenario(definition);
  if (errors.length) throw new Error(`Invalid scenario: ${errors.join("; ")}`);
  const clock = new VirtualClock(definition.startAt);
  const backend = new ReferenceBackend();
  const gateway = new Gateway("scenario-gateway", backend);
  const routing = new DeterministicRoutingManager();
  const nodes = new Map<string, SimulatedNode>();
  const internet = new Map<string, InternetAdapter>();
  const links = new Map<string, LossyLinkAdapter | FragmentedMockTransportAdapter>();

  for (const item of definition.nodes) {
    const node = new SimulatedNode(item.id, routing, {
      batteryPercent: item.batteryPercent ?? 100,
      energyMode: item.energyMode ?? "NORMAL",
      maxCriticalPaths: 2,
    });
    const adapter = new InternetAdapter(`internet-${item.id}`, gateway, () => clock.now());
    adapter.setOnline(item.internetInitiallyOnline ?? false);
    node.addTransport(adapter);
    nodes.set(item.id, node);
    internet.set(item.id, adapter);
  }

  definition.links.forEach((item, index) => {
    const random = new SeededRandom((definition.seed + index) >>> 0);
    const adapter = item.fragmentation
      ? new FragmentedMockTransportAdapter(item.id, {
        maximumPayloadSize: item.maximumPayloadSize,
        deliverFrame: () => random.next() >= (item.lossRate ?? 0),
        now: () => clock.now(),
      })
      : new LossyLinkAdapter(item.id, random, {
        lossRate: item.lossRate,
        maximumPayloadSize: item.maximumPayloadSize,
      });
    const target = requireEntry(nodes, item.to, "node");
    adapter.connect((envelope) => target.receive(envelope, clock.now()));
    adapter.setAvailable(item.initiallyAvailable ?? true);
    requireEntry(nodes, item.from, "node").addTransport(adapter);
    links.set(item.id, adapter);
  });

  const trace: ScenarioTraceEntry[] = [];
  const actions = definition.actions.map((action, order) => ({ action, order }))
    .sort((left, right) => left.action.at - right.action.at || left.order - right.order);
  for (const { action } of actions) {
    clock.set(definition.startAt + action.at);
    let flush: FlushResult[] | undefined;
    if (action.type === "CREATE") {
      const node = requireEntry(nodes, action.nodeId, "node");
      const seed = createHash("sha256").update(`${definition.seed}:${action.nodeId}`).digest();
      node.create(makeReport({
        identity: createDeviceIdentityFromSeed(seed),
        eventId: action.eventId,
        eventType: action.eventType,
        reportMode: action.reportMode,
        priority: action.priority,
        subjectId: action.subjectId,
        relatedEventId: action.relatedEventId,
        createdAt: clock.now(),
      }));
    } else if (action.type === "FLUSH") {
      flush = await requireEntry(nodes, action.nodeId, "node").flush(clock.now());
    } else if (action.type === "SET_LINK") {
      requireEntry(links, action.linkId, "link").setAvailable(action.available);
    } else if (action.type === "SET_INTERNET") {
      requireEntry(internet, action.nodeId, "Internet adapter").setOnline(action.online);
    } else if (action.type === "SET_BATTERY") {
      requireEntry(nodes, action.nodeId, "node").setBatteryPercent(action.batteryPercent);
    }
    trace.push({ at: clock.now(), action, flush, backendEvents: backend.size() });
  }
  return { name: definition.name, trace, backend, nodes };
}
