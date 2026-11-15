import { requireDefined } from "../../contracts/src/require-defined.js";
import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { StorageVerifyError } from "../../contracts/src/storage-verifier.js";

function fileFailure(error: unknown): never {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ELOOP" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") throw new StorageVerifyError("scope_denied");
  if (code === "ENOENT" || code === "ESTALE") throw new StorageVerifyError("source_changed");
  throw error;
}

export function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}

// Every component is opened relative to a pinned descriptor. /proc/self/fd is
// kernel-owned on supported Linux hosts. O_NOFOLLOW applies to the child, never
// to the proc descriptor itself; ancestors cannot be swapped into symlinks.
export async function openNoFollow(path: string): Promise<FileHandle> {
  if (process.platform !== "linux" || !isAbsolute(path) || path.includes("\0")) throw new StorageVerifyError("unsupported");
  const parts = path.split("/").slice(1);
  if (parts.some(p => !p || p === "." || p === "..")) throw new StorageVerifyError("scope_denied");
  let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (let index = 0; index < parts.length; index++) {
      const child = await open(`/proc/self/fd/${String(parent.fd)}/${requireDefined(parts[index])}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (index < parts.length - 1 ? constants.O_DIRECTORY : 0));
      await parent.close();
      parent = child;
    }
    return parent;
  } catch (error) { await parent.close().catch(() => undefined); fileFailure(error); }
}

export async function openBeneath(root: FileHandle, relative: string): Promise<{ file: FileHandle; parents: FileHandle[] }> {
  const parts = relative.split("/");
  if (parts.length > 128 || parts.some(p => !p || p === "." || p === ".." || /[\\\p{Cc}]/u.test(p))) throw new StorageVerifyError("scope_denied");
  const parents: FileHandle[] = [];
  let parent = root;
  try {
    for (let index = 0; index < parts.length; index++) {
      const file = await open(`/proc/self/fd/${String(parent.fd)}/${requireDefined(parts[index])}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (index < parts.length - 1 ? constants.O_DIRECTORY : 0));
      if (index === parts.length - 1) return { file, parents };
      parents.push(file); parent = file;
    }
    throw new StorageVerifyError("scope_denied");
  } catch (error) { await Promise.allSettled(parents.map(f => f.close())); fileFailure(error); }
}

export async function readProtected(path: string, maximum = 65536): Promise<{ bytes: Buffer; digest: string }> {
  const file = await openNoFollow(path);
  try {
    const before = await file.stat({ bigint: true });
    const uid = process.geteuid?.();
    if (uid === undefined || !before.isFile() || before.nlink !== 1n || before.uid !== BigInt(uid) || (before.mode & 0o077n) !== 0n || before.size > BigInt(maximum)) throw new StorageVerifyError("scope_denied");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== Number(before.size) || !unchanged(before, await file.stat({ bigint: true }))) throw new StorageVerifyError("source_changed");
    const content = bytes.subarray(0, used);
    return { bytes: content, digest: createHash("sha256").update(content).digest("hex") };
  } finally { await file.close(); }
}
