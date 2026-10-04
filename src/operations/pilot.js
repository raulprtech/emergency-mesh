import { constants, chmodSync, closeSync, copyFileSync, createReadStream, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { createServer, isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, join, resolve, relative, sep } from "node:path";
import { loadColuviConfiguration } from "../commands/config.ts";
import { authorityFingerprint } from "../commands/authority.ts";

export class PilotOperationError extends Error {}
const fail = message => { throw new PilotOperationError(message); };
const FILES = ["operator-config.json", "mobile-trust.json", "pilot.sqlite", "operator-secrets.txt"];
const required = FILES.slice(0, 3);
const countsFor = { reports: "reports", participants: "coluvi_participants", commands: "coluvi_commands", responses: "coluvi_responses", needs: "coluvi_needs", notices: "coluvi_notices" };

function directory(path) {
  const full = resolve(path); const info = lstatSync(full);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) fail("Directory must be owned, private (0700), and not a symbolic link");
  return realpathSync(full);
}
function inspectFile(path, maxBytes, privateFile = true) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes || (process.getuid && info.uid !== process.getuid()) || (privateFile && (info.mode & 0o077) !== 0)) fail("File must be owned, regular, bounded, and private");
    return info;
  } finally { closeSync(fd); }
}
function privateBytes(path, maxBytes = 32_768) { inspectFile(path, maxBytes); return readFileSync(path); }
function jsonFile(path) {
  try { return JSON.parse(privateBytes(path).toString("utf8")); }
  catch (error) { if (error instanceof PilotOperationError) throw error; fail("Invalid private JSON file"); }
}
function writeExclusive(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path) { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function newDirectory(source, destination) {
  const requested = resolve(destination); const target = join(realpathSync(dirname(requested)), basename(requested));
  const pathFromSource = relative(source, target);
  if (pathFromSource !== ".." && !pathFromSource.startsWith(`..${sep}`)) fail("Destination must be a new directory outside the source");
  mkdirSync(target, { mode: 0o700 }); return target;
}
function configuration(root) {
  const path = join(root, "operator-config.json"); const raw = jsonFile(path);
  const config = loadColuviConfiguration(path, "127.0.0.1", typeof raw.origin === "string" && raw.origin.startsWith("https:"));
  const trust = jsonFile(join(root, "mobile-trust.json"));
  if (trust.version !== 1 || trust.origin !== config.origin || trust.fingerprint !== authorityFingerprint(config.authority)
    || !isDeepStrictEqual(trust.authorities, [config.authority])) fail("Public trust does not match the private configuration");
  return config;
}
function inspectDatabase(path) {
  inspectFile(path, 1_073_741_824, false);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000");
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) fail("SQLite integrity or foreign-key check failed");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!["reports", "coluvi_participants", "coluvi_commands", "coluvi_responses"].every(name => tables.has(name))) fail("Database is not a complete Coluvi pilot");
    return Object.fromEntries(Object.entries(countsFor).map(([key, table]) => [key, tables.has(table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : 0]));
  } finally { db.close(); }
}
async function digest(path) {
  const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest("hex");
}

export function diagnosePilot(path) {
  const root = directory(path); const config = configuration(root); const dbPath = join(root, "pilot.sqlite");
  return { directory: root, origin: config.origin, fingerprint: authorityFingerprint(config.authority), zones: config.authority.zones,
    authorityRevoked: Boolean(config.authority.revoked), database: existsSync(dbPath) ? { status: "CHECKED", counts: inspectDatabase(dbPath) } : { status: "NOT_CREATED" },
    restoredSnapshot: existsSync(join(root, "restore-review.json")), runtime: { node: process.version, platform: process.platform, wslDistribution: process.env.WSL_DISTRO_NAME ?? null },
    network: "NOT_PROBED", tls: new URL(config.origin).protocol === "https:" ? "REQUIRES_EXTERNAL_CERTIFICATE_AND_KEY" : "LOOPBACK_DEVELOPMENT_ONLY" };
}

