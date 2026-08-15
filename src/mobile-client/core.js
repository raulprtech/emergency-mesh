import { canonicalCbor, signBrowserReport } from "./crypto.js";

export const ACTIONS = {
  SAFE: { eventType: "SAFE", reportMode: "SELF", priority: "NORMAL" },
  RESOURCE_REQUEST: { eventType: "RESOURCE_REQUEST", reportMode: "SELF", priority: "NORMAL" },
  ASSISTANCE_REQUEST: { eventType: "ASSISTANCE_REQUEST", reportMode: "SELF", priority: "HIGH" },
  SOS: { eventType: "SOS", reportMode: "SELF", priority: "CRITICAL" },
  THIRD_PARTY: { eventType: "SOS", reportMode: "THIRD_PARTY", priority: "CRITICAL" },
  LAST_SEEN: { eventType: "PERSON_LAST_SEEN", reportMode: "LAST_SEEN", priority: "HIGH" },
  PERSON_FOUND: { eventType: "PERSON_FOUND", reportMode: "THIRD_PARTY", priority: "NORMAL" },
};

const transitions = {
  CREATED: new Set(["QUEUED"]),
  QUEUED: new Set(["FORWARDED", "SYNCED", "EXPIRED"]),
  FORWARDED: new Set(["QUEUED", "GATEWAY_FOUND", "SYNCED", "EXPIRED"]),
  GATEWAY_FOUND: new Set(["QUEUED", "SYNCED", "EXPIRED"]),
  SYNCED: new Set(),
  EXPIRED: new Set(),
};

export const DELIVERY_LABELS = {
  CREATED: "Creado localmente",
  QUEUED: "En cola; aún no hay confirmación de entrega",
  FORWARDED: "Enviado a un transporte; entrega no confirmada",
  GATEWAY_FOUND: "Gateway alcanzado; atención humana no confirmada",
  SYNCED: "Recibido por un backend; no confirma atención ni ayuda",
  EXPIRED: "Expirado sin confirmación final",
};

export function transitionDelivery(item, nextState, at = Date.now(), evidence) {
  if (!transitions[item.state]?.has(nextState)) throw new Error(`Invalid delivery transition ${item.state} → ${nextState}`);
  return {
    ...item,
    state: nextState,
    updatedAt: at,
    history: [...item.history, { state: nextState, at, evidence }],
    evidence: evidence ? [...(item.evidence ?? []), evidence] : item.evidence ?? [],
  };
}

function optionalLocation(input, now) {
  if (!input.location || input.location.latitude === undefined || input.location.longitude === undefined) return undefined;
  return {
    latitude: Number(input.location.latitude.toFixed(3)),
    longitude: Number(input.location.longitude.toFixed(3)),
    accuracyMeters: Math.max(100, Math.round(input.location.accuracyMeters ?? 100)),
    timestamp: input.location.timestamp ?? now,
    source: "APPROXIMATE",
  };
}

const DEFAULT_INPUT_ERRORS = {
  unsupportedAction: "Acción no compatible",
  messageTooLong: "El mensaje excede 280 bytes",
  subjectRequired: "Se requiere un identificador pseudónimo de la persona",
  observationRequired: "Se requiere la fecha y hora de la observación",
  foundReferenceRequired: "Persona encontrada requiere una referencia",
  needRequired: "Selecciona al menos una necesidad",
};

export function validateClientInput(input, messages = DEFAULT_INPUT_ERRORS) {
  const errors = [];
  const config = ACTIONS[input.action];
  if (!config) errors.push(messages.unsupportedAction);
  if (new TextEncoder().encode(input.shortMessage ?? "").length > 280) errors.push(messages.messageTooLong);
  if ((input.action === "THIRD_PARTY" || input.action === "LAST_SEEN" || input.action === "PERSON_FOUND") && !input.subjectId) errors.push(messages.subjectRequired);
  if (input.action === "LAST_SEEN" && !Number.isFinite(input.observedAt)) errors.push(messages.observationRequired);
  if (input.action === "PERSON_FOUND" && !input.relatedEventId && !input.subjectId) errors.push(messages.foundReferenceRequired);
  if (input.action === "RESOURCE_REQUEST" && !(input.needs?.length)) errors.push(messages.needRequired);
  return errors;
}

