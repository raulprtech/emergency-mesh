import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const STEPS = ["tests", "rehearsal", "integrated-browser", "client-continuity", "mobile-readiness", "map-browser", "soak-smoke", "load-300"];
const SCENARIOS = ["INTERMITTENT", "LATE_RESPONSE", "STATE_CHANGES", "EXPIRED_NOTICE", "NO_RESPONSE", "REORDERED_UPDATES"];
const threeHours = 10_800_000;
const check = (condition, code) => assert.ok(condition, code);
const count = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isFinite(value) && value > 0;
const truth = (value, keys, code) => check(keys.every(key => value?.[key] === true), code);
function provenance(report, archives, runtimeHash) {
  const source = report?.provenance;
  check(source?.dirtyWorktree === false && /^[0-9a-f]{40}$/.test(source.baseCommit), "UNCLEAN_OR_MISSING_PROVENANCE");
  const archive = archives[source.baseCommit];
  check(archive && source.sourceSha256 === archive.sourceSha256, "SOURCE_HASH_MISMATCH");
  check(archive.workloadSha256 === runtimeHash, "WORKLOAD_CHANGED_SINCE_EVIDENCE");
}
function load(report, devices, mixed) {
  const packets = devices * 27 / 10;
  check(report?.configuration?.devices === devices && report.configuration.mixed === mixed, "LOAD_PROFILE_MISMATCH");
  check(report.evidence === "LOCAL_HTTP_SQLITE_ONLY", "LOAD_EVIDENCE_KIND");
  check(report.counts?.uniqueSignedPackets === packets && report.http?.fullReplayDuplicates === packets, "LOAD_PACKET_COUNTS");
  for (const [key, expected] of Object.entries({ requested: devices, responded: devices * 9 / 10, safe: devices * 4 / 10,
    needsHelp: devices / 2, pending: devices / 10, activeWater: devices / 2, activeTransport: devices / 2 })) check(report.counts[key] === expected, "LOAD_PROJECTION_COUNTS");
  check(report.http.accepted === packets && report.http.duplicates === packets, "LOAD_ACK_COUNTS");
  check(report.http.requestsOutstandingAtKill > 0, "LOAD_CRASH_NOT_IN_FLIGHT");
  check(report.crashes?.length === 2 && report.crashes[1].acknowledgedVerified === packets, "LOAD_FINAL_AUDIT_MISSING");
  for (const audit of report.crashes) check(audit.signal === "SIGKILL" && audit.integrity === "ok" && audit.foreignKeyViolations === 0
    && audit.persisted >= audit.acknowledgedVerified && audit.acknowledgedVerified > 0, "LOAD_DURABILITY_FAILED");
  truth(report.checks, ["allAcknowledgedReportsDurable", "immutableHistoryAfterReplay", "allRecipientPagesVerified", "missingPredecessorsExplicitBeforeArrival",
    "independentlyArrivingNeedsVerified", "privateReportsExcludedFromPublicMap", "operatorSessionInvalidated"], "LOAD_INVARIANT_MISSING");
  check(report.checks.invalidPacketsRejectedWithoutAck === 2 && report.checks.sampledCredentialsSurviveRestarts === 3, "LOAD_NEGATIVE_OR_CREDENTIAL_CHECK_MISSING");
  if (mixed) {
    const reads = report.measurements?.mixedWorkload;
    check(report.status === "PASS" && report.sourceUnchanged === true && reads?.enabled === true && reads.concurrentReaders === 6
      && reads.noticesIssued === 3 && reads.successfulReads >= 6 && reads.failedReads === 0, "MIXED_LOAD_FAILED");
    check(report.measurements.server.samples > 0, "SERVER_METRICS_MISSING");
    for (const route of ["GET /health", "GET /api/areas", "GET /api/operator/checkins", "GET /api/operator/notices", "GET /api/mobile/inbox", "GET /api/mobile/notices"]) {
      check(report.measurements.endpoints?.[route]?.httpStatuses?.[200] > 0, "MIXED_ENDPOINT_NOT_EXERCISED");
    }
    for (const metric of Object.values(report.measurements.endpoints)) check(!metric.errors?.TIMEOUT, "MIXED_TIMEOUT_RECORDED");
  }
}

