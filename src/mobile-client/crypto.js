const concat = (chunks) => {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
};

function head(major, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("CBOR integer out of range");
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value <= 0xff) return Uint8Array.of((major << 5) | 24, value);
  if (value <= 0xffff) return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  if (value <= 0xffffffff) {
    const bytes = new Uint8Array(5); bytes[0] = (major << 5) | 26;
    new DataView(bytes.buffer).setUint32(1, value); return bytes;
  }
  const bytes = new Uint8Array(9); bytes[0] = (major << 5) | 27;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(value)); return bytes;
}

const compareBytes = (left, right) => {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
};

/** Browser-compatible deterministic CBOR for protocol values. */
export function canonicalCbor(value) {
  if (value === null) return Uint8Array.of(0xf6);
  if (value === false) return Uint8Array.of(0xf4);
  if (value === true) return Uint8Array.of(0xf5);
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
    const bytes = new Uint8Array(9); bytes[0] = 0xfb; new DataView(bytes.buffer).setFloat64(1, value); return bytes;
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value); return concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return concat([head(2, value.length), value]);
  if (Array.isArray(value)) return concat([head(4, value.length), ...value.map(canonicalCbor)]);
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => [canonicalCbor(key), canonicalCbor(item)])
      .sort(([left], [right]) => compareBytes(left, right));
    return concat([head(5, entries.length), ...entries.flat()]);
  }
  throw new Error(`Unsupported CBOR value: ${typeof value}`);
}

export function canonicalReportBytes(report) {
  const { signature: _signature, ...unsigned } = report;
  return canonicalCbor(unsigned);
}

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

export async function createBrowserIdentity(webCrypto = globalThis.crypto) {
  const keyPair = await webCrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await webCrypto.subtle.exportKey("spki", keyPair.publicKey));
  const digest = new Uint8Array(await webCrypto.subtle.digest("SHA-256", publicKey));
  return {
    mode: "ED25519",
    anonymousDeviceId: base64Url(digest).slice(0, 22),
    publicKey: base64Url(publicKey),
    privateKeyJwk: await webCrypto.subtle.exportKey("jwk", keyPair.privateKey),
  };
}

export function createUnsignedIdentity(webCrypto = globalThis.crypto) {
  return { mode: "UNSIGNED", anonymousDeviceId: `unsigned-${webCrypto.randomUUID()}` };
}

export async function signBrowserReport(report, identity, webCrypto = globalThis.crypto) {
  if (identity.mode !== "ED25519") return { ...report };
  if (report.anonymousDeviceId !== identity.anonymousDeviceId) throw new Error("Identity does not match report pseudonym");
  const privateKey = await webCrypto.subtle.importKey("jwk", identity.privateKeyJwk, { name: "Ed25519" }, false, ["sign"]);
  const signature = new Uint8Array(await webCrypto.subtle.sign("Ed25519", privateKey, canonicalReportBytes(report)));
  return { ...report, signature: { algorithm: "Ed25519", publicKey: identity.publicKey, value: base64Url(signature) } };
}

export async function verifyBrowserReport(report, webCrypto = globalThis.crypto) {
  if (!report.signature || report.signature.algorithm !== "Ed25519") return false;
  const publicBytes = fromBase64Url(report.signature.publicKey);
  const digest = new Uint8Array(await webCrypto.subtle.digest("SHA-256", publicBytes));
  if (base64Url(digest).slice(0, 22) !== report.anonymousDeviceId) return false;
  const publicKey = await webCrypto.subtle.importKey("spki", publicBytes, { name: "Ed25519" }, false, ["verify"]);
  return webCrypto.subtle.verify("Ed25519", publicKey, fromBase64Url(report.signature.value), canonicalReportBytes(report));
}
