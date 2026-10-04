import { canonicalCbor } from "./crypto.js";
import { createCheckinReceipt, createCheckinResponse, createCheckinUpdate, createCheckinNeeds, verifyCommandForDevice } from "./commands.js";
import { createNoticeReceipt, verifyNoticeForDevice, validAuthorityKinds } from "./notices.js";

const fromBase64 = (value) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

/** Explicit public-file import plus independently verified fingerprint; never bootstrap trust from inbox. */
export async function verifyPilotTrust(document, expectedFingerprint, origin) {
  if (!document || document.version !== 1 || document.origin !== origin || !Array.isArray(document.authorities) || document.authorities.length !== 1
    || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error("Invalid pilot trust configuration");
  const authority = document.authorities[0];
  if (!authority || typeof authority.publicKey !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(authority.publicKey)
    || !Array.isArray(authority.zones) || authority.zones.length < 1 || authority.zones.length > 20 || authority.zones.some((zone) => !/^[A-Za-z0-9_-]{1,80}$/.test(zone))
    || !validAuthorityKinds(authority.kinds)
    || authority.revoked) throw new Error("Invalid pilot authority");
  const publicBytes = fromBase64(authority.publicKey);
  if (publicBytes.length !== 44 || toBase64(publicBytes) !== authority.publicKey) throw new Error("Invalid authority key encoding");
  const digest = await sha256(publicBytes);
  const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (fingerprint !== expectedFingerprint || fingerprint !== document.fingerprint || toBase64(digest).slice(0, 22) !== authority.issuerId) throw new Error("Pilot authority fingerprint mismatch");
  await crypto.subtle.importKey("spki", publicBytes, { name: "Ed25519" }, false, ["verify"]);
  return structuredClone(document);
}

async function requestJson(fetcher, url, options = {}) {
  const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(5_000), ...options });
  let result;
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > 262_144) { await reader.cancel(); throw new Error("API response exceeds client limit"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    result = JSON.parse(new TextDecoder().decode(bytes));
  } else if (typeof response.text === "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > 262_144) throw new Error("API response exceeds client limit");
    result = JSON.parse(text);
  } else result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error ?? `HTTP ${response.status}`); error.status = response.status;
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    if (response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = Math.min(retryAfter * 1_000, 120_000);
    throw error;
  }
  return result;
}
const jsonPost = (value, token) => ({ method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });

export async function enrollPilot(store, identity, input, origin, fetcher = globalThis.fetch) {
  if (identity.mode !== "ED25519") throw new Error("Pilot enrollment requires Ed25519");
  const trust = await verifyPilotTrust(input.trust, input.fingerprint, origin);
  if (!trust.authorities[0].zones.includes(input.zoneId) || typeof input.code !== "string" || input.code.length > 512) throw new Error("Invalid enrollment scope");
  const challenge = await requestJson(fetcher, "/api/mobile/enrollment/challenge", jsonPost({ code: input.code, publicKey: identity.publicKey, zoneId: input.zoneId }));
  if (Object.keys(challenge).length !== 4 || challenge.publicKey !== identity.publicKey || challenge.zoneId !== input.zoneId || !/^[A-Za-z0-9_-]{43}$/.test(challenge.challengeId)
    || !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= Date.now() || challenge.expiresAt > Date.now() + 125_000) throw new Error("Invalid enrollment challenge");
  const key = await crypto.subtle.importKey("jwk", identity.privateKeyJwk, { name: "Ed25519" }, false, ["sign"]);
  const signature = toBase64(new Uint8Array(await crypto.subtle.sign("Ed25519", key, canonicalCbor({ domain: "COLUVI/ENROLLMENT/v1", payload: challenge }))));
  const credential = await requestJson(fetcher, "/api/mobile/enrollment", jsonPost({ challengeId: challenge.challengeId, signature }));
  if (credential.deviceId !== identity.anonymousDeviceId || credential.zoneId !== input.zoneId || !/^[A-Za-z0-9_-]{43}$/.test(credential.token)
    || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt <= Date.now() || credential.expiresAt > Date.now() + 8 * 24 * 60 * 60_000) throw new Error("Invalid participant credential");
  const enrollment = { ...credential, trust, cursor: 0, noticeCursor: 0 };
  await store.saveEnrollment(enrollment);
  return enrollment;
}

export async function currentEnrollment(store, identity) {
  const enrollment = await store.getSetting("coluviEnrollment");
  return enrollment?.deviceId === identity.anonymousDeviceId && identity.mode === "ED25519" ? enrollment : undefined;
}

