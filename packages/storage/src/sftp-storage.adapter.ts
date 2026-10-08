import path from "node:path";
import { once } from "node:events";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Stats } from "ssh2";
import type { SaturnConfig } from "@saturn/config";
import { joinStoragePath, normalizeStoragePath, storageBasename } from "./paths.js";
import { callSftp, SftpConnectionPool } from "./sftp-pool.js";
import type {
  StorageAdapter,
  StorageCapacity,
  StorageFileInfo,
  StorageListResult,
  StorageReadOptions,
  StorageWriteOptions,
} from "./types.js";

interface SftpStatFsResult {
  readonly f_bsize: number;
  readonly f_frsize: number;
  readonly f_blocks: number;
  readonly f_bavail: number;
}

function info(storagePath: string, attributes: Stats): StorageFileInfo {
  if (attributes.isSymbolicLink()) throw new Error("Symbolic links are forbidden in Saturn storage");
  if (!attributes.isFile() && !attributes.isDirectory()) throw new Error("Unsupported SFTP entry type");
  return {
    path: storagePath,
    name: storagePath ? storageBasename(storagePath) : "",
    type: attributes.isDirectory() ? "directory" : "file",
    size: attributes.size,
    modifiedAt: new Date(attributes.mtime * 1_000),
  };
}

export class SftpStorageAdapter implements StorageAdapter {
  readonly #storage: SaturnConfig["storage"];
  readonly #pool: SftpConnectionPool;

  constructor(storage: SaturnConfig["storage"]) {
    this.#storage = storage;
    this.#pool = new SftpConnectionPool(storage);
  }

  #remote(storagePath: string): string {
    return path.posix.join(this.#storage.root, normalizeStoragePath(storagePath));
  }

