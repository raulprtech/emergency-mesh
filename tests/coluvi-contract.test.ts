import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createDeviceIdentityFromSeed } from "../src/protocol/identity.ts";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { authorityFor, authorityFingerprint, createCheckinCommand, signColuviReport, verifyAuthorizedCommand, verifyColuviReport } from "../src/commands/authority.ts";
import { canonicalCbor, createBrowserIdentity } from "../src/mobile-client/crypto.js";
import { commandErrors, coluviSigningBytes, createCheckinResponse, responseErrors, verifyColuviDomain, verifyCommandForDevice } from "../src/mobile-client/commands.js";

const now = 1_800_000_000_000;
const identity = createDeviceIdentityFromSeed(Uint8Array.from({ length: 32 }, (_, i) => i));
const authority = authorityFor(identity, ["refugio-norte"]);
const input = { commandId: "checkin-001", incidentRef: "simulacro-inundacion", zoneId: "refugio-norte", nonce: "nonce-001", issuedAt: now, promptUntil: now + 60_000, responseUntil: now + 120_000 };
const command = createCheckinCommand(identity, authority, input);
const vector = JSON.parse(readFileSync(new URL("../examples/coluvi-command-vector.json", import.meta.url), "utf8"));

test("Coluvi deterministic command vector matches browser CBOR and both verifiers", async () => {
  assert.deepEqual(canonicalCbor(command), encodeCbor(command));
  assert.deepEqual(createCheckinCommand(identity, authority, input), command);
  assert.deepEqual(command, vector.report);
  assert.deepEqual(authority, vector.authority);
  assert.equal(authorityFingerprint(authority), vector.fingerprint);
  assert.equal(verifyAuthorizedCommand(command, [authority], now), true);
  assert.equal(await verifyCommandForDevice(command, [authority], input.zoneId, now), true);
  assert.equal(await verifyColuviDomain(command), true);
  const { domainSignature: _, ...payload } = command.extensions!.coluvi as Record<string, unknown>;
  assert.deepEqual(coluviSigningBytes(payload), encodeCbor({ domain: "COLUVI/CHECKIN_REQUEST/v1", payload }));
});

test("unknown, revoked, wrong-zone, wrong-kind and expired authorities never authorize prompts", async () => {
  for (const trust of [[], [{ ...authority, revoked: true }], [{ ...authority, zones: [] }], [{ ...authority, kinds: [] }], [{ ...authority, publicKey: "bad" }]]) {
    assert.equal(verifyAuthorizedCommand(command, trust, now), false);
    assert.equal(await verifyCommandForDevice(command, trust, input.zoneId, now), false);
  }
  assert.equal(await verifyCommandForDevice(command, [authority], "another-zone", now), false);
  for (const at of [now - 1, input.promptUntil, input.responseUntil, NaN]) {
    assert.equal(await verifyCommandForDevice(command, [authority], input.zoneId, at), false);
    assert.equal(verifyAuthorizedCommand(command, [authority], at), false);
  }
  assert.equal(verifyAuthorizedCommand(command, [authority], input.promptUntil, true), true);
  assert.equal(await verifyCommandForDevice(command, [authority], input.zoneId, input.promptUntil, true), true);
  assert.equal(verifyAuthorizedCommand(command, [authority], input.responseUntil, true), false);
});

test("altered, unsigned, malformed and cross-domain commands are rejected without throwing", async () => {
  const payload = command.extensions!.coluvi as Record<string, unknown>;
  const changed = [
    { ...command, signature: undefined }, { ...command, eventId: "different" }, { ...command, extensions: { coluvi: { ...payload, zoneId: "other" } } },
    { ...command, location: { ...command.location, latitude: 21 } },
    { ...command, extensions: { coluvi: { ...payload, domainSignature: command.signature!.value } } },
    { ...command, extensions: { coluvi: { ...payload, extra: true } } },
    { ...command, extensions: { coluvi: { ...payload, version: 2 } } },
    { ...command, signature: { ...command.signature!, publicKey: "bad" } }, null, {},
  ];
  for (const value of changed) {
    assert.equal(verifyAuthorizedCommand(value as typeof command, [authority], now), false);
    assert.equal(await verifyCommandForDevice(value, [authority], input.zoneId, now), false);
  }
  assert.ok(commandErrors(changed[3]).length);
  assert.throws(() => createCheckinCommand(identity, authority, { ...input, promptUntil: now + 25 * 60 * 60_000, responseUntil: now + 26 * 60 * 60_000 }));
});

test("minimal browser responses bind the command, sign both domains and never turn NEEDS_HELP into SOS", async () => {
  const browserIdentity = await createBrowserIdentity();
  for (const status of ["SAFE", "NEEDS_HELP"]) {
    const item = await createCheckinResponse(command, status, browserIdentity, now + 1_000);
    assert.deepEqual(responseErrors(item.envelope.report, command), []);
    assert.equal(verifyColuviReport(item.envelope.report), true);
    assert.equal(await verifyColuviDomain(item.envelope.report), true);
    assert.equal(item.state, "QUEUED");
    assert.equal(item.envelope.report.eventType, "x-coluvi-checkin-response");
    assert.equal(item.envelope.report.priority, status === "SAFE" ? "NORMAL" : "HIGH");
    for (const field of ["location", "peopleAffected", "needs", "subject"]) assert.equal(item.envelope.report[field], undefined);
    assert.ok(responseErrors({ ...item.envelope.report, relatedEventId: "other" }, command).length);
    assert.ok(responseErrors({ ...item.envelope.report, observedAt: input.promptUntil + 1 }, command).length);
    assert.ok(responseErrors({ ...item.envelope.report, createdAt: input.promptUntil, observedAt: input.promptUntil }, command).length);
    assert.ok(responseErrors({ ...item.envelope.report, shortMessage: "private" }, command).length);
  }
  await assert.rejects(createCheckinResponse(command, "UNKNOWN", browserIdentity, now));
  await assert.rejects(createCheckinResponse(command, "SAFE", browserIdentity, input.promptUntil));
  await assert.rejects(createCheckinResponse(command, "SAFE", browserIdentity, NaN));
  await assert.rejects(createCheckinResponse(command, "SAFE", { mode: "UNSIGNED", anonymousDeviceId: "unsigned" }, now));
});

test("even a valid outer signature cannot replace the command-specific signature", () => {
  const payload = command.extensions!.coluvi as Record<string, unknown>;
  const wrongKind = signColuviReport({ ...command, extensions: { coluvi: { ...payload, kind: "CHECKIN_RESPONSE" } } }, identity);
  assert.equal(verifyColuviReport(wrongKind), true);
  assert.equal(verifyAuthorizedCommand(wrongKind, [authority], now), false);
});
