import { canonicalCbor } from "./crypto.js";

export const PROTECTED_PAYLOAD_PREFIX = "emesh-protected-v1:";
export const PROTECTED_PAYLOAD_SUITE = "X25519-HKDF-SHA256+A256GCM";
export const MAX_PROTECTED_PLAINTEXT_BYTES = 8_192;
export const MAX_PROTECTED_RECIPIENTS = 8;
export const MAX_PROTECTED_PAYLOAD_BYTES = 32_768;

const CONTENT_DOMAIN = "emergency-mesh/protected-payload/v1/content";
const WRAP_DOMAIN = "emergency-mesh/protected-payload/v1/key-wrap";

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function contentAad(context) { return canonicalCbor({ d: CONTENT_DOMAIN, c: context }); }
function wrapAad(context, recipientId, ephemeralPublicKey) { return canonicalCbor({ d: WRAP_DOMAIN, c: context, r: recipientId, e: ephemeralPublicKey }); }

async function recipientId(publicKey, webCrypto) {
  const digest = new Uint8Array(await webCrypto.subtle.digest("SHA-256", publicKey));
  return `x25519:${base64Url(digest).slice(0, 22)}`;
}

async function wrappingKey(sharedSecret, aad, id, webCrypto) {
  const salt = await webCrypto.subtle.digest("SHA-256", aad);
  const material = await webCrypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await webCrypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(`${WRAP_DOMAIN}/${id}`),
  }, material, 256));
}

async function encryptAesGcm(plaintext, keyBytes, nonce, aad, webCrypto) {
  const key = await webCrypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(await webCrypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext));
}

function randomBytes(size, webCrypto) {
  const bytes = new Uint8Array(size);
  webCrypto.getRandomValues(bytes);
  return bytes;
}

export async function validateBrowserProtectedRecipients(recipients, now = Date.now(), webCrypto = globalThis.crypto) {
  const errors = [];
  if (!recipients.length) errors.push("at least one protected-payload recipient is required");
  if (recipients.length > MAX_PROTECTED_RECIPIENTS) errors.push(`protected payload supports at most ${MAX_PROTECTED_RECIPIENTS} recipients`);
  const ids = new Set();
  for (const recipient of recipients) {
    if (ids.has(recipient.recipientId)) errors.push(`duplicate protected-payload recipient: ${recipient.recipientId}`);
    ids.add(recipient.recipientId);
    if ((recipient.status ?? "ACTIVE") !== "ACTIVE") errors.push(`protected-payload recipient is not active: ${recipient.recipientId}`);
    if (recipient.notBefore !== undefined && now < recipient.notBefore) errors.push(`protected-payload recipient is not active yet: ${recipient.recipientId}`);
    if (recipient.notAfter !== undefined && now >= recipient.notAfter) errors.push(`protected-payload recipient has expired: ${recipient.recipientId}`);
    try {
      const publicBytes = fromBase64Url(recipient.publicKey);
      await webCrypto.subtle.importKey("spki", publicBytes, { name: "X25519" }, false, []);
      if (await recipientId(publicBytes, webCrypto) !== recipient.recipientId) errors.push(`protected-payload recipient id does not match public key: ${recipient.recipientId}`);
    } catch {
      errors.push(`invalid protected-payload public key: ${recipient.recipientId}`);
    }
  }
  return errors;
}

export async function sealBrowserProtectedPayload(data, context, recipients, now = Date.now(), webCrypto = globalThis.crypto) {
  const errors = await validateBrowserProtectedRecipients(recipients, now, webCrypto);
  if (errors.length) throw new Error(errors.join("; "));
  const plaintext = canonicalCbor(data);
  if (plaintext.length > MAX_PROTECTED_PLAINTEXT_BYTES) throw new Error(`Protected plaintext exceeds ${MAX_PROTECTED_PLAINTEXT_BYTES} bytes`);
  const ephemeral = await webCrypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const ephemeralDer = new Uint8Array(await webCrypto.subtle.exportKey("spki", ephemeral.publicKey));
  const key = randomBytes(32, webCrypto);
  const nonce = randomBytes(12, webCrypto);
  let ciphertext;
  const wrapped = [];
  try {
    ciphertext = await encryptAesGcm(plaintext, key, nonce, contentAad(context), webCrypto);
    for (const recipient of [...recipients].sort((left, right) => left.recipientId.localeCompare(right.recipientId))) {
    const publicKey = await webCrypto.subtle.importKey("spki", fromBase64Url(recipient.publicKey), { name: "X25519" }, false, []);
    const shared = new Uint8Array(await webCrypto.subtle.deriveBits({ name: "X25519", public: publicKey }, ephemeral.privateKey, 256));
    const recipientAad = wrapAad(context, recipient.recipientId, ephemeralDer);
    const wrapKey = await wrappingKey(shared, recipientAad, recipient.recipientId, webCrypto);
    try {
      const wrapNonce = randomBytes(12, webCrypto);
      wrapped.push({ r: recipient.recipientId, n: wrapNonce, k: await encryptAesGcm(key, wrapKey, wrapNonce, recipientAad, webCrypto) });
    } finally { shared.fill(0); wrapKey.fill(0); }
    }
  } finally { key.fill(0); }
  const container = { v: 1, s: PROTECTED_PAYLOAD_SUITE, e: ephemeralDer, n: nonce, c: ciphertext, w: wrapped };
  const payload = PROTECTED_PAYLOAD_PREFIX + base64Url(canonicalCbor(container));
  if (new TextEncoder().encode(payload).length > MAX_PROTECTED_PAYLOAD_BYTES) throw new Error("Protected payload exceeds size limit");
  return payload;
}