/** Consistency gate for locally produced reports; not a signature or third-party attestation. */
export function verifyRc2Evidence({ qualification: q, mixed300, mixed990, soak: s }, { current, archives }) {
  check(q?.version === 1 && q.status === "PASS", "QUALIFICATION_NOT_PASS");
  provenance(q, archives, current.workloadSha256);
  check(q.provenance.sourceSha256 === current.sourceSha256, "CURRENT_SOURCE_NOT_QUALIFIED");
  check(q.environment?.distro === "Ubuntu", "QUALIFICATION_NOT_UBUNTU");
  check(count(q.tests?.tests) && q.tests.tests >= 217 && q.tests.pass === q.tests.tests, "TEST_SUITE_INCOMPLETE");
  for (const field of ["fail", "cancelled", "skipped", "todo"]) check(q.tests[field] === 0, "TEST_SUITE_NOT_CLEAN");
  check(isDeepStrictEqual(q.steps?.map(step => step.name), STEPS), "QUALIFICATION_STEPS_MISSING");
  for (const step of q.steps) check(step.code === 0 && step.signal === null && step.timedOut === false && step.exceededOutputLimit === false && positive(step.wallMs), "QUALIFICATION_STEP_FAILED");
  for (const nested of [q.rehearsal, q.readiness, q.soakSmoke]) {
    check(nested?.status === "PASS" && nested.sourceUnchanged === true, "NESTED_EVIDENCE_NOT_PASS");
    check(nested.provenance?.baseCommit === q.provenance.baseCommit && nested.provenance.sourceSha256 === q.provenance.sourceSha256
      && nested.provenance.dirtyWorktree === false, "NESTED_PROVENANCE_MISMATCH");
  }
  check(isDeepStrictEqual(q.rehearsal.scenarios?.map(row => row.scenario), SCENARIOS), "REHEARSAL_SCENARIOS_MISSING");
  for (const scenario of q.rehearsal.scenarios) {
    check(scenario.status === "PASS" && scenario.timeline?.length > 0, "REHEARSAL_FAILED");
    for (const point of scenario.timeline) check(point.status === "PASS" && isDeepStrictEqual(point.expected, point.observed), "REHEARSAL_CHECKPOINT_MISMATCH");
  }
  const expectedCases = [320, 360, 412].flatMap(width => [1, 2].flatMap(scale => ["es", "en"].map(lang => `${width}:${scale}:${lang}`)));
  check(isDeepStrictEqual(q.readiness.cases?.map(row => `${row.width}:${row.textScale}:${row.language}`).sort(), expectedCases.sort()), "READINESS_CASES_MISSING");
  for (const row of q.readiness.cases) check(row.status === "PASS" && row.layout?.width === row.width && row.layout.horizontalOverflow === false
    && row.layout.overflow?.length === 0 && row.layout.undersized?.length === 0 && row.unnamedInteractive?.length === 0
    && row.layout.composerFocused === true && row.layout.focusRestored === true, "READINESS_LAYOUT_FAILED");
  check(q.continuity?.status === "PASS", "CONTINUITY_NOT_PASS");
  truth(q.continuity, ["browserKilledWithSIGKILL", "reopenedWithoutServer", "signedPacketUnchangedAfterCrash", "actualRC1AssetsUsed",
    "pendingPacketUnchangedAfterUpgrade", "postCommitReadFailureDistinguished", "failedLocalAckRetriedAsDuplicate"], "CONTINUITY_EVIDENCE_MISSING");
  check(isDeepStrictEqual(q.continuity.faultEvidence?.map(row => row.mode).sort(), ["ABORT", "QUOTA"]), "STORAGE_FAULT_CASES_MISSING");
  for (const row of q.continuity.faultEvidence) truth(row, ["originalPreserved", "noFalseSavedReport", "draftPreserved"], "STORAGE_FAULT_CHECK_FAILED");
  check(q.continuity.diagnostics?.length === 0 && q.integrated?.diagnostics?.length === 0, "BROWSER_DIAGNOSTICS_PRESENT");
  truth(q.integrated, ["publicPrivacy", "cacheSafe", "backendStoppedWhileOffline", "survivedWindowCloseAndReopen", "duplicatePreserved"], "INTEGRATED_EVIDENCE_MISSING");
  truth(q.integrated.integratedMapEvidence, ["sameBackendAndOrigin", "offlineSnapshotDuringPrivateResponse", "privateUpdatesDoNotChangePublicCounts", "reloadsRequireNewDocument"], "INTEGRATED_MAP_EVIDENCE_MISSING");
  check(q.integrated.reconnectedState === "SYNCED", "RECONNECT_NOT_CONFIRMED");
  const diagnostics = q.integrated.deviceDiagnosticEvidence;
  check(diagnostics?.offline?.pending === 2 && diagnostics.reconnected?.pending === 0 && diagnostics.reconnected.server === "REACHABLE", "DEVICE_DIAGNOSTIC_COUNTS");
  check(diagnostics.offline.privateValuesExcluded === true && diagnostics.reconnected.privateValuesExcluded === true, "DIAGNOSTIC_PRIVACY_MISSING");
  truth(q.map, ["offlineAfterAbruptStop", "expiredSnapshotRejected", "privateFieldsExcluded"], "MAP_EVIDENCE_MISSING");
  check(q.map.status === "PASS" && q.map.cachedApiPaths === 0 && q.soakSmoke.qualifiesThreeHours === false, "MAP_OR_SHORT_SOAK_INVALID");
  load(q.load, 300, false);
  for (const [report, devices] of [[mixed300, 300], [mixed990, 990]]) {
    provenance(report, archives, current.workloadSha256); load(report, devices, true);
  }
  check(s?.version === 1 && s.status === "PASS" && s.sourceUnchanged === true && s.evidence === "SUSTAINED_LOCAL_HTTP_REAL_TIME", "SOAK_NOT_COMPLETE");
  provenance(s, archives, current.workloadSha256);
  check(s.qualifiesThreeHours === true && Number.isFinite(s.observedMs) && s.observedMs >= threeHours, "SOAK_TOO_SHORT");
  const elapsedWall = Date.parse(s.completedAt) - Date.parse(s.startedAt);
  check(Number.isFinite(elapsedWall) && elapsedWall >= threeHours - 2000 && Math.abs(elapsedWall - s.observedMs) < 5000, "SOAK_CLOCK_INCONSISTENT");
  check(Number.isFinite(s.configuration?.durationMs) && s.configuration.durationMs >= threeHours && s.configuration.durationMs <= s.observedMs && s.configuration.devices === 30
    && s.configuration.restartEvery === 20 && s.configuration.intervalMs === 30_000, "SOAK_PROFILE_MISMATCH");
  const c = s.counts;
  check(c && Object.values(c).every(count), "SOAK_COUNTS_INVALID");
  check(count(c?.rounds) && c.rounds >= 20 && c.rounds <= 1000, "SOAK_ROUNDS_INVALID");
  check(c.restarts === Math.floor(c.rounds / 20) && c.duplicates === c.restarts * 81, "SOAK_RESTART_COUNTS");
  check(c.commands === c.rounds * 3 && c.notices === c.rounds * 3 && c.receiptAcknowledgements === c.rounds * 54, "SOAK_OPERATION_COUNTS");
  check(s.acknowledgedPackets === c.rounds * 81 && c.packetAcknowledgements === s.acknowledgedPackets + c.duplicates, "SOAK_ACK_COUNTS");
  check(c.heartbeats >= c.rounds && s.roundMs?.samples === c.rounds && s.server?.samples > 0, "SOAK_OBSERVATION_MISSING");
  check(s.audits?.length === c.restarts + 1, "SOAK_AUDITS_MISSING");
  for (const [index, audit] of s.audits.entries()) {
    const final = index === c.restarts; const round = final ? c.rounds : (index + 1) * 20;
    check(audit.label === (final ? "FINAL" : "AFTER_SIGKILL") && audit.round === round && audit.acknowledgedPacketsVerified === round * 81
      && audit.integrity === "ok" && audit.foreignKeyViolations === 0, "SOAK_AUDIT_FAILED");
  }
  for (const metric of Object.values(s.endpoints ?? {})) check(metric.failures === 0, "SOAK_ENDPOINT_FAILURE");
  for (const [route, status, expected] of [["POST /api/packets", 202, c.packetAcknowledgements], ["POST /api/mobile/receipts", 202, c.receiptAcknowledgements],
    ["POST /api/operator/checkins", 201, c.commands], ["POST /api/operator/notices", 201, c.notices], ["GET /api/operator/session", 401, c.restarts]]) {
    check(s.endpoints?.[route]?.statuses?.[status] === expected, "SOAK_ENDPOINT_COUNTS");
  }
  for (const route of ["GET /health", "GET /api/areas"]) check(s.endpoints?.[route]?.statuses?.[200] >= c.heartbeats, "SOAK_HEARTBEAT_EVIDENCE_MISSING");
  return { status: "PASS", scope: "LOCAL_SOFTWARE_RC2", tests: q.tests.tests, mixedDevices: [300, 990], observedMs: s.observedMs,
    soakRounds: c.rounds, backendRestarts: c.restarts, acknowledgedPackets: s.acknowledgedPackets,
    sourceSha256: current.sourceSha256, workloadSha256: current.workloadSha256,
    physicalAndroid: "PENDING", originalTimeoutCause: "NOT_ESTABLISHED",
    limitations: ["Consistency checks of local reports, not authenticated third-party attestation", "PASS is not guaranteed capacity or production emergency certification", "Read the separate failed contention profiles before setting operational limits"] };
}