export async function pollInbox(store, identity, fetcher = globalThis.fetch, now = Date.now()) {
  const enrollment = await currentEnrollment(store, identity);
  if (!enrollment) return { received: 0, rejected: 0, hasMore: false };
  if (enrollment.expiresAt <= now) throw new Error("Participant credential expired");
  const page = await requestJson(fetcher, `/api/mobile/inbox?cursor=${enrollment.cursor}&limit=50`, { headers: { authorization: `Bearer ${enrollment.token}` } });
  if (!Array.isArray(page.commands) || page.commands.length > 50 || !Number.isSafeInteger(page.cursor) || page.cursor < enrollment.cursor || typeof page.hasMore !== "boolean"
    || (page.hasMore && page.cursor <= enrollment.cursor)) throw new Error("Invalid inbox page");
  const receivedAt = Math.max(now, Date.now());
  let received = 0; let rejected = 0;
  for (const report of page.commands) {
    if (!await verifyCommandForDevice(report, enrollment.trust.authorities, enrollment.zoneId, receivedAt, true)) {
      if (report?.createdAt > receivedAt && report.createdAt - receivedAt <= 5 * 60_000
        && await verifyCommandForDevice(report, enrollment.trust.authorities, enrollment.zoneId, report.createdAt, true)) throw new Error("Command clock is ahead; polling will retry");
      rejected += 1; continue;
    }
    const receiptReport = await createCheckinReceipt(report, "RECEIVED", identity, receivedAt);
    const added = await store.receiveCommand({ commandId: report.eventId, deviceId: identity.anonymousDeviceId, report, receivedAt }, { eventId: receiptReport.eventId, report: receiptReport, state: "QUEUED", attempts: 0 });
    if (added) received += 1;
  }
  // Only advance after commands and their receipt custody have committed.
  await store.updateInboxCursor(identity.anonymousDeviceId, enrollment.token, page.cursor);
  return { received, rejected, hasMore: page.hasMore };
}

export async function markCheckinShown(store, identity, commandId, now = Date.now()) {
  const enrollment = await currentEnrollment(store, identity); const record = await store.getCommand(commandId);
  if (!enrollment || !record || record.deviceId !== identity.anonymousDeviceId || record.shownAt !== undefined) return false;
  if (!await verifyCommandForDevice(record.report, enrollment.trust.authorities, enrollment.zoneId, now)) return false;
  const report = await createCheckinReceipt(record.report, "SHOWN", identity, now);
  return store.markCommandShown(commandId, identity.anonymousDeviceId, { eventId: report.eventId, report, state: "QUEUED", attempts: 0 }, now);
}

export async function pollNotices(store, identity, fetcher = globalThis.fetch, now = Date.now()) {
  const enrollment = await currentEnrollment(store, identity);
  if (!enrollment || !enrollment.trust.authorities.some(authority => authority.kinds.includes("OPERATIONAL_NOTICE"))) return { received: 0, rejected: 0, hasMore: false };
  if (enrollment.expiresAt <= now) throw new Error("Participant credential expired");
  const cursor = enrollment.noticeCursor ?? 0;
  const page = await requestJson(fetcher, `/api/mobile/notices?cursor=${cursor}&limit=50`, { headers: { authorization: `Bearer ${enrollment.token}` } });
  if (!Array.isArray(page.notices) || page.notices.length > 50 || !Number.isSafeInteger(page.cursor) || page.cursor < cursor || typeof page.hasMore !== "boolean"
    || (page.hasMore && page.cursor <= cursor)) throw new Error("Invalid notice inbox page");
  let received = 0; let rejected = 0;
  for (const report of page.notices) {
    const receivedAt = Math.max(now, Date.now());
    if (!await verifyNoticeForDevice(report, enrollment.trust.authorities, enrollment.zoneId, receivedAt)) {
      if (report?.createdAt > receivedAt && report.createdAt - receivedAt <= 5 * 60_000
        && await verifyNoticeForDevice(report, enrollment.trust.authorities, enrollment.zoneId, report.createdAt)) throw new Error("Notice clock is ahead; polling will retry");
      rejected++; continue;
    }
    const receipt = await createNoticeReceipt(report, "RECEIVED", identity, receivedAt);
    if (await store.receiveNotice({ noticeId: report.eventId, deviceId: identity.anonymousDeviceId, report, receivedAt }, { eventId: receipt.eventId, report: receipt, state: "QUEUED", attempts: 0 }, enrollment.token)) received++;
  }
  await store.updateNoticeCursor(identity.anonymousDeviceId, enrollment.token, page.cursor);
  return { received, rejected, hasMore: page.hasMore };
}

export async function markNoticeShown(store, identity, noticeId, now = Date.now()) {
  const enrollment = await currentEnrollment(store, identity); const record = await store.getNotice(noticeId);
  if (!enrollment || !record || record.deviceId !== identity.anonymousDeviceId || record.shownAt !== undefined) return false;
  if (!await verifyNoticeForDevice(record.report, enrollment.trust.authorities, enrollment.zoneId, now)) return false;
  const report = await createNoticeReceipt(record.report, "SHOWN", identity, now);
  return store.markNoticeShown(noticeId, identity.anonymousDeviceId, { eventId: report.eventId, report, state: "QUEUED", attempts: 0 }, now);
}

