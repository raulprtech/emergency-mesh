import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { decodeCbor, encodeCbor } from "./cbor.ts";
import type { EmergencyReport } from "./types.ts";

export const PROTECTED_PAYLOAD_PREFIX = "emesh-protected-v1:";
export const PROTECTED_PAYLOAD_SUITE = "X25519-HKDF-SHA256+A256GCM";
export const MAX_PROTECTED_PLAINTEXT_BYTES = 8_192;
export const MAX_PROTECTED_RECIPIENTS = 8;
export const MAX_PROTECTED_PAYLOAD_BYTES = 32_768;

const CONTENT_DOMAIN = "emergency-mesh/protected-payload/v1/content";
const WRAP_DOMAIN = "emergency-mesh/protected-payload/v1/key-wrap";

export interface ProtectedPayloadContext {
  protocolVersion: string;
  eventId: string;
  anonymousDeviceId: string;
  createdAt: number;
  validUntil: number;
}

export interface ProtectedRecipientPublic {
  recipientId: string;
  publicKey: string;
  status?: "ACTIVE" | "RETIRED" | "REVOKED";
  notBefore?: number;
  notAfter?: number;
  purpose?: string;
}

export interface ProtectedRecipientPrivate extends ProtectedRecipientPublic {
  privateKey: string;
}

interface SealedRecipient {
  r: string;
  n: Uint8Array;
  k: Uint8Array;
}

interface SealedContainer {
  v: number;
  s: string;
  e: Uint8Array;
  n: Uint8Array;
  c: Uint8Array;
  w: SealedRecipient[];
}

function publicDer(key: KeyObject): Buffer {
  if (key.asymmetricKeyType !== "x25519") throw new Error("Recipient key must be X25519");
  return key.export({ type: "spki", format: "der" });
}

function privateDer(key: KeyObject): Buffer {
  if (key.asymmetricKeyType !== "x25519") throw new Error("Recipient key must be X25519");
  return key.export({ type: "pkcs8", format: "der" });
}

function importPublic(value: string | Uint8Array): KeyObject {
  return createPublicKey({ key: typeof value === "string" ? Buffer.from(value, "base64url") : Buffer.from(value), type: "spki", format: "der" });
}

function importPrivate(value: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(value, "base64url"), type: "pkcs8", format: "der" });
}

export function protectedRecipientId(publicKey: string | Uint8Array): string {
  const der = publicDer(importPublic(publicKey));
  return `x25519:${createHash("sha256").update(der).digest("base64url").slice(0, 22)}`;
}

export function createProtectedRecipientKeyPair(purpose?: string): ProtectedRecipientPrivate {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const encodedPublic = publicDer(publicKey).toString("base64url");
  return {
    recipientId: protectedRecipientId(encodedPublic),
    publicKey: encodedPublic,
    privateKey: privateDer(privateKey).toString("base64url"),
    status: "ACTIVE",
    purpose,
  };
}

export function protectedPayloadContext(report: Pick<EmergencyReport, "protocolVersion" | "eventId" | "anonymousDeviceId" | "createdAt" | "validUntil">): ProtectedPayloadContext {
  return {
    protocolVersion: report.protocolVersion,
    eventId: report.eventId,
    anonymousDeviceId: report.anonymousDeviceId,
    createdAt: report.createdAt,
    validUntil: report.validUntil,
  };
}

export function validateProtectedRecipients(recipients: ProtectedRecipientPublic[], now = Date.now()): string[] {
  const errors: string[] = [];
  if (!recipients.length) errors.push("at least one protected-payload recipient is required");
  if (recipients.length > MAX_PROTECTED_RECIPIENTS) errors.push(`protected payload supports at most ${MAX_PROTECTED_RECIPIENTS} recipients`);
  const ids = new Set<string>();
  for (const recipient of recipients) {
    if (ids.has(recipient.recipientId)) errors.push(`duplicate protected-payload recipient: ${recipient.recipientId}`);
    ids.add(recipient.recipientId);
    if ((recipient.status ?? "ACTIVE") !== "ACTIVE") errors.push(`protected-payload recipient is not active: ${recipient.recipientId}`);
    if (recipient.notBefore !== undefined && now < recipient.notBefore) errors.push(`protected-payload recipient is not active yet: ${recipient.recipientId}`);
    if (recipient.notAfter !== undefined && now >= recipient.notAfter) errors.push(`protected-payload recipient has expired: ${recipient.recipientId}`);
    try {
      if (protectedRecipientId(recipient.publicKey) !== recipient.recipientId) errors.push(`protected-payload recipient id does not match public key: ${recipient.recipientId}`);
    } catch {
      errors.push(`invalid protected-payload public key: ${recipient.recipientId}`);
    }
  }
  return errors;
}

