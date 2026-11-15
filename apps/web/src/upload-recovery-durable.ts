import { isUploadRecoveryRecord, listUploadRecovery, removeUploadRecovery, saveUploadRecovery, validateUploadRecoveryTransition, type UploadRecoveryRecord } from "./upload-recovery-store.js";
import { errorValue } from "./error-value.js";

const DATABASE = "saturn-upload-recovery-v2", RECORDS = "originals", META = "metadata";
let opening: Promise<IDBDatabase> | undefined;
function transaction<T>(database: IDBDatabase, writable: boolean, action: (tx: IDBTransaction, setResult: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = writable ? database.transaction([RECORDS, META], "readwrite", { durability: "strict" }) : database.transaction(RECORDS, "readonly");
      if (writable && tx.durability !== "strict") { tx.abort(); throw new Error("This browser cannot confirm durable upload identities. Use a browser supporting strict IndexedDB transactions."); }
    } catch (error) { reject(errorValue(error)); return; }
    let result: T, failure: unknown;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(errorValue(failure ?? tx.error ?? new Error("Upload recovery transaction was aborted; no new upload was admitted.")));
    tx.onerror = () => { failure ??= tx.error; };
    const fail = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(errorValue(error)); } };
    try { action(tx, value => { result = value; }, fail); } catch (error) { fail(error); }
  });
}
function checkedRows(value: unknown): readonly UploadRecoveryRecord[] {
  if (!Array.isArray(value) || value.length > 128 || value.some(item => !isUploadRecoveryRecord(item) || new TextEncoder().encode(JSON.stringify(item)).byteLength > 4096)) throw new Error("Durable upload recovery metadata is invalid.");
  return value as UploadRecoveryRecord[];
}
async function database(): Promise<IDBDatabase> {
  opening ??= (async () => {
    if (typeof indexedDB === "undefined") throw new Error("Durable upload recovery storage is unavailable in this browser.");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      let abandoned = false;
      request.onupgradeneeded = () => {
        request.result.createObjectStore(RECORDS, { keyPath: "operationId" });
        request.result.createObjectStore(META);
      };
      request.onerror = () => reject(request.error ?? new Error("Cannot open upload recovery storage."));
      request.onblocked = () => { abandoned = true; reject(new Error("Upload recovery storage is blocked by another browser tab.")); };
      request.onsuccess = () => { if (abandoned) request.result.close(); else resolve(request.result); };
    });
    db.onversionchange = () => { db.close(); opening = undefined; };
    try {
      // Import the already deployed localStorage-v2 workset ONCE. A later empty
      // database must not resurrect a completed operation from an old UI cache.
      await transaction<undefined>(db, true, (tx, done, fail) => {
        const marker = tx.objectStore(META).get("localStorageV2Imported");
        marker.onsuccess = () => {
          try {
            if (marker.result !== true) {
              for (const record of listUploadRecovery()) tx.objectStore(RECORDS).add(record);
              tx.objectStore(META).put(true, "localStorageV2Imported");
            }
            done(undefined);
          } catch (error) { fail(error); }
        };
      });
      return db;
    } catch (error) { db.close(); throw error; }
  })().catch((error: unknown) => { opening = undefined; throw error; });
  return opening;
}

function refreshCache(records: readonly UploadRecoveryRecord[]): void {
  const cached = listUploadRecovery(), current = new Map(records.map(record => [record.operationId, record]));
  for (const record of cached) if (!current.has(record.operationId)) removeUploadRecovery(record.operationId);
  for (const record of records) if (JSON.stringify(cached.find(item => item.operationId === record.operationId)) !== JSON.stringify(record)) saveUploadRecovery(record);
}
export async function listDurableUploadRecovery(): Promise<readonly UploadRecoveryRecord[]> {
  const records = await transaction<readonly UploadRecoveryRecord[]>(await database(), false, (tx, done, fail) => {
    const read = tx.objectStore(RECORDS).getAll();
    read.onsuccess = () => { try { done(checkedRows(read.result)); } catch (error) { fail(error); } };
  });
  refreshCache(records); return records;
}
export async function hydrateUploadRecovery(): Promise<void> { await listDurableUploadRecovery(); }
export async function saveDurableUploadRecovery(record: UploadRecoveryRecord): Promise<void> {
  await transaction<undefined>(await database(), true, (tx, done, fail) => {
    const store = tx.objectStore(RECORDS), read = store.getAll();
    read.onsuccess = () => {
      try { const current = checkedRows(read.result); validateUploadRecoveryTransition(current, record); store.put(record); done(undefined); }
      catch (error) { fail(error); }
    };
  });
  // This index exists for synchronous UI controls only. Network admission is
  // allowed only after the preceding strict transaction's oncomplete event.
  saveUploadRecovery(record);
}
export async function removeDurableUploadRecoveries(operationIds: readonly string[]): Promise<void> {
  if (operationIds.length > 128 || operationIds.some(id => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) throw new Error("Invalid upload recovery cleanup identity");
  if (operationIds.length === 0) return;
  await transaction<undefined>(await database(), true, (tx, done) => { for (const id of operationIds) tx.objectStore(RECORDS).delete(id); done(undefined); });
  for (const id of operationIds) removeUploadRecovery(id);
}
export async function removeDurableUploadRecovery(operationId: string): Promise<void> { await removeDurableUploadRecoveries([operationId]); }
