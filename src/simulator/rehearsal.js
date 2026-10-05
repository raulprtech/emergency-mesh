import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { setImmediate } from "node:timers/promises";
import { createDeviceIdentityFromSeed } from "../protocol/identity.ts";
import { authorityFor, createCheckinCommand } from "../commands/authority.ts";
import { createOperationalNotice } from "../commands/notices.ts";
import { ColuviStore } from "../commands/store.ts";
import { NoticeStore } from "../commands/notice-store.ts";
import { SqliteStoreAndForwardQueue } from "../storage/sqlite-store.ts";
import { createCheckinResponse, createCheckinUpdate, createCheckinNeeds, createCheckinReceipt } from "../mobile-client/commands.js";
import { createNoticeReceipt } from "../mobile-client/notices.js";

export const REHEARSAL_SCENARIOS = ["INTERMITTENT", "LATE_RESPONSE", "STATE_CHANGES", "EXPIRED_NOTICE", "NO_RESPONSE", "REORDERED_UPDATES"];
const BASE = Date.UTC(2026, 9, 4, 12);
const identityFor = (seed, label) => createDeviceIdentityFromSeed(createHash("sha256").update(`coluvi-rehearsal:${seed}:${label}`).digest());
const mobileIdentity = identity => ({ mode: "ED25519", anonymousDeviceId: identity.anonymousDeviceId,
  publicKey: identity.publicKey.export({ type: "spki", format: "der" }).toString("base64url"), privateKeyJwk: identity.privateKey.export({ format: "jwk" }) });

