import assert from "node:assert/strict";
import test from "node:test";
import { IngestAdmissionController } from "../src/backend/admission.ts";

test("global admission limits malformed traffic before decode work", () => {
  const admission = new IngestAdmissionController({ windowMs: 1_000, maximumGlobalRequests: 2 });
  assert.deepEqual(admission.admitRequest(10_000), { allowed: true });
  assert.deepEqual(admission.admitRequest(10_001), { allowed: true });
  assert.deepEqual(admission.admitRequest(10_002), { allowed: false, scope: "GLOBAL", retryAfterMs: 998 });
  assert.deepEqual(admission.admitRequest(11_000), { allowed: true });
});

test("identity admission is isolated and resets only after its fixed window", () => {
  const admission = new IngestAdmissionController({ windowMs: 500, maximumRequestsPerIdentity: 1 });
  assert.deepEqual(admission.admitIdentity("device-a", 20_000), { allowed: true });
  assert.deepEqual(admission.admitIdentity("device-b", 20_001), { allowed: true });
  assert.deepEqual(admission.admitIdentity("device-a", 20_100), { allowed: false, scope: "IDENTITY", retryAfterMs: 400 });
  assert.deepEqual(admission.admitIdentity("device-a", 20_500), { allowed: true });
});

test("identity tracking fails closed at capacity and releases expired keys", () => {
  const admission = new IngestAdmissionController({ windowMs: 1_000, maximumTrackedIdentities: 2 });
  admission.admitIdentity("device-a", 30_000);
  admission.admitIdentity("device-b", 30_100);
  assert.deepEqual(admission.admitIdentity("device-c", 30_200), { allowed: false, scope: "IDENTITY_CAPACITY", retryAfterMs: 800 });
  assert.equal(admission.trackedIdentities(), 2);
  assert.deepEqual(admission.admitIdentity("device-c", 31_000), { allowed: true });
  assert.equal(admission.trackedIdentities(), 2);
});

test("admission configuration and inputs fail closed", () => {
  assert.throws(() => new IngestAdmissionController({ windowMs: 0 }), /windowMs/);
  assert.throws(() => new IngestAdmissionController({ maximumGlobalRequests: 1.5 }), /maximumGlobalRequests/);
  const admission = new IngestAdmissionController();
  assert.throws(() => admission.admitRequest(-1), /now/);
  assert.throws(() => admission.admitIdentity("", 1), /identity/);
});