export async function respondToCheckin(store, identity, commandId, status, now = Date.now()) {
  const enrollment = await currentEnrollment(store, identity); const record = await store.getCommand(commandId);
  if (!enrollment || !record || record.deviceId !== identity.anonymousDeviceId) throw new Error("Unknown enrolled check-in");
  if (record.responseEventId) return store.get(record.responseEventId);
  if (!await verifyCommandForDevice(record.report, enrollment.trust.authorities, enrollment.zoneId, now, true)) throw new Error("Check-in is expired or untrusted");
  const item = now < record.report.extensions.coluvi.promptUntil
    ? await createCheckinResponse(record.report, status, identity, now)
    : await createCheckinUpdate(record.report, status, identity, null, now);
  const saved = await store.queueCommandResponse(commandId, identity.anonymousDeviceId, item, null, enrollment.token);
  return saved ? item : store.get((await store.getCommand(commandId)).responseEventId);
}

export async function updateCheckinStatus(store, identity, commandId, status, expectedResponseId, now = Date.now()) {
  const enrollment = await currentEnrollment(store, identity); const record = await store.getCommand(commandId);
  if (!enrollment || !record || record.deviceId !== identity.anonymousDeviceId || !expectedResponseId
    || record.responseEventId !== expectedResponseId) throw new Error("Response changed; review the current state");
  if (!await verifyCommandForDevice(record.report, enrollment.trust.authorities, enrollment.zoneId, now, true)) throw new Error("Check-in is expired or untrusted");
  const previous = record.responseReport ?? (await store.get(expectedResponseId))?.envelope.report;
  if (!previous) throw new Error("Previous response is unavailable");
  const item = await createCheckinUpdate(record.report, status, identity, previous, now);
  if (!await store.queueCommandResponse(commandId, identity.anonymousDeviceId, item, expectedResponseId, enrollment.token, previous)) throw new Error("Response changed; review the current state");
  return item;
}

export async function enrichCheckinNeeds(store, identity, commandId, detail, expectedResponseId, expectedNeedsId = null, now = Date.now()) {
  const enrollment = await currentEnrollment(store, identity); const record = await store.getCommand(commandId);
  if (!enrollment || !record || record.deviceId !== identity.anonymousDeviceId || !expectedResponseId
    || record.responseEventId !== expectedResponseId || (record.needsEventId ?? null) !== expectedNeedsId) throw new Error("Response changed; review the current state");
  if (!await verifyCommandForDevice(record.report, enrollment.trust.authorities, enrollment.zoneId, now, true)) throw new Error("Check-in is expired or untrusted");
  const response = record.responseReport ?? (await store.get(expectedResponseId))?.envelope.report;
  const previous = expectedNeedsId ? record.needsHistory?.find(report => report.eventId === expectedNeedsId) ?? (await store.get(expectedNeedsId))?.envelope.report : null;
  if (expectedNeedsId && !previous) throw new Error("Previous needs detail is unavailable");
  const item = await createCheckinNeeds(record.report, response, detail, identity, previous, now);
  if (!await store.queueCommandNeeds(commandId, identity.anonymousDeviceId, item, expectedResponseId, expectedNeedsId, enrollment.token)) throw new Error("Response changed; review the current state");
  return item;
}

export async function synchronizeReceipts(store, identity, fetcher = globalThis.fetch, now = Date.now()) {
  const enrollment = await currentEnrollment(store, identity);
  if (!enrollment || enrollment.expiresAt <= now) return [];
  const results = [];
  for (const current of (await store.listReceipts()).filter(item => item.report.anonymousDeviceId === identity.anonymousDeviceId && item.state === "QUEUED" && !(item.nextAttemptAt > now)).slice(0, 400)) {
    const item = { ...current };
    if (item.report.validUntil <= now) { item.state = "EXPIRED"; await store.putReceipt(item); results.push(item); continue; }
    item.attempts += 1;
    try {
      const outcome = await requestJson(fetcher, "/api/mobile/receipts", jsonPost({ report: item.report }, enrollment.token));
      if (!["ACCEPTED", "DUPLICATE"].includes(outcome.status)) throw new Error("Receipt not acknowledged");
      item.state = "SYNCED"; item.lastError = undefined; item.nextAttemptAt = undefined;
    } catch (error) {
      item.lastError = error.message; item.nextAttemptAt = now + (error.retryAfterMs ?? Math.min(60_000, 1_000 * 2 ** Math.min(item.attempts, 6)));
    }
    await store.putReceipt(item); results.push(item);
  }
  return results;
}