export async function createOutboxItem(input, identity, now = Date.now(), signer = signBrowserReport) {
  const errors = validateClientInput(input);
  if (errors.length) throw new Error(errors.join("; "));
  const config = ACTIONS[input.action];
  const eventId = input.eventId ?? globalThis.crypto.randomUUID();
  const report = {
    protocolVersion: "0.1",
    eventId,
    eventType: config.eventType,
    reportMode: config.reportMode,
    priority: config.priority,
    createdAt: now,
    observedAt: input.observedAt ?? now,
    validUntil: now + 24 * 60 * 60_000,
    location: optionalLocation(input, now),
    peopleAffected: input.peopleAffected ?? 1,
    needs: input.needs?.map((category) => ({ category })),
    shortMessage: input.shortMessage?.trim() || undefined,
    anonymousDeviceId: identity.anonymousDeviceId,
    subject: config.reportMode === "SELF" ? undefined : { pseudonymousId: input.subjectId },
    relatedEventId: input.relatedEventId || undefined,
    nonce: globalThis.crypto.randomUUID(),
    trustMetadata: { level: "UNASSESSED", corroborationCount: 0 },
  };
  const signed = await signer(report, identity);
  const envelope = { packetId: globalThis.crypto.randomUUID(), report: signed, expiresAt: signed.validUntil, hopCount: 0, hopLimit: 12, transportHistory: [] };
  const created = { eventId, envelope, state: "CREATED", createdAt: now, updatedAt: now, attempts: 0, history: [{ state: "CREATED", at: now }], evidence: [] };
  return transitionDelivery(created, "QUEUED", now);
}

export class MemoryClientStore {
  constructor() { this.items = new Map(); }
  async put(item) { this.items.set(item.eventId, structuredClone(item)); }
  async get(eventId) { const item = this.items.get(eventId); return item ? structuredClone(item) : undefined; }
  async list() { return [...this.items.values()].map((item) => structuredClone(item)).sort((a, b) => b.createdAt - a.createdAt); }
  async remove(eventId) { this.items.delete(eventId); }
}

export async function synchronizeOutbox(store, fetcher = globalThis.fetch, endpoint = "/api/packets", now = Date.now()) {
  const results = [];
  for (const current of await store.list()) {
    if (current.state === "SYNCED" || current.state === "EXPIRED") continue;
    if (current.envelope.expiresAt <= now) {
      const expired = transitionDelivery(current, "EXPIRED", now); await store.put(expired); results.push(expired); continue;
    }
    let item = current.state === "FORWARDED" || current.state === "GATEWAY_FOUND"
      ? transitionDelivery(current, "QUEUED", now)
      : current;
    item = transitionDelivery(item, "FORWARDED", now);
    item.attempts += 1;
    await store.put(item);
    try {
      const response = await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/cbor" }, body: canonicalCbor(item.envelope) });
      const outcome = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(outcome.error ?? outcome.errors?.join("; ") ?? "HTTP " + response.status);
      if (outcome.status !== "ACCEPTED" && outcome.status !== "DUPLICATE") throw new Error(outcome.status ?? "backend rejected packet");
      item = transitionDelivery(item, "GATEWAY_FOUND", now);
      item = transitionDelivery(item, "SYNCED", now, outcome.evidence);
      item.lastError = undefined;
    } catch (error) {
      item = transitionDelivery(item, "QUEUED", now);
      item.lastError = error instanceof Error ? error.message : "Error de sincronización";
    }
    await store.put(item);
    results.push(item);
  }
  return results;
}