/** Scenario actors, virtual time and real SQLite contracts. NOT phone, HTTP or radio evidence. */
export async function runRehearsal({ seed = 20261004, scenarios = REHEARSAL_SCENARIOS, signal, progress = () => {} } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Seed must be uint32");
  if (!Array.isArray(scenarios) || !scenarios.length || scenarios.length > REHEARSAL_SCENARIOS.length
    || new Set(scenarios).size !== scenarios.length || scenarios.some(name => !REHEARSAL_SCENARIOS.includes(name))) throw new Error("Select distinct supported rehearsal scenarios");
  signal?.throwIfAborted();
  const root = mkdtempSync("/tmp/coluvi-rehearsal-"); const results = [];
  try {
    for (const scenario of scenarios) {
      await setImmediate(); signal?.throwIfAborted(); progress({ scenario, phase: "STARTED" });
      const issuer = identityFor(seed, `${scenario}:issuer`);
      const authority = { ...authorityFor(issuer, ["refugio-ficticio"]), kinds: ["CHECKIN_REQUEST", "OPERATIONAL_NOTICE"] };
      const devices = [0, 1, 2].map(index => mobileIdentity(identityFor(seed, `${scenario}:${index}`)));
      const path = join(root, scenario + ".sqlite"); const queuePath = join(root, scenario + "-queue.sqlite");
      let store; let notices; let queue;
      const open = () => { store = new ColuviStore(path, [authority]); notices = new NoticeStore(path, [authority]); queue = new SqliteStoreAndForwardQueue(queuePath); };
      const close = () => { queue?.close(); notices?.close(); store?.close(); queue = notices = store = undefined; };
      const timeline = []; let at = BASE; let link = true; let restarts = 0; let accepted = 0; let duplicates = 0;
      const command = createCheckinCommand(issuer, authority, { commandId: `request-${scenario}`, incidentRef: "SIMULACRO-inundacion", zoneId: "refugio-ficticio",
        nonce: `request-${scenario}`, issuedAt: BASE, promptUntil: BASE + 20_000, responseUntil: BASE + 60_000 });
      const notice = createOperationalNotice(issuer, authority, { noticeId: `notice-${scenario}`, incidentRef: "SIMULACRO-inundacion", zoneId: "refugio-ficticio",
        nonce: `notice-${scenario}`, issuedAt: BASE, expiresAt: BASE + 30_000, sourceLabel: "Equipo ficticio", title: "Prueba de enlace",
        message: "SIMULACRO. No contiene instrucciones para una emergencia real.", level: "INFORMATION" });
      const observe = () => {
        const projection = store.projection(command.eventId, at);
        return { requested: projection.counts.requested, responded: projection.counts.responded, safe: projection.counts.safe,
          needsHelp: projection.counts.needsHelp, pending: projection.counts.pending, unknown: projection.counts.unknown, late: projection.counts.late,
          water: projection.needsCounts.WATER, queued: queue.size(), noticeAvailable: notices.inbox(devices[0].anonymousDeviceId, 0, 50, at).notices.length,
          histories: projection.recipients.reduce((sum, row) => sum + row.history.length, 0),
          missingLinks: projection.recipients.flatMap(row => row.history).filter(row => row.link === "MISSING").length };
      };
      const checkpoint = (phase, expected) => {
        signal?.throwIfAborted(); const full = observe(); const observed = Object.fromEntries(Object.keys(expected).map(key => [key, full[key]]));
        timeline.push({ phase, virtualMs: at - BASE, connectionAvailable: link, expected, observed, status: isDeepStrictEqual(expected, observed) ? "PASS" : "FAIL" });
      };
      const enqueue = item => { if (!queue.enqueue(item.envelope, at)) throw new Error("Fixture queue rejected new packet"); };
      const flush = async (reverse = false) => {
        await setImmediate(); signal?.throwIfAborted();
        const rows = queue.ready(at); if (reverse) rows.reverse();
        for (const row of rows) {
          signal?.throwIfAborted();
          if (!link) { queue.recordFailure(row.envelope.report.eventId, at); continue; }
          const result = store.acceptResponse(row.envelope, at);
          if (result.status !== "ACCEPTED" || result.eventId !== row.envelope.report.eventId || result.signatureValid !== true) throw new Error("Rehearsal packet missing correlated store acceptance");
          accepted++;
          if (store.acceptResponse(row.envelope, at).status !== "DUPLICATE") throw new Error("Rehearsal replay was not deduplicated");
          duplicates++; queue.remove(row.envelope.report.eventId);
        }
      };
      try {
        open();
        for (const device of devices) store.enroll(device.publicKey, "refugio-ficticio", at);
        store.issue(command, at); notices.issue(notice, at);
        checkpoint("ISSUED", { requested: 3, responded: 0, pending: 3, noticeAvailable: 1, queued: 0 });
        at = BASE + 1000;
        // Test actors mark presentation. Real browser visibility is tested in Chromium separately.
        for (const device of devices.slice(0, 2)) {
          for (const evidence of ["RECEIVED", "SHOWN"]) {
            store.acceptReceipt(await createCheckinReceipt(command, evidence, device, at), device.anonymousDeviceId, at);
            notices.acceptReceipt(await createNoticeReceipt(notice, evidence, device, at), device.anonymousDeviceId, at);
          }
        }
        if (scenario === "NO_RESPONSE") {
          at = BASE + 21_000; checkpoint("NO_RESPONSE_AFTER_PROMPT", { responded: 0, unknown: 3, needsHelp: 0 });
        } else {
          if (scenario === "LATE_RESPONSE") { at = BASE + 21_000; checkpoint("UNKNOWN_BEFORE_LATE_RESPONSE", { responded: 0, unknown: 3 }); at = BASE + 25_000; }
          else at = BASE + 2000;
          const first = scenario === "LATE_RESPONSE"
            ? await createCheckinUpdate(command, "NEEDS_HELP", devices[0], null, at)
            : await createCheckinResponse(command, "NEEDS_HELP", devices[0], at);
          const second = scenario === "LATE_RESPONSE"
            ? await createCheckinUpdate(command, "SAFE", devices[1], null, at)
            : await createCheckinResponse(command, "SAFE", devices[1], at);
          enqueue(first); enqueue(second);
          if (scenario === "INTERMITTENT") {
            link = false; await flush(); checkpoint("FIRST_OUTAGE", { responded: 0, queued: 2 });
            close(); open(); restarts++; at = BASE + 7000; checkpoint("RESTART_WITH_PENDING", { responded: 0, queued: 2 }); link = true;
          }
          let update;
          if (scenario === "REORDERED_UPDATES") {
            at = BASE + 3000; update = await createCheckinUpdate(command, "SAFE", devices[0], first.envelope.report, at);
            // Deliver the successor separately before its queued predecessor.
            const result = store.acceptResponse(update.envelope, at); if (result.status !== "ACCEPTED") throw new Error("Reordered update rejected"); accepted++;
            if (store.acceptResponse(update.envelope, at).status !== "DUPLICATE") throw new Error("Reordered update not deduplicated"); duplicates++;
            checkpoint("SUCCESSOR_BEFORE_PREDECESSOR", { responded: 1, safe: 1, missingLinks: 1, queued: 2 });
          }
          await flush((seed & 1) === 1);
          checkpoint("INITIAL_DELIVERY", { responded: 2, safe: scenario === "REORDERED_UPDATES" ? 2 : 1,
            needsHelp: scenario === "REORDERED_UPDATES" ? 0 : 1, queued: 0, missingLinks: 0, late: scenario === "LATE_RESPONSE" ? 2 : 0 });
          if (["STATE_CHANGES", "INTERMITTENT"].includes(scenario)) {
            at += 1000; const needs = await createCheckinNeeds(command, first.envelope.report, { categories: ["WATER"] }, devices[0], null, at);
            enqueue(needs); await flush(); checkpoint("HELP_ENRICHED", { water: 1, needsHelp: 1, responded: 2 });
            at += 1000; update = await createCheckinUpdate(command, "SAFE", devices[0], first.envelope.report, at); enqueue(update);
            if (scenario === "INTERMITTENT") {
              link = false; await flush(); checkpoint("SECOND_OUTAGE", { queued: 1, needsHelp: 1 });
              close(); open(); restarts++; at += 5000; link = true;
            }
            await flush(); checkpoint("SAFE_UPDATE_RECOVERED", { safe: 2, needsHelp: 0, water: 0, histories: 3, queued: 0 });
          }
        }
        at = BASE + 31_000;
        checkpoint("NOTICE_EXPIRED", { noticeAvailable: 0, unknown: scenario === "NO_RESPONSE" ? 3 : 1 });
        const before = observe(); close(); open(); restarts++;
        checkpoint("RESTART_PRESERVES_PROJECTION", before);
        at = BASE + 61_000;
        checkpoint("CLOSED_WITHOUT_INVENTING_DANGER", { pending: 0, unknown: scenario === "NO_RESPONSE" ? 3 : 1, queued: 0 });
        const noticeCounts = notices.projection(notice.eventId).counts;
        results.push({ scenario, status: timeline.every(row => row.status === "PASS") ? "PASS" : "FAIL", timeline, acceptedPackets: accepted, duplicateChecks: duplicates,
          restarts, final: observe(), noticeCounts, simulationOnly: true });
        progress({ scenario, phase: "COMPLETED", status: results.at(-1).status });
      } finally { close(); }
    }
    return { version: 1, kind: "COLUVI_REHEARSAL", status: results.every(row => row.status === "PASS") ? "PASS" : "FAIL", seed,
      evidence: "VIRTUAL_TIME_REAL_SQLITE", scenarios: results,
      limitations: ["Scenario actors, not users or browsers", "Virtual time, not a sustained real-time test", "No HTTP, TLS, Android, radio or battery validation", "Known fixture keys are for simulation only", "UNKNOWN means no response, not danger"] };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