function contentAad(context: ProtectedPayloadContext): Uint8Array {
  return encodeCbor({ d: CONTENT_DOMAIN, c: context });
}

function wrapAad(context: ProtectedPayloadContext, recipientId: string, ephemeralPublicKey: Uint8Array): Uint8Array {
  return encodeCbor({ d: WRAP_DOMAIN, c: context, r: recipientId, e: ephemeralPublicKey });
}

function wrappingKey(sharedSecret: Uint8Array, aad: Uint8Array, recipientId: string): Buffer {
  const salt = createHash("sha256").update(aad).digest();
  return Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${WRAP_DOMAIN}/${recipientId}`), 32));
}

function encryptAesGcm(plaintext: Uint8Array, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function decryptAesGcm(ciphertextAndTag: Uint8Array, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array): Uint8Array {
  if (ciphertextAndTag.length < 16) throw new Error("Protected payload ciphertext is truncated");
  const ciphertext = ciphertextAndTag.subarray(0, -16);
  const tag = ciphertextAndTag.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function requireBytes(value: unknown, size: number | undefined, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || (size !== undefined && value.length !== size)) throw new Error(`Invalid protected payload ${field}`);
  return value;
}

function decodeContainer(payload: string): SealedContainer {
  if (!payload.startsWith(PROTECTED_PAYLOAD_PREFIX)) throw new Error("Unsupported protected payload format");
  if (Buffer.byteLength(payload, "utf8") > MAX_PROTECTED_PAYLOAD_BYTES) throw new Error("Protected payload exceeds size limit");
  const encoded = payload.slice(PROTECTED_PAYLOAD_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Malformed protected payload encoding");
  const raw = Buffer.from(encoded, "base64url");
  if (raw.toString("base64url") !== encoded) throw new Error("Non-canonical protected payload encoding");
  let decoded: unknown;
  try { decoded = decodeCbor(raw); }
  catch { throw new Error("Malformed protected payload"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Malformed protected payload");
  const value = decoded as Record<string, unknown>;
  if (value.v !== 1 || value.s !== PROTECTED_PAYLOAD_SUITE || !Array.isArray(value.w) || value.w.length < 1 || value.w.length > MAX_PROTECTED_RECIPIENTS) {
    throw new Error("Unsupported protected payload parameters");
  }
  const recipients = value.w.map((entry): SealedRecipient => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Malformed protected payload recipient");
    const item = entry as Record<string, unknown>;
    if (typeof item.r !== "string" || !/^x25519:[A-Za-z0-9_-]{22}$/.test(item.r)) throw new Error("Malformed protected payload recipient id");
    return { r: item.r, n: requireBytes(item.n, 12, "wrap nonce"), k: requireBytes(item.k, 48, "wrapped key") };
  });
  if (new Set(recipients.map((entry) => entry.r)).size !== recipients.length) throw new Error("Duplicate protected payload recipient");
  const ephemeralKey = requireBytes(value.e, undefined, "ephemeral key");
  try { publicDer(importPublic(ephemeralKey)); } catch { throw new Error("Invalid protected payload ephemeral key"); }
  const ciphertext = requireBytes(value.c, undefined, "ciphertext");
  if (ciphertext.length < 16 || ciphertext.length > MAX_PROTECTED_PLAINTEXT_BYTES + 16) throw new Error("Invalid protected payload ciphertext size");
  return {
    v: 1,
    s: PROTECTED_PAYLOAD_SUITE,
    e: ephemeralKey,
    n: requireBytes(value.n, 12, "content nonce"),
    c: ciphertext,
    w: recipients,
  };
}

export function validateProtectedPayloadFormat(payload: string): string[] {
  try { decodeContainer(payload); return []; }
  catch (error) { return [error instanceof Error ? error.message : "Invalid protected payload"]; }
}

export function sealProtectedPayload(
  data: Record<string, unknown>,
  context: ProtectedPayloadContext,
  recipients: ProtectedRecipientPublic[],
  now = Date.now(),
  random = randomBytes,
): string {
  const errors = validateProtectedRecipients(recipients, now);
  if (errors.length) throw new Error(errors.join("; "));
  const plaintext = encodeCbor(data);
  if (plaintext.length > MAX_PROTECTED_PLAINTEXT_BYTES) throw new Error(`Protected plaintext exceeds ${MAX_PROTECTED_PLAINTEXT_BYTES} bytes`);
  const { publicKey: ephemeralPublic, privateKey: ephemeralPrivate } = generateKeyPairSync("x25519");
  const ephemeralDer = publicDer(ephemeralPublic);
  const key = random(32);
  const nonce = random(12);
  if (key.length !== 32 || nonce.length !== 12) throw new Error("Invalid protected-payload random source");
  const aad = contentAad(context);
  let ciphertext: Uint8Array;
  let wrapped: SealedRecipient[];
  try {
    ciphertext = encryptAesGcm(plaintext, key, nonce, aad);
    wrapped = [...recipients].sort((left, right) => left.recipientId.localeCompare(right.recipientId)).map((recipient): SealedRecipient => {
      const shared = diffieHellman({ privateKey: ephemeralPrivate, publicKey: importPublic(recipient.publicKey) });
      const recipientAad = wrapAad(context, recipient.recipientId, ephemeralDer);
      const wrapKey = wrappingKey(shared, recipientAad, recipient.recipientId);
      try {
        const wrapNonce = random(12);
        if (wrapNonce.length !== 12) throw new Error("Invalid protected-payload random source");
        return { r: recipient.recipientId, n: wrapNonce, k: encryptAesGcm(key, wrapKey, wrapNonce, recipientAad) };
      } finally { shared.fill(0); wrapKey.fill(0); }
    });
  } finally { key.fill(0); }
  const container: SealedContainer = { v: 1, s: PROTECTED_PAYLOAD_SUITE, e: ephemeralDer, n: nonce, c: ciphertext, w: wrapped };
  const payload = PROTECTED_PAYLOAD_PREFIX + Buffer.from(encodeCbor(container)).toString("base64url");
  if (Buffer.byteLength(payload, "utf8") > MAX_PROTECTED_PAYLOAD_BYTES) throw new Error("Protected payload exceeds size limit");
  return payload;
}

export function openProtectedPayload(
  payload: string,
  context: ProtectedPayloadContext,
  recipient: ProtectedRecipientPrivate,
): unknown {
  if (protectedRecipientId(recipient.publicKey) !== recipient.recipientId) throw new Error("Protected recipient id does not match public key");
  const privateKey = importPrivate(recipient.privateKey);
  if (!createPublicKey(privateKey).equals(importPublic(recipient.publicKey))) throw new Error("Protected recipient private key does not match public key");
  const container = decodeContainer(payload);
  const entry = container.w.find((candidate) => candidate.r === recipient.recipientId);
  if (!entry) throw new Error("Recipient is not authorized for this protected payload");
  try {
    const ephemeralPublic = importPublic(container.e);
    const shared = diffieHellman({ privateKey, publicKey: ephemeralPublic });
    const recipientAad = wrapAad(context, recipient.recipientId, container.e);
    const wrapKey = wrappingKey(shared, recipientAad, recipient.recipientId);
    try {
      const key = decryptAesGcm(entry.k, wrapKey, entry.n, recipientAad);
      if (key.length !== 32) throw new Error("Invalid protected content key");
      try { return decodeCbor(decryptAesGcm(container.c, key, container.n, contentAad(context))); }
      finally { key.fill(0); }
    } finally { shared.fill(0); wrapKey.fill(0); }
  } catch {
    throw new Error("Protected payload authentication failed");
  }
}
