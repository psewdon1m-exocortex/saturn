import type { UploadRecoveryRecord } from "./upload-recovery-store.js";

// Transport/UI unit fixtures do not model browser disk persistence. Keep their
// metadata in the existing cache; strict commit ordering has a separate suite
// and disk recovery requires independent proof in an actual persistent browser.
export async function recoveryUnitBackend() {
  const store = await import("./upload-recovery-store.js");
  return {
    listDurableUploadRecovery: () => Promise.resolve().then(() => store.listUploadRecovery()),
    saveDurableUploadRecovery: (record: UploadRecoveryRecord) => Promise.resolve().then(() => store.saveUploadRecovery(record)),
    removeDurableUploadRecovery: (id: string) => Promise.resolve().then(() => store.removeUploadRecovery(id)),
    removeDurableUploadRecoveries: (ids: readonly string[]) => Promise.resolve().then(() => { for (const id of ids) store.removeUploadRecovery(id); }),
    hydrateUploadRecovery: () => Promise.resolve().then(() => { store.listUploadRecovery(); }),
  };
}
