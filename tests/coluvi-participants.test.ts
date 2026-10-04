import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ColuviStore } from "../src/commands/store.ts";
import { authorityFor, createCheckinCommand } from "../src/commands/authority.ts";
import { createDeviceIdentity } from "../src/protocol/identity.ts";
import { createBrowserIdentity } from "../src/mobile-client/crypto.js";

test("participant list is scoped, paginated and credential-safe; revocation is idempotent and preserves recipients", async () => {
  const directory = mkdtempSync("/tmp/coluvi-participants-"); const path = join(directory, "test.sqlite");
  const issuer = createDeviceIdentity(); const authority = authorityFor(issuer, ["north", "south"]); const now = Date.now();
  let store = new ColuviStore(path, [authority]);
  try {
    const a = await createBrowserIdentity(); const b = await createBrowserIdentity(); const c = await createBrowserIdentity();
    store.enroll(a.publicKey, "north", now); store.enroll(b.publicKey, "north", now + 1); store.enroll(c.publicKey, "south", now + 2);
    const credential = store.grantCredential(a.anonymousDeviceId, now);
    const command = createCheckinCommand(issuer, authority, { commandId: "participant-request", nonce: "participant-nonce", incidentRef: "drill", zoneId: "north", issuedAt: now + 3, promptUntil: now + 60_000, responseUntil: now + 120_000 });
    store.issue(command, now + 3);
    const first = store.listParticipants({ zoneId: "north", limit: 1 }, now + 4);
    assert.deepEqual(first.counts, { total: 2, active: 2, revoked: 0 }); assert.equal(first.participants[0].deviceId, a.anonymousDeviceId); assert.equal(first.pagination.hasMore, true);
    assert.equal(first.participants[0].credential, "ACTIVE"); assert.equal(first.participants[0].credentialExpiresAt, credential.expiresAt);
    const next = store.listParticipants({ zoneId: "north", limit: 1, offset: 1 }, now + 4);
    assert.equal(next.participants[0].credential, "NONE"); assert.equal(next.pagination.hasMore, false);
    assert.equal(store.listParticipants({ zoneId: "north", limit: 1 }, credential.expiresAt).participants[0].credential, "EXPIRED");
    for (const secret of ["public_key", "publicKey", "token_hash", credential.token, a.publicKey]) assert.equal(JSON.stringify(first).includes(secret), false);
    assert.equal(store.revokeParticipant(a.anonymousDeviceId, now + 5), "REVOKED");
    assert.equal(store.revokeParticipant(a.anonymousDeviceId, now + 6), "ALREADY_REVOKED");
    assert.equal(store.authenticateCredential(`Bearer ${credential.token}`, now + 7), undefined);
    assert.equal(store.projection(command.eventId, now + 7).counts.requested, 2);
    const revoked = store.listParticipants({ state: "revoked" }, now + 7);
    assert.equal(revoked.pagination.total, 1); assert.equal(revoked.participants[0].revokedAt, now + 5); assert.equal(revoked.participants[0].credential, "REVOKED");
    assert.equal(revoked.participants[0].credentialExpiresAt, null);
    for (const options of [{ limit: 101 }, { offset: -1 }, { state: "unknown" }, { zoneId: "elsewhere" }]) assert.throws(() => store.listParticipants(options));
    store.close(); store = new ColuviStore(path, [{ ...authority, zones: ["north"] }]);
    assert.deepEqual(store.listParticipants({}, now + 8).counts, { total: 2, active: 1, revoked: 1 });
    assert.throws(() => store.revokeParticipant(c.anonymousDeviceId, now + 8), /authorized/);
    assert.throws(() => store.enroll(a.publicKey, "north", now + 8), /conflict/);
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM coluvi_audit WHERE action='PARTICIPANT_REVOKED'").get()?.n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM coluvi_credentials").get()?.n, 0); db.close();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
