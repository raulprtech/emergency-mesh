import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceIdentityFromSeed } from "../src/protocol/identity.ts";
import { NEED_CATEGORIES } from "../src/protocol/types.ts";
import { authorityFor, createCheckinCommand, verifyColuviReport } from "../src/commands/authority.ts";
import { ColuviStore } from "../src/commands/store.ts";
import { createBrowserIdentity, canonicalCbor } from "../src/mobile-client/crypto.js";
import { CHECKIN_NEEDS, coluviSigningBytes, createCheckinResponse, createCheckinUpdate, createCheckinNeeds, responseErrors, needsErrors, signColuviBrowserReport, verifyColuviDomain } from "../src/mobile-client/commands.js";
import { aggregateReports, PUBLIC_AGGREGATION_POLICY } from "../src/backend/aggregation.ts";

const now = 1_800_000_000_000;
const issuer = createDeviceIdentityFromSeed(new Uint8Array(32).fill(19));
const authority = authorityFor(issuer, ["north"]);
const command = createCheckinCommand(issuer, authority, { commandId: "update-request", zoneId: "north", incidentRef: "drill", nonce: "command-nonce",
  issuedAt: now, promptUntil: now + 60_000, responseUntil: now + 120_000 });

test("v2 updates preserve v1 semantics, link revisions and accept late first observations", async () => {
  const identity = await createBrowserIdentity();
  const first = await createCheckinResponse(command, "NEEDS_HELP", identity, now + 1);
  const update = await createCheckinUpdate(command, "SAFE", identity, first.envelope.report, now + 1);
  assert.equal(update.envelope.report.extensions.coluvi.revision, 1);
  assert.equal(update.envelope.report.extensions.coluvi.previousEventId, first.eventId);
  assert.deepEqual(responseErrors(update.envelope.report, command), []);
  assert.equal(verifyColuviReport(update.envelope.report), true);
  assert.equal(await verifyColuviDomain(update.envelope.report), true);
  const { domainSignature: _, ...payload } = update.envelope.report.extensions.coluvi;
  assert.deepEqual(coluviSigningBytes(payload), canonicalCbor({ domain: "COLUVI/CHECKIN_RESPONSE/v2", payload }));
  const late = await createCheckinUpdate(command, "SAFE", identity, null, now + 70_000);
  assert.equal(late.envelope.report.extensions.coluvi.previousEventId, null);
  assert.deepEqual(responseErrors(late.envelope.report, command), []);
  await assert.rejects(createCheckinResponse(command, "SAFE", identity, now + 70_000));
  await assert.rejects(createCheckinUpdate(command, "SAFE", identity, null, now + 120_000));
  await assert.rejects(createCheckinUpdate(command, "SAFE", identity, first.envelope.report, now));
  await assert.rejects(createCheckinUpdate(command, "SAFE", await createBrowserIdentity(), first.envelope.report, now + 2));
  for (const patch of [{ revision: -1 }, { revision: 100 }, { previousEventId: update.eventId }, { revision: 0 }, { version: 3 }]) {
    assert.ok(responseErrors({ ...update.envelope.report, extensions: { coluvi: { ...update.envelope.report.extensions.coluvi, ...patch } } }, command).length);
  }
});

test("needs require a saved signed help response, bounded categories and independent delivery", async () => {
  assert.deepEqual(CHECKIN_NEEDS, NEED_CATEGORIES);
  const identity = await createBrowserIdentity();
  const help = await createCheckinResponse(command, "NEEDS_HELP", identity, now + 1);
  const needs = await createCheckinNeeds(command, help.envelope.report, { categories: ["WATER", "TRANSPORT"], peopleAffected: 3 }, identity, null, now + 2);
  assert.deepEqual(needsErrors(needs.envelope.report, command), []);
  assert.equal(verifyColuviReport(needs.envelope.report), true);
  assert.equal(await verifyColuviDomain(needs.envelope.report), true);
  assert.equal(needs.envelope.report.relatedEventId, help.eventId);
  assert.equal(help.envelope.report.needs, undefined);
  assert.equal(help.state, "QUEUED");
  const safe = await createCheckinUpdate(command, "SAFE", identity, help.envelope.report, now + 3);
  await assert.rejects(createCheckinNeeds(command, safe.envelope.report, { categories: ["WATER"] }, identity, null, now + 4));
  for (const detail of [{ categories: ["WATER", "WATER"] }, { categories: ["x-secret"] }, { categories: [], peopleAffected: 0 }, { categories: [], peopleAffected: 1000 }]) {
    await assert.rejects(createCheckinNeeds(command, help.envelope.report, detail, identity, null, now + 4));
  }
  await assert.rejects(createCheckinNeeds(command, help.envelope.report, { categories: [] }, identity, null, now + 120_000));
  assert.ok(needsErrors({ ...needs.envelope.report, shortMessage: "not permitted" }, command).length);
  const cleared = await createCheckinNeeds(command, help.envelope.report, { categories: [] }, identity, needs.envelope.report, now + 2);
  assert.equal(cleared.envelope.report.extensions.coluvi.revision, 1);
  assert.equal(cleared.envelope.report.extensions.coluvi.peopleAffected, null);
});