  async #operation<T>(action: (lease: Awaited<ReturnType<SftpConnectionPool["acquire"]>>) => Promise<T>): Promise<T> {
    const lease = await this.#pool.acquire();
    try {
      const result = await action(lease);
      await lease.release();
      return result;
    } catch (error) {
      await lease.release(true);
      throw error;
    }
  }

  async stat(storagePath: string): Promise<StorageFileInfo> {
    const normalized = normalizeStoragePath(storagePath);
    return this.#operation(async (lease) => info(
      normalized,
      await callSftp<Stats>(lease.sftp, "lstat", this.#storage.operationTimeoutMs, this.#remote(normalized)),
    ));
  }

  async list(storagePath: string, cursor: string | undefined, limit: number): Promise<StorageListResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Storage list limit is invalid");
    const normalized = normalizeStoragePath(storagePath);
    const start = cursor === undefined ? 0 : Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(start) || start < 0) throw new Error("Storage cursor is invalid");
    const deadline = Date.now() + this.#storage.operationTimeoutMs;
    return this.#operation(async (lease) => {
      const handle = await callSftp<Buffer>(lease.sftp, "opendir", this.#storage.operationTimeoutMs, this.#remote(normalized));
      const selected: Array<{ filename: string; attrs: Stats }> = [];
      let visited = 0;
      let more = false;
      try {
        outer: for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("SFTP directory listing deadline exceeded");
          let batch: Array<{ filename: string; attrs: Stats }>;
          try { batch = await callSftp(lease.sftp, "readdir", remaining, handle); }
          catch (error) { if ((error as { code?: number }).code === 1) break; throw error; }
          for (const entry of batch) {
            if (entry.filename === "." || entry.filename === "..") continue;
            if (visited++ < start) continue;
            if (selected.length === limit) { more = true; break outer; }
            selected.push(entry);
          }
        }
      } finally { await callSftp(lease.sftp, "close", this.#storage.operationTimeoutMs, handle); }
      const next = start + selected.length;
      return {
        entries: selected.map((entry) => {
          const childPath = joinStoragePath(normalized, entry.filename);
          return info(childPath, entry.attrs);
        }),
        ...(more ? { nextCursor: Buffer.from(String(next)).toString("base64url") } : {}),
      };
    });
  }

  async openRead(storagePath: string, options: StorageReadOptions = {}): Promise<Readable> {
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Read offset is invalid");
    if (options.length !== undefined && (!Number.isSafeInteger(options.length) || options.length < 1)) {
      throw new Error("Read length is invalid");
    }
    const lease = await this.#pool.acquire();
    const end = options.length === undefined ? undefined : offset + options.length - 1;
    const stream = lease.sftp.createReadStream(this.#remote(storagePath), {
      start: offset,
      highWaterMark: 256 * 1024,
      ...(end === undefined ? {} : { end }),
    });
    let released = false;
    const release = (broken: boolean): void => {
      if (released) return;
      released = true;
      void lease.release(broken);
    };
    stream.once("end", () => release(false));
    stream.once("close", () => release(false));
    stream.once("error", () => release(true));
    // Pin the remote file handle before the caller releases its metadata lock.
    const openDeadline = AbortSignal.timeout(this.#storage.operationTimeoutMs);
    try { await once(stream, "open", { signal: lease.disconnected === undefined ? openDeadline : AbortSignal.any([openDeadline, lease.disconnected]) }); }
    catch (error) { stream.destroy(); release(true); throw error; }
    // Opening a handle does not prove later reads can make progress. Bound an
    // SFTP server that continues answering SSH keepalives but stalls file reads.
    // A Transform preserves bytes before the consumer attaches; a data listener
    // on the raw stream here would enter flowing mode and could lose that data.
    let timer: NodeJS.Timeout | undefined;
    const clear = (): void => { if (timer !== undefined) clearTimeout(timer); };
    const fail = (error: Error): void => {
      // ssh2's remote stream may wait forever for its CLOSE callback after
      // disconnect. Fail the caller independently and retire the connection.
      clear();
      release(true);
      bounded.destroy(error);
      stream.destroy(error);
    };
    const reset = (): void => {
      clear();
      timer = setTimeout(() => fail(new Error("SFTP read idle timeout")), this.#storage.operationTimeoutMs);
    };
    const bounded = new Transform({
      highWaterMark: 256 * 1024,
      transform(chunk: Buffer, _encoding, callback) { reset(); callback(null, chunk); },
    });
    // A caller may not yet have attached its error handler when remote I/O fails.
    // The error remains observable to pipeline/async iteration and is not success.
    bounded.on("error", () => undefined);
    const disconnected = () => fail(new Error("SFTP transport disconnected"));
    const detach = () => lease.disconnected?.removeEventListener("abort", disconnected);
    lease.disconnected?.addEventListener("abort", disconnected, { once: true });
    if (lease.disconnected?.aborted) disconnected();
    stream.once("end", detach);
    stream.once("close", detach);
    bounded.once("close", () => { clear(); detach(); if (!stream.readableEnded) release(true); });
    stream.once("end", clear);
    stream.once("close", clear);
    reset();
    void pipeline(stream, bounded).catch(() => undefined).finally(clear);
    return bounded;
  }

  async write(storagePath: string, source: Readable, options: StorageWriteOptions): Promise<number> {
    if (!Number.isSafeInteger(options.offset) || options.offset < 0) throw new Error("Write offset is invalid");
    const lease = await this.#pool.acquire();
    const flags = options.exclusive
      ? "wx"
      : options.create && options.truncate !== false && options.offset === 0
        ? "w"
        : "r+";
    const target = lease.sftp.createWriteStream(this.#remote(storagePath), {
      flags,
      start: options.offset,
      mode: 0o600,
    });
    let bytes = 0;
    let timer: NodeJS.Timeout | undefined;
    let rejectIdle: (error: Error) => void = () => undefined;
    const idleFailure = new Promise<never>((_resolve, reject) => { rejectIdle = reject; });
    const fail = (error: Error) => { rejectIdle(error); source.destroy(error); target.destroy(); };
    const disconnected = () => fail(new Error("SFTP transport disconnected"));
    lease.disconnected?.addEventListener("abort", disconnected, { once: true });
    const reset = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        const error = new Error("SFTP write idle timeout");
        fail(error);
      }, this.#storage.operationTimeoutMs);
    };
    source.on("data", (chunk: Buffer | string) => { bytes += Buffer.byteLength(chunk); reset(); });
    target.on("drain", reset);
    reset();
    if (lease.disconnected?.aborted) disconnected();
    try {
      await Promise.race([pipeline(source, target), idleFailure]);
      if (timer !== undefined) clearTimeout(timer);
      await this.#syncRemoteFile(lease, storagePath);
      if (timer !== undefined) clearTimeout(timer);
      await lease.release();
      return bytes;
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      await lease.release(true);
      throw error;
    } finally {
      lease.disconnected?.removeEventListener("abort", disconnected);
    }
  }

  async truncate(storagePath: string, size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Truncate size is invalid");
    await this.#operation(async (lease) => {
      const handle = await callSftp<Buffer>(
        lease.sftp,
        "open",
        this.#storage.operationTimeoutMs,
        this.#remote(storagePath),
        "r+",
      );
      try {
        await callSftp(lease.sftp, "fsetstat", this.#storage.operationTimeoutMs, handle, { size });
        await this.#syncHandle(lease, handle);
      } finally {
        await callSftp(lease.sftp, "close", this.#storage.operationTimeoutMs, handle);
      }
    });
  }

  async mkdir(storagePath: string): Promise<void> {
    await this.#operation(async (lease) => {
      await callSftp(lease.sftp, "mkdir", this.#storage.operationTimeoutMs, this.#remote(normalizeStoragePath(storagePath, false)), { mode: 0o700 });
    });
  }

  async rename(source: string, destination: string): Promise<void> {
    await this.#operation(async (lease) => {
      await callSftp(lease.sftp, "rename", this.#storage.operationTimeoutMs, this.#remote(source), this.#remote(destination));
    });
  }

  async copy(source: string, destination: string): Promise<void> {
    await this.#operation(async (lease) => {
      const reader = lease.sftp.createReadStream(this.#remote(source), { highWaterMark: 256 * 1024 });
      const writer = lease.sftp.createWriteStream(this.#remote(destination), { flags: "wx", mode: 0o600 });
      let timer: NodeJS.Timeout | undefined;
      let rejectIdle: (error: Error) => void = () => undefined;
      const idleFailure = new Promise<never>((_resolve, reject) => { rejectIdle = reject; });
      const fail = (error: Error) => { rejectIdle(error); reader.destroy(error); writer.destroy(); };
      const disconnected = () => fail(new Error("SFTP transport disconnected"));
      lease.disconnected?.addEventListener("abort", disconnected, { once: true });
      const reset = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          const error = new Error("SFTP copy idle timeout");
          fail(error);
        }, this.#storage.operationTimeoutMs);
      };
      reader.on("data", reset);
      writer.on("drain", reset);
      reset();
      if (lease.disconnected?.aborted) disconnected();
      try {
        await Promise.race([pipeline(reader, writer), idleFailure]);
        if (timer !== undefined) clearTimeout(timer);
        await this.#syncRemoteFile(lease, destination);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        lease.disconnected?.removeEventListener("abort", disconnected);
      }
    });
  }

  async #syncHandle(lease: Awaited<ReturnType<SftpConnectionPool["acquire"]>>, handle: Buffer): Promise<void> {
    try { await callSftp(lease.sftp, "ext_openssh_fsync", this.#storage.operationTimeoutMs, handle); }
    catch (error) {
      if (error instanceof Error && error.message === "Server does not support this extended request" && !this.#storage.requireFsync) return;
      throw error;
    }
  }

  async #syncRemoteFile(lease: Awaited<ReturnType<SftpConnectionPool["acquire"]>>, storagePath: string): Promise<void> {
    const handle = await callSftp<Buffer>(lease.sftp, "open", this.#storage.operationTimeoutMs, this.#remote(storagePath), "r+");
    try { await this.#syncHandle(lease, handle); }
    finally { await callSftp(lease.sftp, "close", this.#storage.operationTimeoutMs, handle); }
  }

  async delete(storagePath: string): Promise<void> {
    const existing = await this.stat(storagePath);
    await this.#operation(async (lease) => {
      await callSftp(
        lease.sftp,
        existing.type === "directory" ? "rmdir" : "unlink",
        this.#storage.operationTimeoutMs,
        this.#remote(storagePath),
      );
    });
  }

  async exists(storagePath: string): Promise<boolean> {
    try { await this.stat(storagePath); return true; }
    catch (error) {
      if ((error as { code?: number }).code === 2) return false;
      throw error;
    }
  }

  async statFs(): Promise<StorageCapacity> {
    return this.#operation(async (lease) => {
      const result = await callSftp<SftpStatFsResult>(
        lease.sftp,
        "ext_openssh_statvfs",
        this.#storage.operationTimeoutMs,
        this.#remote(""),
      );
      const fragmentBytes = result.f_frsize || result.f_bsize;
      return {
        totalBytes: fragmentBytes * result.f_blocks,
        availableBytes: fragmentBytes * result.f_bavail,
      };
    });
  }

  close(): Promise<void> {
    return this.#pool.close();
  }
}
