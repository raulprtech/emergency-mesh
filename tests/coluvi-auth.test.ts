import assert from "node:assert/strict";
import test from "node:test";
import { sign } from "node:crypto";
import { ColuviAuth, enrollmentCodeHash, enrollmentProofBytes, passwordVerifier } from "../src/commands/auth.ts";
import { createDeviceIdentityFromSeed } from "../src/protocol/identity.ts";

const now = 1_800_000_000_000;
const password = "fictional-test-password-not-for-pilot";
const code = "fictional-enrollment-code-not-for-pilot";
const verifier = await passwordVerifier(password, "00112233445566778899aabbccddeeff");
const identity = createDeviceIdentityFromSeed(new Uint8Array(32).fill(4));
const publicKey = identity.publicKey.export({ type: "spki", format: "der" }).toString("base64url");

test("operator sessions require password, expire, resist duplicate cookies, isolate CSRF and logout", async () => {
  const auth = new ColuviAuth(verifier, enrollmentCodeHash(code), 1_000);
  assert.equal(await auth.login("a-different-password-here", "loopback", now), undefined);
  const login = await auth.login(password, "loopback", now); assert.ok(login);
  const cookie = `other=value; coluvi_operator=${login.token}`;
  assert.deepEqual(auth.session(cookie, now), login.session);
  assert.equal(auth.session(undefined, now), undefined);
  assert.equal(auth.session(`${cookie}; coluvi_operator=${login.token}`, now), undefined);
  assert.equal(auth.csrfValid(cookie, login.session.csrf, now), true);
  assert.equal(auth.csrfValid(cookie, "different", now), false);
  assert.equal(auth.session(cookie, now + 1_000), undefined);
  const again = await auth.login(password, "loopback", now + 2_000); assert.ok(again);
  auth.logout(`coluvi_operator=${again.token}`);
  assert.equal(auth.session(`coluvi_operator=${again.token}`, now + 2_000), undefined);
  assert.equal(new ColuviAuth(verifier, enrollmentCodeHash(code)).session(cookie, now), undefined);
});

test("operator password guesses have fixed-window per-source and global limits", async () => {
  const auth = new ColuviAuth(verifier, enrollmentCodeHash(code));
  for (let i = 0; i < 5; i += 1) assert.equal(await auth.login("bad", "source-a", now), undefined);
  await assert.rejects(auth.login(password, "source-a", now), /rate limited/);
  assert.ok(await auth.login(password, "source-b", now));
  assert.ok(await auth.login(password, "source-a", now + 60_000));
  for (let i = 0; i < 20; i += 1) await auth.login("bad", `source-${i}`, now + 120_000);
  await assert.rejects(auth.login(password, "source-new", now + 120_000), /rate limited/);
});

test("enrollment requires code, authorized zone and proof of possession with one-use challenge", () => {
  const auth = new ColuviAuth(verifier, enrollmentCodeHash(code));
  assert.throws(() => auth.challenge("wrong", publicKey, "north", ["north"], "source", now), /authorized/);
  assert.throws(() => auth.challenge(code, publicKey, "south", ["north"], "source", now), /scope/);
  const challenge = auth.challenge(code, publicKey, "north", ["north"], "source", now);
  const proof = sign(null, enrollmentProofBytes(challenge), identity.privateKey).toString("base64url");
  assert.deepEqual(auth.complete(challenge.challengeId, proof, now), challenge);
  assert.throws(() => auth.complete(challenge.challengeId, proof, now), /expired/);
  const another = auth.challenge(code, publicKey, "north", ["north"], "source", now);
  assert.throws(() => auth.complete(another.challengeId, proof, now), /proof/);
  const altered = auth.challenge(code, publicKey, "north", ["north"], "source", now);
  const wrongScopeProof = sign(null, enrollmentProofBytes({ ...altered, zoneId: "south" }), identity.privateKey).toString("base64url");
  assert.throws(() => auth.complete(altered.challengeId, wrongScopeProof, now), /proof/);
  const expired = auth.challenge(code, publicKey, "north", ["north"], "source", now);
  assert.throws(() => auth.complete(expired.challengeId, sign(null, enrollmentProofBytes(expired), identity.privateKey).toString("base64url"), now + 120_000), /expired/);
});

test("password and authentication configuration reject weak or malformed values", async () => {
  await assert.rejects(passwordVerifier("weak"));
  await assert.rejects(passwordVerifier(password, "bad"));
  assert.throws(() => new ColuviAuth({ salt: "bad", hash: "bad" }, "bad"));
  assert.throws(() => new ColuviAuth(verifier, enrollmentCodeHash(code), 0));
});
