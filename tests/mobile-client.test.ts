import assert from "node:assert/strict";
import test from "node:test";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { verifyReportSignature } from "../src/protocol/identity.ts";
import { ACTIONS, DELIVERY_LABELS, MemoryClientStore, createOutboxItem, synchronizeOutbox, transitionDelivery, validateClientInput } from "../src/mobile-client/core.js";
import { canonicalCbor, createBrowserIdentity, verifyBrowserReport } from "../src/mobile-client/crypto.js";

const now = 1_800_000_000_000;
const unsignedIdentity = { mode: "UNSIGNED", anonymousDeviceId: "unsigned-test" };
const noSignature = async (report: unknown) => report;

test("four primary actions map to minimal protocol semantics", async () => {
  const cases = [
    ["SAFE", "SAFE", "SELF", "NORMAL"],
    ["RESOURCE_REQUEST", "RESOURCE_REQUEST", "SELF", "NORMAL"],
    ["ASSISTANCE_REQUEST", "ASSISTANCE_REQUEST", "SELF", "HIGH"],
    ["SOS", "SOS", "SELF", "CRITICAL"],
  ] as const;
  for (const [action, eventType, reportMode, priority] of cases) {
    const item = await createOutboxItem({ action, needs: action === "RESOURCE_REQUEST" ? ["WATER"] : undefined }, unsignedIdentity, now, noSignature);
    assert.equal(item.envelope.report.eventType, eventType);
    assert.equal(item.envelope.report.reportMode, reportMode);
    assert.equal(item.envelope.report.priority, priority);
    assert.equal(item.state, "QUEUED");
  }
});

test("THIRD_PARTY, LAST_SEEN and PERSON_FOUND require pseudonymous subject semantics", async () => {
  assert.match(validateClientInput({ action: "THIRD_PARTY" }).join(" "), /pseudónimo/);
  assert.match(validateClientInput({ action: "LAST_SEEN", subjectId: "person" }).join(" "), /fecha y hora/);
  const lastSeen = await createOutboxItem({ action: "LAST_SEEN", subjectId: "person-a", observedAt: now - 60_000 }, unsignedIdentity, now, noSignature);
  assert.equal(lastSeen.envelope.report.eventType, "PERSON_LAST_SEEN");
  assert.equal(lastSeen.envelope.report.observedAt, now - 60_000);
  assert.equal(lastSeen.envelope.report.subject?.pseudonymousId, "person-a");
  const found = await createOutboxItem({ action: "PERSON_FOUND", subjectId: "person-a", relatedEventId: lastSeen.eventId }, unsignedIdentity, now, noSignature);
  assert.equal(found.envelope.report.relatedEventId, lastSeen.eventId);
});

test("client rounds location and enforces a minimum uncertainty", async () => {
  const item = await createOutboxItem({ action: "SOS", location: { latitude: 19.4326123, longitude: -99.1332456, accuracyMeters: 8, timestamp: now } }, unsignedIdentity, now, noSignature);
  assert.deepEqual(item.envelope.report.location, { latitude: 19.433, longitude: -99.133, accuracyMeters: 100, timestamp: now, source: "APPROXIMATE" });
});

test("browser deterministic CBOR matches protocol canonical CBOR", () => {
  const value = { z: 1, a: "texto", nested: { location: [19.4, -99.1], active: true }, omitted: undefined };
  assert.deepEqual(canonicalCbor(value), encodeCbor(value));
});

test("browser Ed25519 report is accepted by the shared protocol verifier", async () => {
  const identity = await createBrowserIdentity();
  const item = await createOutboxItem({ action: "SOS", eventId: "browser-signed-event" }, identity, now);
  assert.equal(await verifyBrowserReport(item.envelope.report), true);
  assert.equal(verifyReportSignature(item.envelope.report), true);
  assert.equal(await verifyBrowserReport({ ...item.envelope.report, shortMessage: "alterado" }), false);
});

test("delivery transitions reject false progress and labels state non-guarantees", async () => {
  const item = await createOutboxItem({ action: "SAFE" }, unsignedIdentity, now, noSignature);
  assert.throws(() => transitionDelivery(item, "GATEWAY_FOUND", now), /Invalid delivery transition/);
  assert.match(DELIVERY_LABELS.SYNCED, /no confirma atención ni ayuda/);
  assert.doesNotMatch(Object.values(DELIVERY_LABELS).join(" ").toLowerCase(), /ayuda está en camino/);
});

test("offline synchronization keeps custody; backend ACK advances to SYNCED", async () => {
  const store = new MemoryClientStore();
  const created = await createOutboxItem({ action: "SOS", eventId: "sync-event" }, unsignedIdentity, now, noSignature);
  await store.put(created);
  await synchronizeOutbox(store, async () => { throw new Error("offline"); }, "/api/packets", now);
  const queued = await store.get(created.eventId);
  assert.equal(queued?.state, "QUEUED");
  assert.equal(queued?.attempts, 1);

  const evidence = { acknowledgementId: "ack", eventId: created.eventId, packetId: created.envelope.packetId, level: "BACKEND", acknowledgedAt: now + 1, issuerId: "backend", status: "STORED" };
  await synchronizeOutbox(store, async () => ({ ok: true, status: 202, json: async () => ({ status: "ACCEPTED", evidence }) }), "/api/packets", now + 1);
  const synced = await store.get(created.eventId);
  assert.equal(synced?.state, "SYNCED");
  assert.equal(synced?.attempts, 2);
  assert.equal(synced?.evidence.length, 1);
  assert.deepEqual(synced?.history.slice(-2).map((entry: { state: string }) => entry.state), ["GATEWAY_FOUND", "SYNCED"]);
});

test("expired outbox item is never sent", async () => {
  const store = new MemoryClientStore();
  const item = await createOutboxItem({ action: "SAFE", eventId: "expired-client" }, unsignedIdentity, now, noSignature);
  await store.put(item);
  let called = false;
  await synchronizeOutbox(store, async () => { called = true; throw new Error("must not send"); }, "/api/packets", item.envelope.expiresAt);
  assert.equal(called, false);
  assert.equal((await store.get(item.eventId))?.state, "EXPIRED");
});

test("all declared actions have a user-facing mapping", () => {
  assert.deepEqual(Object.keys(ACTIONS).sort(), ["ASSISTANCE_REQUEST", "LAST_SEEN", "PERSON_FOUND", "RESOURCE_REQUEST", "SAFE", "SOS", "THIRD_PARTY"]);
});
