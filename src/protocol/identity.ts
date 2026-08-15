import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { encodeCbor } from "./cbor.ts";
import type { EmergencyReport, Signature } from "./types.ts";

export interface DeviceIdentity {
  anonymousDeviceId: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export function createDeviceIdentityFromSeed(seed: Uint8Array): DeviceIdentity {
  if (seed.length !== 32) throw new Error("Ed25519 seed must contain exactly 32 bytes");
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = createPrivateKey({ key: Buffer.concat([prefix, seed]), type: "pkcs8", format: "der" });
  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const anonymousDeviceId = createHash("sha256").update(publicDer).digest("base64url").slice(0, 22);
  return { anonymousDeviceId, publicKey, privateKey };
}

export function createDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const anonymousDeviceId = createHash("sha256").update(publicDer).digest("base64url").slice(0, 22);
  return { anonymousDeviceId, publicKey, privateKey };
}

export function canonicalReportBytes(report: EmergencyReport): Uint8Array {
  const { signature: _signature, ...unsigned } = report;
  return encodeCbor(unsigned);
}

export function signReport(report: EmergencyReport, identity: DeviceIdentity): EmergencyReport {
  if (report.anonymousDeviceId !== identity.anonymousDeviceId) throw new Error("Report device id does not match signing identity");
  const publicKey = identity.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const signature: Signature = {
    algorithm: "Ed25519",
    publicKey,
    value: sign(null, canonicalReportBytes(report), identity.privateKey).toString("base64url"),
  };
  return { ...report, signature };
}

export function verifyReportSignature(report: EmergencyReport): boolean {
  if (!report.signature || report.signature.algorithm !== "Ed25519") return false;
  const publicKeyBytes = Buffer.from(report.signature.publicKey, "base64url");
  const expectedDeviceId = createHash("sha256").update(publicKeyBytes).digest("base64url").slice(0, 22);
  if (expectedDeviceId !== report.anonymousDeviceId) return false;
  return verify(
    null,
    canonicalReportBytes(report),
    { key: publicKeyBytes, type: "spki", format: "der" },
    Buffer.from(report.signature.value, "base64url"),
  );
}
