import { decodeCbor, encodeCbor } from "./cbor.ts";
import { validateEnvelope, type EmergencyEnvelope } from "./types.ts";

// Short keys are stable wire identifiers. New optional keys may be added in minor versions.
function compact(value: unknown, context = "envelope"): unknown {
  if (Array.isArray(value)) return value.map((item) => compact(item, context));
  if (!value || typeof value !== "object" || value instanceof Uint8Array) return value;
  const result: Record<string, unknown> = {};
  const reverse = REVERSE_BY_CONTEXT[context] ?? {};
  const forward = Object.fromEntries(Object.entries(reverse).map(([short, long]) => [long, short]));
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    const mapped = forward[key] ?? key;
    result[mapped] = compact(item, key);
  }
  return result;
}

const REVERSE_BY_CONTEXT: Record<string, Record<string, string>> = {
  envelope: { a: "packetId", b: "report", c: "expiresAt", d: "hopCount", e: "hopLimit", f: "lastForwardedAt", g: "transportHistory" },
  report: { a: "protocolVersion", b: "eventId", c: "incidentRef", d: "eventType", e: "reportMode", f: "priority", g: "createdAt", h: "observedAt", w: "validUntil", i: "location", j: "peopleAffected", k: "needs", l: "shortMessage", m: "anonymousDeviceId", n: "subject", o: "relatedEventId", p: "nonce", q: "publicPayload", r: "protectedPayload", s: "identityMetadata", t: "trustMetadata", u: "signature", v: "extensions" },
  location: { a: "latitude", b: "longitude", c: "accuracyMeters", d: "timestamp", e: "source", f: "zoneId" },
  needs: { a: "category", b: "quantity", c: "unit", d: "note" },
  subject: { a: "pseudonymousId", b: "name", c: "description", d: "ageRange", e: "distinguishingFeatures" },
  trustMetadata: { a: "level", b: "corroborationCount", c: "extensions" },
  signature: { a: "algorithm", b: "publicKey", c: "value" },
  transportHistory: { a: "transportId", b: "forwardedAt", c: "nodeId" },
};

function expand(value: unknown, context = "envelope"): unknown {
  if (Array.isArray(value)) return value.map((item) => expand(item, context));
  if (!value || typeof value !== "object" || value instanceof Uint8Array) return value;
  const reverse = REVERSE_BY_CONTEXT[context] ?? {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const mapped = reverse[key] ?? key;
    result[mapped] = expand(item, mapped);
  }
  return result;
}

export function serializeEnvelope(envelope: EmergencyEnvelope): Uint8Array {
  const errors = validateEnvelope(envelope);
  if (errors.length) throw new Error(`Invalid emergency envelope: ${errors.join("; ")}`);
  return encodeCbor(compact(envelope));
}

export function deserializeEnvelope(bytes: Uint8Array): EmergencyEnvelope {
  const envelope = expand(decodeCbor(bytes)) as EmergencyEnvelope;
  const errors = validateEnvelope(envelope);
  if (errors.length) throw new Error(`Invalid emergency envelope: ${errors.join("; ")}`);
  return envelope;
}

export function envelopeToJson(envelope: EmergencyEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

export function envelopeFromJson(json: string): EmergencyEnvelope {
  const envelope = JSON.parse(json) as EmergencyEnvelope;
  const errors = validateEnvelope(envelope);
  if (errors.length) throw new Error(`Invalid emergency envelope: ${errors.join("; ")}`);
  return envelope;
}
