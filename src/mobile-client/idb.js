const DATABASE = "emergency-mesh-client";
const VERSION = 1;

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function openClientDatabase(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) throw new Error("IndexedDB no está disponible");
  const request = indexedDb.open(DATABASE, VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains("outbox")) database.createObjectStore("outbox", { keyPath: "eventId" });
    if (!database.objectStoreNames.contains("settings")) database.createObjectStore("settings", { keyPath: "key" });
  };
  const database = await requestPromise(request);
  const transaction = (storeName, mode, operation) => new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try { result = operation(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
  return {
    put: (item) => transaction("outbox", "readwrite", (store) => store.put(item)),
    get: (eventId) => transaction("outbox", "readonly", (store) => store.get(eventId)),
    list: () => transaction("outbox", "readonly", (store) => store.getAll()).then((items) => items.sort((a, b) => b.createdAt - a.createdAt)),
    remove: (eventId) => transaction("outbox", "readwrite", (store) => store.delete(eventId)),
    getSetting: (key) => transaction("settings", "readonly", (store) => store.get(key)).then((item) => item?.value),
    setSetting: (key, value) => transaction("settings", "readwrite", (store) => store.put({ key, value })),
    close: () => database.close(),
  };
}
