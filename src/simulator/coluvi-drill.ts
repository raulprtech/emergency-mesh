import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDeviceIdentityFromSeed, canonicalReportBytes } from "../protocol/identity.ts";
import type { EmergencyEnvelope, EmergencyReport } from "../protocol/types.ts";
import { authorityFor, createCheckinCommand } from "../commands/authority.ts";
import { ColuviStore } from "../commands/store.ts";
import { createCheckinResponse, createCheckinReceipt, verifyCommandForDevice } from "../mobile-client/commands.js";
import { SqliteStoreAndForwardQueue } from "../storage/sqlite-store.ts";
import { DeterministicRoutingManager } from "../routing/manager.ts";
import { Gateway } from "../gateway/gateway.ts";
import { InternetAdapter } from "../transports/internet.ts";
import { VirtualClock } from "./clock.ts";
import { SeededRandom } from "./random.ts";
import { LossyLinkAdapter } from "./lossy-link.ts";
import { SimulatedNode } from "./node.ts";

export const DRILL_MODES = ["LAN_WITHOUT_INTERNET", "TOTAL_ISOLATION", "INTERMITTENT", "LATE_DELIVERY", "EXPIRED_DELIVERY"] as const;
const START = Date.UTC(2026, 9, 4, 12);
const PROMPT_MS = 20_000; const RESPONSE_MS = 60_000;
const identity = (seed: number) => createDeviceIdentityFromSeed(new Uint8Array(32).fill(seed));
function browserIdentity(seed: number) {
  const value = identity(seed);
  return { mode: "ED25519", anonymousDeviceId: value.anonymousDeviceId, publicKey: value.publicKey.export({ type: "spki", format: "der" }).toString("base64url"), privateKeyJwk: value.privateKey.export({ format: "jwk" }) };
}
function overlap(from: number, to: number, start: number, end: number) { return Math.max(0, Math.min(to, end) - Math.max(from, start)); }
function statistics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, minimum: sorted[0] ?? null, median: sorted.length ? sorted[Math.ceil(sorted.length * .5) - 1] : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null, maximum: sorted.at(-1) ?? null };
}