/** Uses SQLite online backup, not a copy of the main file without its WAL. */
export async function backupPilot(sourcePath, destination) {
  const source = directory(sourcePath); const config = configuration(source); inspectDatabase(join(source, "pilot.sqlite"));
  if (existsSync(join(source, "restore-review.json")) && !existsSync(join(source, "restore-complete.json"))) fail("Cannot back up an incomplete restoration");
  const snapshotStartedAt = Date.now();
  for (const name of FILES.filter(name => name !== "pilot.sqlite")) if (existsSync(join(source, name))) privateBytes(join(source, name));
  const target = newDirectory(source, destination);
  const snapshot = join(target, "pilot.sqlite"); writeExclusive(snapshot, Buffer.alloc(0));
  const db = new DatabaseSync(join(source, "pilot.sqlite"), { readOnly: true });
  try { await backup(db, snapshot); } finally { db.close(); }
  inspectDatabase(snapshot);
  for (const name of FILES.filter(name => name !== "pilot.sqlite")) if (existsSync(join(source, name))) writeExclusive(join(target, name), privateBytes(join(source, name)));
  if (authorityFingerprint(configuration(target).authority) !== authorityFingerprint(config.authority)) fail("Authority changed while taking backup");
  const files = [];
  for (const name of FILES) if (existsSync(join(target, name))) files.push({ name, bytes: inspectFile(join(target, name), 1_073_741_824).size, sha256: await digest(join(target, name)) });
  const createdAt = Date.now();
  writeExclusive(join(target, "backup-manifest.json"), JSON.stringify({ version: 1, kind: "COLUVI_PILOT_BACKUP", snapshotStartedAt, createdAt, fingerprint: authorityFingerprint(config.authority), files }, null, 2) + "\n");
  syncDirectory(target);
  return { backupDirectory: target, snapshotStartedAt, createdAt, files: files.length, fingerprint: authorityFingerprint(config.authority), containsPrivateMaterial: true };
}

