import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { DeviceIdentity } from "../protocol/identity.ts";
import { authorityFor, authorityFingerprint, type ColuviAuthority } from "./authority.ts";
import { ColuviAuth, enrollmentCodeHash, passwordVerifier, type PasswordVerifier } from "./auth.ts";

export interface ColuviConfiguration {
  version: 1;
  origin: string;
  privateKeyPem: string;
  authority: ColuviAuthority;
  operatorPassword: PasswordVerifier;
  enrollmentHash: string;
}
export interface LoadedColuviConfiguration { origin: string; identity: DeviceIdentity; authority: ColuviAuthority; auth: ColuviAuth; }

export function validatePilotOrigin(origin: unknown): string {
  if (typeof origin !== "string" || origin.length > 200) throw new Error("Invalid Coluvi origin");
  const url = new URL(origin);
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname);
  if (url.origin !== origin || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new Error("Coluvi requires HTTPS or an explicit loopback development origin");
  return origin;
}

export async function createColuviConfiguration(identity: DeviceIdentity, origin: string, zones: string[]) {
  validatePilotOrigin(origin);
  if (!Array.isArray(zones) || zones.length < 1 || zones.length > 20 || new Set(zones).size !== zones.length
    || zones.some((zone) => !/^[A-Za-z0-9_-]{1,80}$/.test(zone))) throw new Error("Invalid pilot zones");
  const operatorPassword = randomBytes(24).toString("base64url");
  const enrollmentCode = randomBytes(24).toString("base64url");
  const authority = authorityFor(identity, zones);
  const configuration: ColuviConfiguration = {
    version: 1, origin, privateKeyPem: identity.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), authority,
    operatorPassword: await passwordVerifier(operatorPassword), enrollmentHash: enrollmentCodeHash(enrollmentCode),
  };
  const mobileTrust = { version: 1, origin, authorities: [authority], fingerprint: authorityFingerprint(authority) };
  return { configuration, mobileTrust, operatorPassword, enrollmentCode };
}

export function loadColuviConfiguration(path: string, host: string, tlsEnabled: boolean): LoadedColuviConfiguration {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > 32_768 || (file.mode & 0o077) !== 0
    || (process.getuid && file.uid !== process.getuid())) throw new Error("Coluvi config must be an owned private regular file (0600)");
  let config: ColuviConfiguration;
  try { config = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Invalid Coluvi configuration JSON"); }
  if (config.version !== 1) throw new Error("Unsupported Coluvi configuration version");
  const origin = validatePilotOrigin(config.origin);
  if (new URL(origin).protocol === "https:" && !tlsEnabled) throw new Error("Coluvi HTTPS origin requires direct TLS");
  if (new URL(origin).protocol === "http:" && tlsEnabled) throw new Error("Coluvi origin scheme must match direct TLS configuration");
  if (!tlsEnabled && !new Set(["127.0.0.1", "::1", "localhost"]).has(host)) throw new Error("Coluvi HTTP development must bind only to loopback");
  if (typeof config.privateKeyPem !== "string" || config.privateKeyPem.length > 4_096) throw new Error("Invalid authority private key");
  const privateKey = createPrivateKey(config.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Authority key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const publicBytes = publicKey.export({ type: "spki", format: "der" });
  const identity: DeviceIdentity = { privateKey, publicKey, anonymousDeviceId: createHash("sha256").update(publicBytes).digest("base64url").slice(0, 22) };
  const authority = config.authority;
  if (!authority || authority.issuerId !== identity.anonymousDeviceId || authority.publicKey !== publicBytes.toString("base64url")
    || !Array.isArray(authority.zones) || authority.zones.length < 1 || authority.zones.length > 20 || new Set(authority.zones).size !== authority.zones.length
    || authority.zones.some((zone) => typeof zone !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(zone))
    || !Array.isArray(authority.kinds) || authority.kinds.length !== 1 || authority.kinds[0] !== "CHECKIN_REQUEST"
    || (authority.revoked !== undefined && typeof authority.revoked !== "boolean")) throw new Error("Invalid configured authority or scope");
  return { origin, identity, authority: structuredClone(authority), auth: new ColuviAuth(config.operatorPassword, config.enrollmentHash) };
}
