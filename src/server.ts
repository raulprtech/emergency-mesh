import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { PUBLIC_AGGREGATION_POLICY } from "./backend/aggregation.ts";
import { IngestAdmissionController, type AdmissionRejection } from "./backend/admission.ts";
import { SqliteBackend } from "./backend/sqlite-backend.ts";
import { createBackendAcknowledgement } from "./transports/ack.ts";
import { mobileAsset } from "./mobile-client/assets.ts";
import { deserializeEnvelope } from "./protocol/codec.ts";
import { runVerticalSlice } from "./simulator/scenario.ts";
import { mapHtml } from "./web/map.ts";

function persistentBackend(path: string): SqliteBackend {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  return new SqliteBackend(path);
}

const databasePath = process.env.EMERGENCY_MESH_DATABASE_PATH?.trim();
const backend = databasePath ? persistentBackend(databasePath) : (await runVerticalSlice()).backend;
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer from 1 through 65535");
const host = process.env.EMERGENCY_MESH_HOST?.trim() || "127.0.0.1";
const ingestAdmission = new IngestAdmissionController({
  windowMs: Number(process.env.EMERGENCY_MESH_INGEST_WINDOW_SECONDS ?? 60) * 1_000,
  maximumGlobalRequests: Number(process.env.EMERGENCY_MESH_INGEST_GLOBAL_REQUESTS ?? 600),
  maximumRequestsPerIdentity: Number(process.env.EMERGENCY_MESH_INGEST_IDENTITY_REQUESTS ?? 60),
  maximumTrackedIdentities: Number(process.env.EMERGENCY_MESH_INGEST_MAX_IDENTITIES ?? 10_000),
});
const publicPolicy = {
  ...PUBLIC_AGGREGATION_POLICY,
  spatialPrecisionDecimals: Number(process.env.EMERGENCY_MESH_PUBLIC_SPATIAL_DECIMALS ?? PUBLIC_AGGREGATION_POLICY.spatialPrecisionDecimals),
  timeBucketMs: Number(process.env.EMERGENCY_MESH_PUBLIC_BUCKET_MINUTES ?? 60) * 60_000,
  minimumGroupSize: Number(process.env.EMERGENCY_MESH_PUBLIC_MIN_GROUP_SIZE ?? PUBLIC_AGGREGATION_POLICY.minimumGroupSize),
  maximumAgeMs: Number(process.env.EMERGENCY_MESH_PUBLIC_MAX_AGE_HOURS ?? 24) * 60 * 60_000,
};
backend.publicAggregate(publicPolicy);

function json(response: import("node:http").ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

function rateLimited(response: import("node:http").ServerResponse, decision: AdmissionRejection): void {
  const retryAfterMs = decision.retryAfterMs;
  json(response, 429, {
    status: "RATE_LIMITED",
    error: "ingest admission limit exceeded",
    scope: decision.scope,
    retryAfterMs,
  }, { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))) });
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/mobile") { response.writeHead(302, { location: "/mobile/" }); return response.end(); }
  if ((request.method === "GET" || request.method === "HEAD") && request.url?.startsWith("/mobile/")) {
    const asset = mobileAsset(request.url);
    if (!asset) return json(response, 404, { error: "not found" });
    response.writeHead(200, {
      "content-type": asset.contentType,
      "cache-control": "no-cache",
      "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'",
      "permissions-policy": "geolocation=(self)",
    });
    return response.end(request.method === "HEAD" ? undefined : asset.body);
  }
  if (request.method === "GET" && request.url === "/health") return json(response, 200, { status: "ok", protocolVersion: "0.1", storage: databasePath ? "sqlite" : "memory" });
  if (request.method === "GET" && request.url === "/api/events" && process.env.EMERGENCY_MESH_ENABLE_DEBUG_EVENTS === "1") return json(response, 200, backend.list());
  if (request.method === "GET" && request.url === "/api/areas") return json(response, 200, backend.publicAggregate(publicPolicy));
  if (request.method === "POST" && request.url === "/api/packets") {
    const requestAdmission = ingestAdmission.admitRequest();
    if (!requestAdmission.allowed) { request.resume(); rateLimited(response, requestAdmission); return; }
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > 65_536) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) return json(response, 413, { status: "INVALID", error: "packet exceeds 65536 bytes" });
      try {
        const envelope = deserializeEnvelope(Buffer.concat(chunks));
        const identityAdmission = ingestAdmission.admitIdentity(envelope.report.anonymousDeviceId);
        if (!identityAdmission.allowed) return rateLimited(response, identityAdmission);
        const acknowledgedAt = Date.now();
        const result = backend.ingest(envelope, acknowledgedAt);
        const accepted = result.status === "ACCEPTED" || result.status === "DUPLICATE";
        const evidence = accepted ? createBackendAcknowledgement("reference-backend", envelope, acknowledgedAt, result.status === "DUPLICATE") : undefined;
        json(response, result.status === "INVALID" ? 400 : result.status === "EXPIRED" ? 410 : 202, { ...result, evidence });
      } catch (error) {
        json(response, 400, { status: "INVALID", error: error instanceof Error ? error.message : "invalid packet" });
      }
    });
    return;
  }
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(mapHtml);
  }
  return json(response, 404, { error: "not found" });
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    if (backend instanceof SqliteBackend) backend.close();
    process.exit(0);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`Emergency Map: http://${displayHost}:${port} (listening on ${host}; storage=${databasePath ? "sqlite" : "memory"})`);
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) console.warn("Network listener uses HTTP; place it behind trusted HTTPS before phone or public access");
  if (publicPolicy.minimumGroupSize < 3) console.warn("Public aggregation threshold is below the privacy-preserving default of 3");
});
