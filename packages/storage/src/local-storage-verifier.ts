import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseStorageVerifyRequest, storageVerifyResult, StorageVerifyError, type StorageVerifyRequest, type StorageVerifyResult } from "../../contracts/src/storage-verifier.js";

/** Called only under a qualified managed-exclusive owner. Ancestors are checked
 * before/after; O_NOFOLLOW pins the final handle. No external writer capability
 * can be inferred from these filesystem checks. */
export async function verifyLocalStorage(root: string, value: StorageVerifyRequest,
  checkOwnership: () => Promise<void>, signal?: AbortSignal): Promise<StorageVerifyResult> {
  const request = parseStorageVerifyRequest(value), base = path.resolve(root);
  const target = path.resolve(base, ...request.relativePath.split("/")), relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new StorageVerifyError("scope_denied");
  const deadline = Date.now() + request.timeoutMs;
  const cancelled = () => { if (signal?.aborted || Date.now() >= deadline) throw new StorageVerifyError("cancelled"); };
  const directories: { path: string; dev: bigint; ino: bigint; ctimeNs: bigint }[] = [];
  let current = path.parse(base).root;
  for (const part of path.relative(current, path.dirname(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = await fs.lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageVerifyError("scope_denied");
    directories.push({ path: current, dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs });
  }
  await checkOwnership(); cancelled();
  const beforePath = await fs.lstat(target, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n) throw new StorageVerifyError("scope_denied");
  // FlushFileBuffers on Windows requires a handle opened for write access.
  // This verifier never writes bytes; readback-only verification stays readonly.
  const access = process.platform === "win32" && request.requireDurability === "file-sync" ? constants.O_RDWR : constants.O_RDONLY;
  const handle = await fs.open(target, access | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (before.dev !== beforePath.dev || before.ino !== beforePath.ino || before.size !== BigInt(request.sizeBytes)) throw new StorageVerifyError("source_changed");
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let length = 0n;
    for (;;) {
      cancelled(); const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      length += BigInt(read.bytesRead); if (length > BigInt(request.maximumBytes)) throw new StorageVerifyError("verification_failed");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat({ bigint: true }), afterPath = await fs.lstat(target, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || afterPath.isSymbolicLink() || afterPath.dev !== before.dev || afterPath.ino !== before.ino || after.nlink !== 1n) throw new StorageVerifyError("source_changed");
    for (const directory of directories) {
      const stat = await fs.lstat(directory.path, { bigint: true });
      if (stat.isSymbolicLink() || stat.dev !== directory.dev || stat.ino !== directory.ino) throw new StorageVerifyError("source_changed");
    }
    if (length.toString() !== request.sizeBytes || hash.digest("hex") !== request.sha256) throw new StorageVerifyError("verification_failed");
    if (request.requireDurability === "file-sync") await handle.sync();
    cancelled(); await checkOwnership();
    return storageVerifyResult(request, request.requireDurability);
  } finally { await handle.close(); }
}
