import { readFileSync, openSync, closeSync, fstatSync, constants } from "node:fs";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { isIP } from "node:net";
import { diagnosePilot } from "./pilot.js";

// Fixed diagnostic codes only: errors, response bodies and keys never enter the report.
function readMaterial(path, privateFile = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 131_072 || (process.getuid && stat.uid !== process.getuid())
      || (privateFile && (stat.mode & 0o077))) throw new Error("Invalid material");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function probeHealth(origin, ca, timeoutMs) {
  return new Promise(resolve => {
    let done = false; let request; let timer;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); request?.destroy(); resolve(result); };
    const secure = new URL(origin).protocol === "https:";
    timer = setTimeout(() => finish({ status: "FAIL", code: "SERVER_TIMEOUT" }), timeoutMs);
    request = (secure ? httpsGet : httpGet)(new URL("/health", origin), {
      ...(secure ? { ca, rejectUnauthorized: true } : {}), agent: false, headers: { accept: "application/json" },
    }, response => {
      const peer = secure ? response.socket.getPeerCertificate()?.fingerprint256 : undefined;
      if (response.statusCode !== 200) return finish({ status: "FAIL", code: "HEALTH_HTTP_STATUS", httpStatus: response.statusCode });
      let size = 0; const chunks = [];
      response.on("data", chunk => { size += chunk.length; if (size > 4096) finish({ status: "FAIL", code: "HEALTH_RESPONSE_TOO_LARGE" }); else chunks.push(chunk); });
      response.on("error", () => finish({ status: "FAIL", code: "HEALTH_RESPONSE_INTERRUPTED" }));
      response.on("end", () => {
        try {
          const health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (health.status !== "ok" || health.protocolVersion !== "0.1" || health.storage !== "sqlite" || health.https !== secure) throw new Error("Unexpected health contract");
          finish({ status: "PASS", code: "SERVER_HEALTHY_FROM_UBUNTU", peerFingerprint: peer });
        } catch { finish({ status: "FAIL", code: "HEALTH_CONTRACT_MISMATCH" }); }
      });
    });
    request.on("error", error => finish({ status: "FAIL", code: ["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(error.code)
      ? "SERVER_TLS_REJECTED" : "SERVER_UNREACHABLE" }));
  });
}

/** Read-only readiness checks. Probes only the configured origin, never follows redirects. */
export async function preflightPilot(path, options = {}) {
  const checks = []; const add = (id, status, code, extra = {}) => checks.push({ id, status, code, ...extra });
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 10_000)) throw new Error("Invalid probe timeout");
  const now = Date.now();
  add("runtime", process.platform === "linux" && process.env.WSL_DISTRO_NAME === "Ubuntu" ? "PASS" : "FAIL", "REQUIRES_UBUNTU_WSL");
  let diagnosis;
  try { diagnosis = diagnosePilot(path); add("configuration", "PASS", "CONFIGURATION_AND_TRUST_MATCH"); }
  catch { add("configuration", "FAIL", "CONFIGURATION_OR_DATABASE_INVALID"); }
  if (diagnosis) {
    const url = new URL(diagnosis.origin); const secure = url.protocol === "https:";
    add("authority", diagnosis.authorityRevoked ? "FAIL" : "PASS", diagnosis.authorityRevoked ? "AUTHORITY_REVOKED" : "AUTHORITY_ACTIVE");
    add("database", diagnosis.database.status === "CHECKED" ? "PASS" : "PENDING", diagnosis.database.status === "CHECKED" ? "SQLITE_INTEGRITY_CHECKED" : "DATABASE_NOT_CREATED");
    add("restoreReview", diagnosis.restoredSnapshot ? "PENDING" : "PASS", diagnosis.restoredSnapshot ? "REVIEW_RESTORED_REVOCATIONS_BEFORE_START" : "NO_RESTORE_REVIEW_MARKER");
    add("phoneOrigin", secure ? "PASS" : "FAIL", secure ? "HTTPS_CONFIGURED_NOT_PHONE_VERIFIED" : "HTTP_LOOPBACK_NOT_ANDROID_READY");
    let certificate;
    if (options.tlsCert) {
      try {
        certificate = new X509Certificate(readMaterial(options.tlsCert));
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const matches = isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname);
        const validUntil = Date.parse(certificate.validTo); const validFrom = Date.parse(certificate.validFrom);
        add("certificate", secure && matches && now >= validFrom && now < validUntil ? "PASS" : "FAIL", secure && matches && now >= validFrom && now < validUntil ? "CERTIFICATE_MATCHES_ORIGIN_AND_TIME" : "CERTIFICATE_ORIGIN_OR_TIME_INVALID", { validUntil });
        add("certificateRenewal", validUntil - now > 48 * 60 * 60_000 ? "PASS" : "PENDING", validUntil - now > 48 * 60 * 60_000 ? "MORE_THAN_48_HOURS_REMAIN" : "RENEW_CERTIFICATE_BEFORE_PILOT");
        if (options.tlsKey) {
          const matchesKey = certificate.checkPrivateKey(createPrivateKey(readMaterial(options.tlsKey, true)));
          add("privateKey", matchesKey ? "PASS" : "FAIL", matchesKey ? "KEY_MATCHES_CERTIFICATE" : "KEY_DOES_NOT_MATCH_CERTIFICATE");
        } else add("privateKey", "PENDING", "PRIVATE_KEY_NOT_INSPECTED");
      } catch { add("tlsMaterial", "FAIL", "TLS_MATERIAL_INVALID_OR_UNREADABLE"); }
    } else add("certificate", options.tlsKey ? "FAIL" : "PENDING", options.tlsKey ? "KEY_REQUIRES_CERTIFICATE" : "CERTIFICATE_NOT_INSPECTED");
    if (options.probe === true) {
      let ca; let readable = true;
      try { if (options.caCert) ca = readMaterial(options.caCert); }
      catch { readable = false; add("server", "FAIL", "CA_MATERIAL_INVALID_OR_UNREADABLE"); }
      if (readable) {
        const result = await probeHealth(diagnosis.origin, ca, options.timeoutMs ?? 3000);
        const { peerFingerprint, ...safeResult } = result;
        checks.push({ id: "server", ...safeResult });
        if (certificate && result.status === "PASS" && secure) add("servedCertificate", certificate.fingerprint256 === peerFingerprint ? "PASS" : "FAIL", certificate.fingerprint256 === peerFingerprint ? "SERVER_USES_INSPECTED_CERTIFICATE" : "SERVER_USES_DIFFERENT_CERTIFICATE");
      }
    } else add("server", "PENDING", "NETWORK_NOT_PROBED_USE_EXPLICIT_PROBE");
  } else add("server", "PENDING", "NETWORK_NOT_PROBED_INVALID_CONFIGURATION");
  add("android", "PENDING", "VERIFY_WIFI_CA_TRUST_INSTALL_AND_ROUND_TRIP_ON_BOTH_PHONES");
  return { version: 1, kind: "COLUVI_PILOT_PREFLIGHT", generatedAt: now, origin: diagnosis?.origin ?? null,
    status: checks.some(check => check.status === "FAIL") ? "FAIL" : "PENDING_PHYSICAL_TESTS", physicalConnectivityVerified: false,
    checks, limits: ["Health is not authority authentication", "Ubuntu reachability does not prove Android reachability", "No firewall, certificate store, database records or pilot configuration changed"] };
}
