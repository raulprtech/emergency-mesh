import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDeviceIdentity } from "../src/protocol/identity.ts";
import { createBrowserIdentity } from "../src/mobile-client/crypto.js";
import { authorityFor } from "../src/commands/authority.ts";
import { ColuviStore } from "../src/commands/store.ts";

test("participant credentials survive restart, rotate, expire and honor participant revocation", async () => {
  const directory = mkdtempSync("/tmp/coluvi-credential-"); const path = join(directory, "pilot.sqlite"); const now = 1_800_000_000_000;
  const authority = authorityFor(createDeviceIdentity(), ["north"]);
  let store = new ColuviStore(path, [authority]);
  try {
    const identity = await createBrowserIdentity(); store.enroll(identity.publicKey, "north", now);
    const first = store.grantCredential(identity.anonymousDeviceId, now);
    assert.equal(store.authenticateCredential(`Bearer ${first.token}`, now)?.device_id, identity.anonymousDeviceId);
    assert.equal(store.authenticateCredential(`Bearer ${first.token}`, first.expiresAt), undefined);
    assert.equal(store.authenticateCredential("Bearer bad", now), undefined);
    store.close(); store = new ColuviStore(path, [authority]);
    assert.equal(store.authenticateCredential(`Bearer ${first.token}`, now)?.device_id, identity.anonymousDeviceId);
    const rotated = store.grantCredential(identity.anonymousDeviceId, now + 1);
    assert.equal(store.authenticateCredential(`Bearer ${first.token}`, now + 1), undefined);
    assert.equal(store.authenticateCredential(`Bearer ${rotated.token}`, now + 1)?.device_id, identity.anonymousDeviceId);
    store.revokeParticipant(identity.anonymousDeviceId, now + 2);
    assert.equal(store.authenticateCredential(`Bearer ${rotated.token}`, now + 2), undefined);
    assert.throws(() => store.grantCredential(identity.anonymousDeviceId, now + 2), /participant/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
