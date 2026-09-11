import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { normalizeStoragePath, resolveLocalPath, storageBasename } from "./paths.js";
import type {
  StorageAdapter,
  StorageCapacity,
  StorageFileInfo,
  StorageListResult,
  StorageReadOptions,
  StorageWriteOptions,
} from "./types.js";

export class LocalStorageAdapter implements StorageAdapter {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.#root, { recursive: true });
  }

  async #info(storagePath: string): Promise<StorageFileInfo> {
    const normalized = normalizeStoragePath(storagePath);
    const attributes = await fs.lstat(resolveLocalPath(this.#root, normalized));
    if (attributes.isSymbolicLink()) throw new Error("Symbolic links are forbidden in Saturn storage");
    if (!attributes.isFile() && !attributes.isDirectory()) throw new Error("Unsupported storage entry type");
    return {
      path: normalized,
      name: normalized ? storageBasename(normalized) : "",
      type: attributes.isDirectory() ? "directory" : "file",
      size: attributes.size,
      modifiedAt: attributes.mtime,
    };
  }

  stat(storagePath: string): Promise<StorageFileInfo> {
    return this.#info(storagePath);
  }

  async list(storagePath: string, cursor: string | undefined, limit: number): Promise<StorageListResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Storage list limit is invalid");
    const normalized = normalizeStoragePath(storagePath);
    const start = cursor === undefined ? 0 : Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(start) || start < 0) throw new Error("Storage cursor is invalid");
    const names = (await fs.readdir(resolveLocalPath(this.#root, normalized))).sort((left, right) => left.localeCompare(right));
    const selected = names.slice(start, start + limit);
    const entries = await Promise.all(selected.map((name) => this.#info(normalized ? `${normalized}/${name}` : name)));
    const next = start + selected.length;
    return {
      entries,
      ...(next < names.length ? { nextCursor: Buffer.from(String(next)).toString("base64url") } : {}),
    };
  }

  async openRead(storagePath: string, options: StorageReadOptions = {}): Promise<Readable> {
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Read offset is invalid");
    if (options.length !== undefined && (!Number.isSafeInteger(options.length) || options.length < 1)) {
      throw new Error("Read length is invalid");
    }
    const end = options.length === undefined ? undefined : offset + options.length - 1;
    const handle = await fs.open(resolveLocalPath(this.#root, storagePath), "r");
    return handle.createReadStream({
      start: offset,
      ...(end === undefined ? {} : { end }),
    });
  }

  async write(storagePath: string, source: Readable, options: StorageWriteOptions): Promise<number> {
    if (!Number.isSafeInteger(options.offset) || options.offset < 0) throw new Error("Write offset is invalid");
    const target = resolveLocalPath(this.#root, storagePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const flags = options.exclusive
      ? "wx"
      : options.create && options.truncate !== false && options.offset === 0
        ? "w"
      : "r+";
    const handle = await fs.open(target, flags, 0o600);
    let bytes = 0;
    let position = options.offset;
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        let written = 0;
        while (written < buffer.length) {
          const result = await handle.write(buffer, written, buffer.length - written, position + written);
          written += result.bytesWritten;
        }
        bytes += buffer.length;
        position += buffer.length;
      }
      await handle.sync();
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async mkdir(storagePath: string): Promise<void> {
    await fs.mkdir(resolveLocalPath(this.#root, normalizeStoragePath(storagePath, false)), { recursive: false, mode: 0o700 });
  }

  async truncate(storagePath: string, size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Truncate size is invalid");
    await fs.truncate(resolveLocalPath(this.#root, storagePath), size);
  }

  async rename(source: string, destination: string): Promise<void> {
    const target = resolveLocalPath(this.#root, destination);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(resolveLocalPath(this.#root, source), target);
  }

  async copy(source: string, destination: string): Promise<void> {
    const input = await this.openRead(source);
    await this.write(destination, input, { offset: 0, create: true, exclusive: true, truncate: true });
  }

  async delete(storagePath: string): Promise<void> {
    const info = await this.#info(storagePath);
    if (info.type === "directory") await fs.rmdir(resolveLocalPath(this.#root, storagePath));
    else await fs.unlink(resolveLocalPath(this.#root, storagePath));
  }

  async exists(storagePath: string): Promise<boolean> {
    try {
      await this.#info(storagePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async statFs(): Promise<StorageCapacity> {
    const info = await fs.statfs(this.#root);
    return { totalBytes: info.blocks * info.bsize, availableBytes: info.bavail * info.bsize };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
