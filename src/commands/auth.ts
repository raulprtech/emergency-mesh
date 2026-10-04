import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, verify } from "node:crypto";
import { promisify } from "node:util";
import { IngestAdmissionController } from "../backend/admission.ts";
import { canonicalCbor } from "../mobile-client/crypto.js";

const scrypt = promisify(scryptCallback);
const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");
const equalHex = (a: string, b: string) => /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
export interface PasswordVerifier { salt: string; hash: string; }
export interface OperatorSession { csrf: string; expiresAt: number; }
export interface EnrollmentChallenge { challengeId: string; publicKey: string; zoneId: string; expiresAt: number; }

export async function passwordVerifier(password: string, salt = randomBytes(16).toString("hex")): Promise<PasswordVerifier> {
  if (typeof password !== "string" || password.length < 16 || password.length > 512 || !/^[a-f0-9]{32}$/.test(salt)) throw new Error("Invalid operator password or salt");
  const key = await scrypt(password, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
  return { salt, hash: key.toString("hex") };
}

export function enrollmentCodeHash(code: string): string { return hashToken(code); }
export function enrollmentProofBytes(challenge: EnrollmentChallenge): Uint8Array {
  return canonicalCbor({ domain: "COLUVI/ENROLLMENT/v1", payload: challenge });
}

/** Bounded, expiring sessions and one-use challenges; a restart invalidates operator sessions. */
export class ColuviAuth {
  private readonly verifier: PasswordVerifier;
  private readonly enrollmentHash: string;
  private readonly sessions = new Map<string, OperatorSession>();
  private readonly challenges = new Map<string, EnrollmentChallenge>();
  private readonly loginAdmission = new IngestAdmissionController({ maximumGlobalRequests: 20, maximumRequestsPerIdentity: 5, maximumTrackedIdentities: 100 });
  private readonly enrollmentAdmission = new IngestAdmissionController({ maximumGlobalRequests: 60, maximumRequestsPerIdentity: 10, maximumTrackedIdentities: 100 });
  private readonly sessionMs: number;
  constructor(verifier: PasswordVerifier, enrollmentHash: string, sessionMs = 60 * 60_000) {
    if (!/^[a-f0-9]{32}$/.test(verifier.salt) || !/^[a-f0-9]{64}$/.test(verifier.hash) || !/^[a-f0-9]{64}$/.test(enrollmentHash)
      || !Number.isSafeInteger(sessionMs) || sessionMs < 1_000 || sessionMs > 60 * 60_000) throw new Error("Invalid Coluvi authentication configuration");
    this.verifier = { ...verifier }; this.enrollmentHash = enrollmentHash; this.sessionMs = sessionMs;
  }

  async login(password: unknown, source: string, now = Date.now()): Promise<{ token: string; session: OperatorSession } | undefined> {
    if (!this.loginAdmission.admitRequest(now).allowed || !this.loginAdmission.admitIdentity(source, now).allowed) throw new Error("Operator login rate limited");
    this.prune(now);
    if (typeof password !== "string" || password.length < 16 || password.length > 512) return undefined;
    const candidate = await passwordVerifier(password, this.verifier.salt);
    if (!equalHex(candidate.hash, this.verifier.hash)) return undefined;
    if (this.sessions.size >= 8) throw new Error("Operator session capacity exceeded");
    const token = randomToken(); const session = { csrf: randomToken(), expiresAt: now + this.sessionMs };
    this.sessions.set(hashToken(token), session);
    return { token, session: { ...session } };
  }

  session(cookie: string | undefined, now = Date.now()): OperatorSession | undefined {
    this.prune(now);
    const values = cookie?.split(";").map((item) => item.trim()).filter((item) => item.startsWith("coluvi_operator=")) ?? [];
    if (values.length !== 1) return undefined;
    const token = values[0].slice("coluvi_operator=".length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const session = this.sessions.get(hashToken(token));
    return session ? { ...session } : undefined;
  }

  csrfValid(cookie: string | undefined, csrf: unknown, now = Date.now()): boolean {
    const session = this.session(cookie, now);
    return Boolean(session && typeof csrf === "string" && equalHex(hashToken(csrf), hashToken(session.csrf)));
  }

  logout(cookie: string | undefined): void {
    const token = cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith("coluvi_operator="))?.slice("coluvi_operator=".length);
    if (token) this.sessions.delete(hashToken(token));
  }

  challenge(code: unknown, publicKey: unknown, zoneId: unknown, authorizedZones: string[], source: string, now = Date.now()): EnrollmentChallenge {
    if (!this.enrollmentAdmission.admitRequest(now).allowed || !this.enrollmentAdmission.admitIdentity(source, now).allowed) throw new Error("Enrollment rate limited");
    this.prune(now);
    if (typeof code !== "string" || code.length > 512 || !equalHex(hashToken(code), this.enrollmentHash)) throw new Error("Enrollment not authorized");
    if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(publicKey) || typeof zoneId !== "string" || !authorizedZones.includes(zoneId)) throw new Error("Invalid enrollment scope or key");
    const bytes = Buffer.from(publicKey, "base64url");
    if (bytes.length !== 44 || bytes.toString("base64url") !== publicKey || bytes.subarray(0, 12).toString("hex") !== "302a300506032b6570032100") throw new Error("Invalid enrollment key");
    if (this.challenges.size >= 100) throw new Error("Enrollment challenge capacity exceeded");
    const challenge = { challengeId: randomToken(), publicKey, zoneId, expiresAt: now + 120_000 };
    this.challenges.set(challenge.challengeId, challenge);
    return { ...challenge };
  }

  complete(challengeId: unknown, signature: unknown, now = Date.now()): EnrollmentChallenge {
    this.prune(now);
    if (typeof challengeId !== "string") throw new Error("Invalid enrollment challenge");
    const challenge = this.challenges.get(challengeId);
    // Every completion attempt consumes this challenge, including incorrect proofs.
    this.challenges.delete(challengeId);
    if (!challenge || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) throw new Error("Invalid or expired enrollment proof");
    let valid = false;
    try { valid = verify(null, enrollmentProofBytes(challenge), { key: Buffer.from(challenge.publicKey, "base64url"), format: "der", type: "spki" }, Buffer.from(signature, "base64url")); } catch { /* fail closed */ }
    if (!valid) throw new Error("Invalid enrollment proof");
    return { ...challenge };
  }

  private prune(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid authentication time");
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    for (const [key, challenge] of this.challenges) if (challenge.expiresAt <= now) this.challenges.delete(key);
  }
}
