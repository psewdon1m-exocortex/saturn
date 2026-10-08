/** Create a shared parent without failing when another process creates it first. */
export async function ensureStorageDirectory(storage: {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ readonly size: number; readonly type?: "file" | "directory" }>;
}, path: string): Promise<void> {
  if (await storage.exists(path)) return;
  try { await storage.mkdir(path); }
  catch (error) {
    // SFTP commonly returns a generic Failure for EEXIST. Inspect the outcome
    // instead of suppressing permission, connection or non-directory errors.
    const created = await storage.stat(path).catch(() => undefined);
    if (created?.type !== "directory") throw error;
  }
}
