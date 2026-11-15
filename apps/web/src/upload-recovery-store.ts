/** Metadata schema and synchronous UI cache, never file bytes or secrets.
 * Network callers use upload-recovery-durable's strict IndexedDB commits.
 * No automatic expiry/deletion: an unknown server result remains recoverable. */
export type UploadRecoveryScope = { readonly channel: "owner"; readonly parentId: string; readonly overwriteResourceId?: string }
  | { readonly channel: "drop"; readonly channelId: string };
export type UploadRecoveryRecord = UploadRecoveryScope & {
  readonly schema: 2;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly id?: string;
  readonly filename: string;
  readonly expectedSize: number;
  readonly lastModified: number;
  readonly sha256: string;
  readonly createdAt: number;
};
const PREFIX = "saturn.upload-recovery.v2.";
const MAX_RECORDS = 128, MAX_RECORD_BYTES = 4096;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;
export function isUploadRecoveryRecord(value: unknown): value is UploadRecoveryRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.schema === 2 && typeof record.operationId === "string" && uuid.test(record.operationId)
    && record.idempotencyKey === `${record.channel === "owner" ? "web-upload" : "drop-web"}-${record.operationId}`
    && (record.id === undefined || text(record.id)) && text(record.filename)
    && typeof record.expectedSize === "number" && Number.isSafeInteger(record.expectedSize) && record.expectedSize >= 0
    && typeof record.lastModified === "number" && Number.isSafeInteger(record.lastModified) && record.lastModified >= 0
    && typeof record.createdAt === "number" && Number.isSafeInteger(record.createdAt) && record.createdAt >= 0
    && typeof record.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256)
    && (record.channel === "owner" && text(record.parentId) && (record.overwriteResourceId === undefined || text(record.overwriteResourceId))
      || record.channel === "drop" && text(record.channelId));
}

export function listUploadRecovery(): readonly UploadRecoveryRecord[] {
  const records: UploadRecoveryRecord[] = [];
  // Storage availability/corruption is a visible error, not an empty workset
  // that could cause the UI to mint replacement operations after reload.
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    if (raw.length > MAX_RECORD_BYTES) throw new Error("Upload recovery metadata is invalid; keep this browser's data for recovery.");
    const record: unknown = JSON.parse(raw);
    if (!isUploadRecoveryRecord(record) || key !== PREFIX + record.operationId) throw new Error("Upload recovery metadata is invalid; keep this browser's data for recovery.");
    records.push(record);
    if (records.length > MAX_RECORDS) throw new Error("Too many unresolved uploads; resolve existing operations before starting more.");
  }
  return records;
}

export function saveUploadRecovery(record: UploadRecoveryRecord): void {
  if (!isUploadRecoveryRecord(record)) throw new Error("Invalid upload recovery identity");
  const current = listUploadRecovery();
  validateUploadRecoveryTransition(current, record);
  const encoded = JSON.stringify(record);
  localStorage.setItem(PREFIX + record.operationId, encoded);
  if (localStorage.getItem(PREFIX + record.operationId) !== encoded) throw new Error("Cannot persist upload recovery metadata; upload has not been admitted.");
  window.dispatchEvent(new Event("saturn-upload-recovery"));
}

export function validateUploadRecoveryTransition(current: readonly UploadRecoveryRecord[], record: UploadRecoveryRecord): void {
  if (!isUploadRecoveryRecord(record)) throw new Error("Invalid upload recovery identity");
  const existing = current.find(item => item.operationId === record.operationId);
  if (existing !== undefined) {
    const { id: oldId, ...oldIntent } = existing, { id: newId, ...newIntent } = record;
    if (JSON.stringify(oldIntent) !== JSON.stringify(newIntent) || oldId !== undefined && oldId !== newId) throw new Error("Upload recovery identity cannot change");
  } else if (current.length >= MAX_RECORDS) throw new Error("Too many unresolved uploads; resolve existing operations before starting more.");
  const encoded = JSON.stringify(record);
  if (new TextEncoder().encode(encoded).byteLength > MAX_RECORD_BYTES) throw new Error("Upload recovery metadata exceeds its limit");
}

export function removeUploadRecovery(operationId: string): void {
  if (!uuid.test(operationId)) throw new Error("Invalid upload operation identity");
  localStorage.removeItem(PREFIX + operationId);
  window.dispatchEvent(new Event("saturn-upload-recovery"));
}

export function uploadSourceLock(scope: UploadRecoveryScope, filename: string): string {
  return JSON.stringify(["saturn-upload-source-v2", scope.channel, scope.channel === "owner" ? scope.parentId : scope.channelId,
    scope.channel === "owner" ? scope.overwriteResourceId ?? null : null, filename]);
}
const liveLocks = new Set<string>();
export async function withUploadSourceLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const run = async () => {
    if (liveLocks.has(key)) throw new Error("This upload is already active in this browser.");
    liveLocks.add(key);
    try { return await action(); } finally { liveLocks.delete(key); }
  };
  const locks = (navigator as { readonly locks?: LockManager }).locks;
  if (locks !== undefined) return locks.request(key, { ifAvailable: true }, async lock => {
    if (lock === null) throw new Error("This upload is already active in another tab.");
    return run();
  });
  return run();
}
