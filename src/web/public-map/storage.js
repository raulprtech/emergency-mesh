import { publicSnapshot } from "./model.js";

export async function openPublicMapStore() {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("coluvi-public-map", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("snapshot");
    request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
  });
  database.onversionchange = () => database.close();
  const run = (mode, callback) => new Promise((resolve, reject) => {
    const tx = database.transaction("snapshot", mode); const request = callback(tx.objectStore("snapshot"));
    tx.oncomplete = () => resolve(request?.result); tx.onabort = tx.onerror = () => reject(tx.error);
  });
  return {
    async read(now = Date.now()) {
      const value = await run("readonly", store => store.get("last"));
      if (!value) return undefined;
      try { return publicSnapshot(value, now); } catch { await run("readwrite", store => store.delete("last")); return undefined; }
    },
    save: value => run("readwrite", store => store.put(publicSnapshot(value), "last")),
    clear: () => run("readwrite", store => store.delete("last")),
    close: () => database.close(),
  };
}