export async function restorePilot(backupPath, destination) {
  const source = directory(backupPath); const manifest = jsonFile(join(source, "backup-manifest.json"));
  if (existsSync(join(source, "pilot.sqlite-wal")) && inspectFile(join(source, "pilot.sqlite-wal"), 1_073_741_824, false).size > 0) fail("Backup has a live WAL; do not use or modify a backup as a running pilot");
  if (manifest.version !== 1 || manifest.kind !== "COLUVI_PILOT_BACKUP" || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0
    || !Number.isSafeInteger(manifest.snapshotStartedAt) || manifest.snapshotStartedAt < 0 || manifest.snapshotStartedAt > manifest.createdAt
    || !Array.isArray(manifest.files) || manifest.files.length < 3 || manifest.files.length > 4
    || new Set(manifest.files.map(item => item.name)).size !== manifest.files.length || !required.every(name => manifest.files.some(item => item.name === name))) fail("Invalid backup manifest");
  for (const item of manifest.files) {
    if (!FILES.includes(item.name) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) fail("Invalid backup file entry");
    if (inspectFile(join(source, item.name), 1_073_741_824).size !== item.bytes || await digest(join(source, item.name)) !== item.sha256) fail("Backup checksum mismatch");
  }
  const config = configuration(source); inspectDatabase(join(source, "pilot.sqlite"));
  if (manifest.fingerprint !== authorityFingerprint(config.authority)) fail("Backup authority fingerprint mismatch");
  const target = newDirectory(source, destination);
  // Written first: a partial restore must never be mistaken for an ordinary pilot.
  writeExclusive(join(target, "restore-review.json"), JSON.stringify({ version: 1, restoredAt: Date.now(), snapshotAt: manifest.snapshotStartedAt,
    warning: "Snapshot restores prior enrollment, credentials and revocations. Review changes since backup before exposing the service. TLS files are not included." }, null, 2) + "\n");
  for (const item of manifest.files) {
    const targetPath = join(target, item.name);
    copyFileSync(join(source, item.name), targetPath, constants.COPYFILE_EXCL);
    chmodSync(targetPath, 0o600);
    if (await digest(targetPath) !== item.sha256) fail("Restored checksum mismatch");
    const fd = openSync(targetPath, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  configuration(target); inspectDatabase(join(target, "pilot.sqlite"));
  writeExclusive(join(target, "restore-complete.json"), JSON.stringify({ version: 1, snapshotAt: manifest.snapshotStartedAt, fingerprint: manifest.fingerprint }) + "\n");
  syncDirectory(target);
  return { restoredDirectory: target, snapshotAt: manifest.snapshotStartedAt, requiresRollbackReview: true, fingerprint: manifest.fingerprint };
}

export async function preparePilotStart(path, options = {}) {
  if (process.platform === "win32" || (process.env.WSL_DISTRO_NAME && process.env.WSL_DISTRO_NAME !== "Ubuntu")) fail("Run the pilot from Ubuntu WSL2, not Windows or UbuntuPreview");
  const root = directory(path); const config = configuration(root); const url = new URL(config.origin);
  if (existsSync(join(root, "backup-manifest.json"))) fail("Do not run a backup directory; restore into a new pilot directory first");
  if (existsSync(join(root, "restore-review.json"))) {
    const review = jsonFile(join(root, "restore-review.json"));
    if (review.version !== 1 || !Number.isSafeInteger(review.snapshotAt) || !Number.isSafeInteger(review.restoredAt)) fail("Invalid restore review marker");
    if (!existsSync(join(root, "restore-complete.json"))) fail("Restoration is incomplete; do not start this directory");
    const complete = jsonFile(join(root, "restore-complete.json"));
    if (complete.version !== 1 || complete.snapshotAt !== review.snapshotAt || complete.fingerprint !== authorityFingerprint(config.authority)) fail("Restoration completion marker does not match");
  }
  if (existsSync(join(root, "restore-review.json")) && options.acknowledgeRollback !== true) fail("Restored snapshot requires review of later revocations and explicit --acknowledge-rollback");
  const host = options.host ?? "127.0.0.1"; const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (typeof host !== "string" || (host !== "localhost" && !isIP(host))) fail("Bind host must be an explicit IP address or localhost");
  const tls = Boolean(options.tlsCert && options.tlsKey);
  loadColuviConfiguration(join(root, "operator-config.json"), host, tls);
  if (Boolean(options.tlsCert) !== Boolean(options.tlsKey)) fail("Provide both TLS certificate and private key");
  if (tls) {
    const certPath = resolve(options.tlsCert); inspectFile(certPath, 131_072, false);
    const certificate = new X509Certificate(readFileSync(certPath)); const key = createPrivateKey(privateBytes(resolve(options.tlsKey), 32_768));
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (Date.now() < Date.parse(certificate.validFrom) || Date.now() >= Date.parse(certificate.validTo) || !certificate.checkPrivateKey(key)
      || !(certificate.checkHost(hostname) || certificate.checkIP(hostname))) fail("TLS certificate does not match the origin, key or current time");
  }
  if (existsSync(join(root, "pilot.sqlite"))) inspectDatabase(join(root, "pilot.sqlite"));
  const probe = createServer();
  await new Promise((resolveProbe, reject) => { probe.once("error", () => reject(new PilotOperationError("Pilot address unavailable; no existing service was stopped"))); probe.listen({ host, port, exclusive: true }, resolveProbe); });
  await new Promise((resolveProbe, reject) => probe.close(error => error ? reject(error) : resolveProbe()));
  return { root, origin: config.origin, environment: { PORT: String(port), EMERGENCY_MESH_HOST: host,
    EMERGENCY_MESH_DATABASE_PATH: join(root, "pilot.sqlite"), EMERGENCY_MESH_COLUVI_CONFIG_PATH: join(root, "operator-config.json"),
    EMERGENCY_MESH_TLS_CERT_PATH: tls ? resolve(options.tlsCert) : "", EMERGENCY_MESH_TLS_KEY_PATH: tls ? resolve(options.tlsKey) : "", EMERGENCY_MESH_ENABLE_DEBUG_EVENTS: "0" } };
}