test("out-of-order same-clock states and needs survive restart, never multiply counts, and stay private", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coluvi-updates-"));
  const path = join(directory, "test.sqlite");
  let store = new ColuviStore(path, [authority]);
  try {
    const identity = await createBrowserIdentity(); store.enroll(identity.publicKey, "north", now); store.issue(command, now);
    const help = await createCheckinResponse(command, "NEEDS_HELP", identity, now + 1);
    const detail = await createCheckinNeeds(command, help.envelope.report, { categories: ["WATER", "TRANSPORT"], peopleAffected: 3 }, identity, null, now + 2);
    store.acceptResponse(detail.envelope, now + 3);
    let view = store.projection(command.eventId, now + 3);
    assert.equal(view.counts.responded, 0); assert.equal(view.needsCounts.WATER, 0); assert.equal(view.recipients[0].needs, null);
    assert.equal(view.recipients[0].needsHistory[0].applies, false);
    store.acceptResponse(help.envelope, now + 4);
    view = store.projection(command.eventId, now + 4);
    assert.equal(view.counts.responded, 1); assert.equal(view.needsCounts.WATER, 1); assert.equal(view.recipients[0].needs?.peopleAffected, 3);
    const revised = await createCheckinNeeds(command, help.envelope.report, { categories: ["FOOD"] }, identity, detail.envelope.report, now + 2);
    store.acceptResponse(revised.envelope, now + 5);
    store.acceptResponse(detail.envelope, now + 5);
    view = store.projection(command.eventId, now + 5);
    assert.equal(view.needsCounts.WATER, 0); assert.equal(view.needsCounts.FOOD, 1); assert.equal(view.recipients[0].needs?.peopleAffected, null);
    assert.equal(view.recipients[0].needsHistory[1].link, "LINKED");
    const safe = await createCheckinUpdate(command, "SAFE", identity, help.envelope.report, now + 1);
    store.acceptResponse(safe.envelope, now + 6);
    view = store.projection(command.eventId, now + 6);
    assert.equal(view.counts.safe, 1); assert.equal(view.counts.needsHelp, 0); assert.equal(view.counts.requested, 1);
    assert.equal(view.needsCounts.FOOD, 0); assert.equal(view.recipients[0].needs, null);
    assert.equal(view.recipients[0].history[1].link, "LINKED");
    const helpAgain = await createCheckinUpdate(command, "NEEDS_HELP", identity, safe.envelope.report, now + 70_000);
    store.acceptResponse(helpAgain.envelope, now + 70_001);
    view = store.projection(command.eventId, now + 70_001);
    assert.equal(view.counts.needsHelp, 1); assert.equal(view.counts.late, 1); assert.equal(view.recipients[0].needs, null);
    assert.equal(view.recipients[0].history.length, 3);
    store.close(); store = new ColuviStore(path, [authority]);
    assert.deepEqual(store.projection(command.eventId, now + 70_001), view);
    assert.equal(store.acceptResponse(revised.envelope, now + 70_002).status, "DUPLICATE");
    assert.deepEqual(aggregateReports([command, help.envelope.report, detail.envelope.report, revised.envelope.report, safe.envelope.report, helpAgain.envelope.report], PUBLIC_AGGREGATION_POLICY, now + 70_002).areas, []);
    assert.equal(store.prune(now + 120_000, 0), 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("late first response resolves UNKNOWN; missing links are visible and another device cannot attach needs", async () => {
  const store = new ColuviStore(":memory:", [authority]);
  try {
    const a = await createBrowserIdentity(); const b = await createBrowserIdentity();
    store.enroll(a.publicKey, "north", now); store.enroll(b.publicKey, "north", now); store.issue(command, now);
    assert.equal(store.projection(command.eventId, now + 60_000).counts.unknown, 2);
    const first = await createCheckinUpdate(command, "NEEDS_HELP", a, null, now + 70_000);
    const update = await createCheckinUpdate(command, "SAFE", a, first.envelope.report, now + 70_001);
    store.acceptResponse(update.envelope, now + 70_002);
    let view = store.projection(command.eventId, now + 70_002);
    assert.equal(view.counts.unknown, 1); assert.equal(view.counts.safe, 1);
    assert.equal(view.recipients.find(row => row.deviceId === a.anonymousDeviceId)?.history[0].link, "MISSING");
    store.acceptResponse(first.envelope, now + 70_003);
    view = store.projection(command.eventId, now + 70_003);
    assert.equal(view.counts.safe, 1);
    assert.equal(view.recipients.find(row => row.deviceId === a.anonymousDeviceId)?.history[1].link, "LINKED");
    const detail = await createCheckinNeeds(command, first.envelope.report, { categories: ["WATER"] }, a, null, now + 70_001);
    const forged = await signColuviBrowserReport({ ...detail.envelope.report, anonymousDeviceId: b.anonymousDeviceId }, b);
    store.acceptResponse({ ...detail.envelope, report: forged }, now + 70_004);
    assert.equal(store.projection(command.eventId, now + 70_004).needsCounts.WATER, 0);
    const changed = { ...detail.envelope.report, eventId: "tampered" };
    assert.throws(() => store.acceptResponse({ ...detail.envelope, report: changed }, now + 70_004), /unauthorized/);
    store.revokeParticipant(a.anonymousDeviceId, now + 70_005);
    assert.throws(() => store.acceptResponse(detail.envelope, now + 70_006), /recipient/);
  } finally { store.close(); }
});

test("needs revisions arriving backwards retain one current detail and global counts across pagination", async () => {
  const store = new ColuviStore(":memory:", [authority]);
  try {
    const a = await createBrowserIdentity(); const b = await createBrowserIdentity();
    store.enroll(a.publicKey, "north", now); store.enroll(b.publicKey, "north", now); store.issue(command, now);
    for (const identity of [a, b]) {
      const help = await createCheckinResponse(command, "NEEDS_HELP", identity, now + 1); store.acceptResponse(help.envelope, now + 2);
      const first = await createCheckinNeeds(command, help.envelope.report, { categories: ["WATER"], peopleAffected: 5 }, identity, null, now + 3);
      const next = await createCheckinNeeds(command, help.envelope.report, { categories: ["FOOD"], peopleAffected: 5 }, identity, first.envelope.report, now + 3);
      store.acceptResponse(next.envelope, now + 4);
      assert.equal(store.projection(command.eventId, now + 4).recipients.find(row => row.deviceId === identity.anonymousDeviceId)?.needsHistory[0].link, "MISSING");
      store.acceptResponse(first.envelope, now + 5);
    }
    const page = store.projection(command.eventId, now + 6, 0, 1);
    assert.equal(page.counts.responded, 2); assert.equal(page.needsCounts.FOOD, 2); assert.equal(page.needsCounts.WATER, 0);
    assert.equal(page.recipients.length, 1); assert.equal(page.pagination.hasMore, true);
    assert.deepEqual(page.recipients[0].needsHistory.map(row => row.applies), [false, true]);
    assert.deepEqual(page.recipients[0].needsHistory.map(row => row.link), ["ROOT", "LINKED"]);
    assert.equal(Object.hasOwn(page, "peopleAffected"), false);
    const beyond = store.projection(command.eventId, now + 6, 2, 1); assert.deepEqual(beyond.needsCounts, page.needsCounts); assert.equal(beyond.recipients.length, 0);
  } finally { store.close(); }
});

test("needs history bounds writes, preserves duplicate ACKs, rejects conflicts and closes at expiry", async () => {
  const store = new ColuviStore(":memory:", [authority]);
  try {
    const identity = await createBrowserIdentity(); store.enroll(identity.publicKey, "north", now); store.issue(command, now);
    const help = await createCheckinResponse(command, "NEEDS_HELP", identity, now + 1); store.acceptResponse(help.envelope, now + 2);
    let previous = null; let item;
    for (let index = 0; index < 100; index++) {
      item = await createCheckinNeeds(command, help.envelope.report, { categories: [index % 2 ? "FOOD" : "WATER"] }, identity, previous, now + index + 3);
      store.acceptResponse(item.envelope, now + 200); previous = item.envelope.report;
    }
    assert.equal(store.acceptResponse(item.envelope, now + 201).status, "DUPLICATE");
    assert.equal(store.projection(command.eventId, now + 201).needsCounts.FOOD, 1);
    const extra = await createCheckinNeeds(command, help.envelope.report, { categories: [] }, identity, null, now + 202);
    assert.throws(() => store.acceptResponse(extra.envelope, now + 203), /capacity/);
    await assert.rejects(createCheckinNeeds(command, help.envelope.report, { categories: [] }, identity, previous, now + 202));
    assert.throws(() => store.acceptResponse(item.envelope, now + 120_000), /expired/);
    const conflict = await signColuviBrowserReport({ ...item.envelope.report, extensions: { coluvi: { ...item.envelope.report.extensions.coluvi, categories: ["SHELTER"] } } }, identity);
    assert.throws(() => store.acceptResponse({ ...item.envelope, report: conflict }, now + 204), /conflict/);
  } finally { store.close(); }
});
