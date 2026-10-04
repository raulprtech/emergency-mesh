const DATABASE = "emergency-mesh-client";
const VERSION = 2;

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
    queueCommandResponse: (commandId, deviceId, item) => atomic(["inbox", "outbox"], ({ inbox, outbox }, done, fail) => {
      const request = inbox.get(commandId);
      request.onsuccess = () => {
        const record = request.result;
        if (!record || record.deviceId !== deviceId) return fail(new Error("Unknown command recipient"));
        if (record.responseEventId) return done(false);
        outbox.put(item); inbox.put({ ...record, responseEventId: item.eventId, responseStatus: item.envelope.report.extensions.coluvi.status }); done(true);
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
