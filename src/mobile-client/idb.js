const DATABASE = "emergency-mesh-client";
const VERSION = 3;

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function openClientDatabase(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) throw new Error("IndexedDB no está disponible");
  const request = indexedDb.open(DATABASE, VERSION);
  request.onblocked = () => globalThis.dispatchEvent?.(new Event("CLIENT_DATABASE_BLOCKED"));
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains("outbox")) database.createObjectStore("outbox", { keyPath: "eventId" });
    if (!database.objectStoreNames.contains("settings")) database.createObjectStore("settings", { keyPath: "key" });
    if (!database.objectStoreNames.contains("inbox")) database.createObjectStore("inbox", { keyPath: "commandId" });
    if (!database.objectStoreNames.contains("receipts")) database.createObjectStore("receipts", { keyPath: "eventId" });
    if (!database.objectStoreNames.contains("notices")) database.createObjectStore("notices", { keyPath: "noticeId" });
  };
  const database = await requestPromise(request);
  database.onversionchange = () => { database.close(); globalThis.dispatchEvent?.(new Event("CLIENT_DATABASE_BLOCKED")); };
  const transaction = (storeName, mode, operation) => new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try { result = operation(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(result && typeof result === "object" && "result" in result ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
  const atomic = (names, operation) => new Promise((resolve, reject) => {
    const tx = database.transaction(names, "readwrite");
    const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
    let result;
    const fail = (error) => { try { tx.abort(); } catch { /* already aborted */ } reject(error); };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    try { operation(stores, (value) => { result = value; }, fail); } catch (error) { fail(error); }
  });
  return {
    put: (item) => transaction("outbox", "readwrite", (store) => store.put(item)),
    get: (eventId) => transaction("outbox", "readonly", (store) => store.get(eventId)),
    list: () => transaction("outbox", "readonly", (store) => store.getAll()).then((items) => items.sort((a, b) => b.createdAt - a.createdAt)),
    remove: (eventId) => transaction("outbox", "readwrite", (store) => store.delete(eventId)),
    getSetting: (key) => transaction("settings", "readonly", (store) => store.get(key)).then((item) => item?.value),
    setSetting: (key, value) => transaction("settings", "readwrite", (store) => store.put({ key, value })),
    saveEnrollment: (enrollment) => atomic(["settings"], ({ settings }, done, fail) => {
      const request = settings.get("identity");
      request.onsuccess = () => {
        if (request.result?.value?.anonymousDeviceId !== enrollment.deviceId) return fail(new Error("Identity changed during enrollment"));
        settings.put({ key: "coluviEnrollment", value: enrollment }); done(true);
      };
    }),
    updateInboxCursor: (deviceId, token, cursor) => atomic(["settings"], ({ settings }, done, fail) => {
      const request = settings.get("coluviEnrollment");
      request.onsuccess = () => {
        const enrollment = request.result?.value;
        if (!enrollment || enrollment.deviceId !== deviceId || enrollment.token !== token) return fail(new Error("Enrollment changed during polling"));
        settings.put({ key: "coluviEnrollment", value: { ...enrollment, cursor: Math.max(enrollment.cursor, cursor) } }); done(true);
      };
    }),
    replaceIdentity: (identity) => atomic(["settings"], ({ settings }, done) => {
      settings.put({ key: "identity", value: identity }); settings.put({ key: "coluviEnrollment", value: undefined }); done(true);
    }),
    updateNoticeCursor: (deviceId, token, cursor) => atomic(["settings"], ({ settings }, done, fail) => {
      const request = settings.get("coluviEnrollment");
      request.onsuccess = () => {
        const enrollment = request.result?.value;
        if (!enrollment || enrollment.deviceId !== deviceId || enrollment.token !== token) return fail(new Error("Enrollment changed during notice polling"));
        settings.put({ key: "coluviEnrollment", value: { ...enrollment, noticeCursor: Math.max(enrollment.noticeCursor ?? 0, cursor) } }); done(true);
      };
    }),
    getNotice: noticeId => transaction("notices", "readonly", store => store.get(noticeId)),
    listNotices: () => transaction("notices", "readonly", store => store.getAll()).then(items => items.sort((a, b) => b.report.createdAt - a.report.createdAt)),
    receiveNotice: (record, receipt, token) => atomic(["notices", "receipts", "settings"], ({ notices, receipts, settings }, done, fail) => {
      const enrollment = settings.get("coluviEnrollment");
      enrollment.onsuccess = () => {
        if (enrollment.result?.value?.deviceId !== record.deviceId || enrollment.result.value.token !== token) return fail(new Error("Enrollment changed during notice custody"));
        const request = notices.get(record.noticeId);
        request.onsuccess = () => {
          if (request.result) {
            if (request.result.report.signature.value !== record.report.signature.value || request.result.deviceId !== record.deviceId) return fail(new Error("Notice conflict"));
            return done(false);
          }
          const count = notices.count(); count.onsuccess = () => {
            if (count.result >= 200) return fail(new Error("Notice inbox capacity exceeded"));
            notices.put(record); receipts.put(receipt); done(true);
          };
        };
      };
    }),
    markNoticeShown: (noticeId, deviceId, receipt, at) => atomic(["notices", "receipts", "settings"], ({ notices, receipts, settings }, done, fail) => {
      const enrollment = settings.get("coluviEnrollment");
      enrollment.onsuccess = () => {
        if (enrollment.result?.value?.deviceId !== deviceId) return fail(new Error("Enrollment changed before notice presentation"));
        const request = notices.get(noticeId); request.onsuccess = () => {
          const record = request.result;
          if (!record || record.deviceId !== deviceId) return fail(new Error("Unknown notice recipient"));
          if (record.shownAt !== undefined) return done(false);
          notices.put({ ...record, shownAt: at }); receipts.put(receipt); done(true);
        };
      };
    }),
    pruneNotices: (now = Date.now()) => atomic(["notices"], ({ notices }, done) => {
      let removed = 0; const request = notices.openCursor(); request.onsuccess = () => {
        const cursor = request.result; if (!cursor) return done(removed);
        if (cursor.value.report.validUntil + 30 * 24 * 60 * 60_000 <= now) { cursor.delete(); removed++; }
        cursor.continue();
      };
    }),
    getCommand: (commandId) => transaction("inbox", "readonly", (store) => store.get(commandId)),
    listCommands: () => transaction("inbox", "readonly", (store) => store.getAll()).then((items) => items.sort((a, b) => b.receivedAt - a.receivedAt)),
    receiveCommand: (record, receipt) => atomic(["inbox", "receipts"], ({ inbox, receipts }, done, fail) => {
      const request = inbox.get(record.commandId);
      request.onsuccess = () => {
        if (request.result) {
          if (request.result.report.signature.value !== record.report.signature.value || request.result.deviceId !== record.deviceId) return fail(new Error("Inbox command conflict"));
          return done(false);
        }
        const count = inbox.count();
        count.onsuccess = () => {
          if (count.result >= 200) return fail(new Error("Inbox capacity exceeded"));
          inbox.put(record); receipts.put(receipt); done(true);
        };
      };
    }),
    markCommandShown: (commandId, deviceId, receipt, at) => atomic(["inbox", "receipts"], ({ inbox, receipts }, done, fail) => {
      const request = inbox.get(commandId);
      request.onsuccess = () => {
        const record = request.result;
        if (!record || record.deviceId !== deviceId) return fail(new Error("Unknown command recipient"));
        if (record.shownAt !== undefined) return done(false);
        inbox.put({ ...record, shownAt: at }); receipts.put(receipt); done(true);
      };
    }),
    queueCommandResponse: (commandId, deviceId, item, expectedResponseId, token, previousReport = null) => atomic(["inbox", "outbox", "settings"], ({ inbox, outbox, settings }, done, fail) => {
      const enrollment = settings.get("coluviEnrollment");
      enrollment.onsuccess = () => {
        if (enrollment.result?.value?.deviceId !== deviceId || enrollment.result.value.token !== token) return fail(new Error("Enrollment changed before response custody"));
        const request = inbox.get(commandId);
        request.onsuccess = () => {
          const record = request.result;
          if (!record || record.deviceId !== deviceId) return fail(new Error("Unknown command recipient"));
          if ((record.responseEventId ?? null) !== (expectedResponseId ?? null)) return done(false);
          const previous = record.responseReport ?? previousReport;
          const history = record.responseHistory ?? (previous && previous.eventId === record.responseEventId ? [previous] : []);
          if (history.length >= 100) return fail(new Error("Response history capacity exceeded"));
          const report = item.envelope.report;
          outbox.put(item); inbox.put({ ...record, responseEventId: item.eventId, responseStatus: report.extensions.coluvi.status,
            responseReport: report, responseHistory: [...history, report], needsEventId: null }); done(true);
        };
      };
    }),
    queueCommandNeeds: (commandId, deviceId, item, expectedResponseId, expectedNeedsId, token) => atomic(["inbox", "outbox", "settings"], ({ inbox, outbox, settings }, done, fail) => {
      const enrollment = settings.get("coluviEnrollment");
      enrollment.onsuccess = () => {
        if (enrollment.result?.value?.deviceId !== deviceId || enrollment.result.value.token !== token) return fail(new Error("Enrollment changed before needs custody"));
        const request = inbox.get(commandId);
        request.onsuccess = () => {
          const record = request.result;
          if (!record || record.deviceId !== deviceId) return fail(new Error("Unknown command recipient"));
          if (record.responseEventId !== expectedResponseId || (record.needsEventId ?? null) !== (expectedNeedsId ?? null) || record.responseStatus !== "NEEDS_HELP") return done(false);
          const history = record.needsHistory ?? [];
          if (history.length >= 100) return fail(new Error("Needs history capacity exceeded"));
          const report = item.envelope.report;
          outbox.put(item); inbox.put({ ...record, needsEventId: item.eventId, needsHistory: [...history, report] }); done(true);
        };
      };
    }),
    putReceipt: (receipt) => transaction("receipts", "readwrite", (store) => store.put(receipt)),
    listReceipts: () => transaction("receipts", "readonly", (store) => store.getAll()),
    pruneInbox: (now = Date.now()) => atomic(["inbox", "receipts"], ({ inbox, receipts }, done) => {
      let removed = 0;
      const request = inbox.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return done(removed);
        if (cursor.value.report.validUntil + 30 * 24 * 60 * 60_000 <= now) { cursor.delete(); removed += 1; }
        cursor.continue();
      };
      const receiptCursor = receipts.openCursor();
      receiptCursor.onsuccess = () => {
        const cursor = receiptCursor.result;
        if (!cursor) return;
        if (cursor.value.report.validUntil + 30 * 24 * 60 * 60_000 <= now) cursor.delete();
        cursor.continue();
      };
    }),
    close: () => database.close(),
  };
}