/** Fictional topology, virtual milliseconds, never a physical-network benchmark. */
export async function runColuviDrill(cycles = 30, baseSeed = 20261004, options: { signal?: AbortSignal } = {}) {
  if (!Number.isSafeInteger(cycles) || cycles < 5 || cycles > 100 || cycles % DRILL_MODES.length !== 0) throw new Error("Cycles must be a multiple of five from 5 to 100");
  if (!Number.isSafeInteger(baseSeed) || baseSeed < 0 || baseSeed > 0xffffffff) throw new Error("Invalid simulation seed");
  options.signal?.throwIfAborted();
  const directory = mkdtempSync("/tmp/coluvi-drill-");
  const issuer = identity(200); const authority = authorityFor(issuer, ["refugio-ficticio", "otra-zona"]);
  const devices = [1, 2, 3, 4, 5].map(browserIdentity);
  const results = [];
  try {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      options.signal?.throwIfAborted();
      const mode = DRILL_MODES[cycle % DRILL_MODES.length]; const seed = (baseSeed + cycle) >>> 0;
      const clock = new VirtualClock(START + cycle * 120_000); const issuedAt = clock.now();
      const databasePath = join(directory, `center-${cycle}.sqlite`);
      let store = new ColuviStore(databasePath, [authority]);
      const queues: SqliteStoreAndForwardQueue[] = [];
      const nodePaths = new Map<string, string>();
      const newNode = (id: string) => {
        const path = nodePaths.get(id) ?? join(directory, `${cycle}-${id}.sqlite`); nodePaths.set(id, path);
        const queue = new SqliteStoreAndForwardQueue(path); queues.push(queue);
        return new SimulatedNode(id, new DeterministicRoutingManager(), { batteryPercent: 100, energyMode: "NORMAL" }, queue);
      };
      const command = createCheckinCommand(issuer, authority, { commandId: `drill-${cycle}`, incidentRef: "SIMULACRO-inundacion-refugio", zoneId: "refugio-ficticio", nonce: `fictitious-${cycle}`, issuedAt, promptUntil: issuedAt + PROMPT_MS, responseUntil: issuedAt + RESPONSE_MS });
      const canonical = canonicalReportBytes(command);
      const receipts: EmergencyReport[] = []; const deliveryMs: number[] = []; const imposedMs: number[] = []; const availableMs: number[] = [];
      const delivered = new Map<string, number>(); let duplicateChecks = 0; let responseCreated = 0; let restarts = 0;
      const blackout = mode === "LATE_DELIVERY" ? [0, 25_000] : mode === "EXPIRED_DELIVERY" ? [0, 65_000] : mode === "INTERMITTENT" ? [8_000, 18_000] : [0, 0];
      const centerAvailable = () => mode !== "TOTAL_ISOLATION" && !(clock.now() - issuedAt >= blackout[0] && clock.now() - issuedAt < blackout[1]);
      const gateway = new Gateway("fictitious-center", { ingest: (envelope, now = clock.now()) => {
        const result = store.acceptResponse(envelope, now);
        if (result.status === "ACCEPTED") {
          const elapsed = now - envelope.report.createdAt;
          const imposed = overlap(envelope.report.createdAt - issuedAt, now - issuedAt, blackout[0], blackout[1]);
          deliveryMs.push(elapsed); imposedMs.push(imposed); availableMs.push(elapsed - imposed);
          assert.equal(store.acceptResponse(envelope, now).status, "DUPLICATE"); duplicateChecks += 1;
        }
        return result;
      } });
      let relay = newNode("relay");
      const egress = new InternetAdapter("local-center-link", gateway, () => clock.now()); relay.addTransport(egress);
      const clients: { source: SimulatedNode; mobile: SimulatedNode; commandLink: LossyLinkAdapter; returnLink: LossyLinkAdapter; answered: boolean; command?: EmergencyReport; index: number }[] = [];
      try {
        for (const [index, device] of devices.entries()) store.enroll(device.publicKey, index === 4 ? "otra-zona" : "refugio-ficticio", issuedAt);
        store.issue(command, issuedAt);
        assert.equal(store.inbox(devices[4].anonymousDeviceId, 0, 50, issuedAt).commands.length, 0);
        for (const [index, device] of devices.slice(0, 4).entries()) {
          const client = { source: newNode(`center-${index}`), mobile: newNode(`mobile-${index}`), commandLink: new LossyLinkAdapter(`request-${index}`, new SeededRandom(seed + index * 37), { lossRate: .25 }), returnLink: new LossyLinkAdapter(`return-${index}`, new SeededRandom(seed + index * 71 + 1), { lossRate: .25 }), answered: false, command: undefined as EmergencyReport | undefined, index };
          client.commandLink.connect(async (envelope) => {
            assert.ok(Buffer.from(canonicalReportBytes(envelope.report)).equals(Buffer.from(canonical)));
            if (!await verifyCommandForDevice(envelope.report, [authority], "refugio-ficticio", clock.now())) return false;
            if (client.command) return true;
            if (!client.mobile.receive(envelope, clock.now())) return false;
            client.command = envelope.report; delivered.set(device.anonymousDeviceId, clock.now());
            receipts.push(await createCheckinReceipt(command, "RECEIVED", device, clock.now()), await createCheckinReceipt(command, "SHOWN", device, clock.now()));
            // The test actor renders the validated command; this is not physical UI evidence.
            client.mobile.queue.remove(command.eventId); return true;
          });
          client.returnLink.connect((envelope) => relay.receive(envelope, clock.now()) || relay.queue.hasSeen(envelope.report.eventId));
          client.source.addTransport(client.commandLink); client.mobile.addTransport(client.returnLink);
          client.source.create(store.inbox(device.anonymousDeviceId, 0, 50, issuedAt).commands[0]); clients.push(client);
        }
        for (let tick = 0; tick <= 70_000; tick += 1_000) {
          options.signal?.throwIfAborted();
          clock.set(issuedAt + tick);
          if (tick === 7_000) {
            // Close/reopen command state and all custody queues without clearing signed packets.
            store.close(); for (const queue of queues) queue.close(); queues.length = 0;
            store = new ColuviStore(databasePath, [authority]); relay = newNode("relay"); relay.addTransport(egress);
            for (const client of clients) { client.source = newNode(`center-${client.index}`); client.source.addTransport(client.commandLink); client.mobile = newNode(`mobile-${client.index}`); client.mobile.addTransport(client.returnLink); }
            restarts += 1;
          }
          const linksAvailable = mode !== "TOTAL_ISOLATION" && !(mode === "INTERMITTENT" && tick < 6_000);
          egress.setOnline(centerAvailable());
          for (const client of clients) {
            client.commandLink.setAvailable(linksAvailable); client.returnLink.setAvailable(linksAvailable);
            await client.source.flush(clock.now());
            if (client.command && !client.answered && client.index < 3 && tick < PROMPT_MS && tick >= (delivered.get(devices[client.index].anonymousDeviceId)! - issuedAt) + 1_000) {
              const item = await createCheckinResponse(command, client.index === 2 ? "NEEDS_HELP" : "SAFE", devices[client.index], clock.now());
              assert.equal(client.mobile.receive(item.envelope as EmergencyEnvelope, clock.now()), true); client.answered = true; responseCreated += 1;
            }
            await client.mobile.flush(clock.now());
          }
          await relay.flush(clock.now());
          if (centerAvailable()) {
            while (receipts.length && receipts[0].validUntil > clock.now()) { const receipt = receipts.shift()!; store.acceptReceipt(receipt, receipt.anonymousDeviceId, clock.now()); assert.equal(store.acceptReceipt(receipt, receipt.anonymousDeviceId, clock.now()), "DUPLICATE"); }
          }
          if (tick === PROMPT_MS) assert.equal(store.projection(command.eventId, clock.now()).counts.pending, 0);
        }
        const projection = store.projection(command.eventId, clock.now());
        assert.equal(projection.counts.requested, 4); assert.equal(projection.counts.pending, 0);
        assert.equal(projection.counts.responded + projection.counts.unknown, 4);
        assert.equal(projection.recipients.reduce((sum, row) => sum + row.history.length, 0), projection.counts.responded);
        assert.equal(projection.counts.responded, duplicateChecks);
        if (mode === "TOTAL_ISOLATION") { assert.equal(delivered.size, 0); assert.equal(responseCreated, 0); assert.equal(projection.counts.unknown, 4); }
        if (mode === "EXPIRED_DELIVERY") { assert.equal(projection.counts.responded, 0); assert.equal(projection.counts.unknown, 4); }
        if (mode === "LATE_DELIVERY") assert.equal(projection.counts.late, projection.counts.responded);
        results.push({ cycle: cycle + 1, seed, mode, counts: projection.counts, receivedWhilePromptOpen: delivered.size, responsesCreated: responseCreated, createdResponsesNotReceived: responseCreated - projection.counts.responded, restarts, duplicateChecks, latency: { totalVirtualMs: deliveryMs, imposedCenterOutageMs: imposedMs, routeAvailableVirtualMs: availableMs } });
      } finally { store.close(); for (const queue of queues) queue.close(); }
    }
    const totals = Object.fromEntries(Object.keys(results[0].counts).map((key) => [key, results.reduce((sum, row) => sum + row.counts[key], 0)]));
    return { version: 1, scenario: "SIMULACRO ficticio de inundación y refugio en Yucatán", evidence: "VIRTUAL_SIMULATION_ONLY", units: "device-request pairs; not people", configuration: { cycles, baseSeed, devicesPerCycle: 5, scopedRecipientsPerCycle: 4, silentRecipientsPerReachableCycle: 1, lossRate: .25, tickVirtualMs: 1_000, promptVirtualMs: PROMPT_MS, responseVirtualMs: RESPONSE_MS, observationVirtualMs: 70_000, externalInternetUsed: false }, totals, latency: { totalVirtualMs: statistics(results.flatMap(row => row.latency.totalVirtualMs)), imposedCenterOutageMs: statistics(results.flatMap(row => row.latency.imposedCenterOutageMs)), routeAvailableVirtualMs: statistics(results.flatMap(row => row.latency.routeAvailableVirtualMs)) }, cycles: results, limitations: ["No Android, radio, BLE, range or battery measurement", "Seeded loss and 1-second scheduling, not real latency", "Test actor marks SHOWN; actual presentation is verified separately in Chromium", "Restart is clean SQLite close/reopen, not power loss", "Commands never received cannot be answered offline", "UNKNOWN is lack of response, never evidence of danger"] };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
