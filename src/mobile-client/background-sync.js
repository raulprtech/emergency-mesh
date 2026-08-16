import { synchronizeOutbox } from "./core.js";
import { openClientDatabase } from "./idb.js";

export const OUTBOX_SYNC_TAG = "emergency-mesh-outbox";
export const OUTBOX_SYNC_LOCK = "emergency-mesh-outbox-sync";

export async function synchronizeOutboxExclusively(store, options = {}) {
  const synchronize = options.synchronize ?? synchronizeOutbox;
  const locks = options.locks ?? globalThis.navigator?.locks;
  const run = () => synchronize(store, options.fetcher, options.endpoint, options.now);
  return typeof locks?.request === "function"
    ? locks.request(OUTBOX_SYNC_LOCK, run)
    : run();
}

export async function runBackgroundSync(options = {}) {
  const database = await (options.openDatabase ?? openClientDatabase)();
  try {
    const results = await synchronizeOutboxExclusively(database, options);
    if (results.some((item) => item.state === "QUEUED")) {
      throw new Error("Outbox still contains reports awaiting backend custody");
    }
    return results;
  } finally {
    database.close();
  }
}
