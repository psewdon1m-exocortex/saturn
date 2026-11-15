import { requireDefined } from "../../contracts/src/require-defined.js";
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { verifyLocalStorage } from "./local-storage-verifier.js";
import type { StorageVerifyRequest } from "../../contracts/src/storage-verifier.js";
import type { Readable } from "node:stream";
import { normalizeStoragePath, resolveLocalPath,validateExactStoragePath } from "./paths.js";
import { bindStorageReadClosure, createStorageClosureProof } from "./storage-read-closure.js";
import type {
  StorageAdapter,
  StorageCapacity,
  StorageFileInfo,
  StorageListResult,
  StorageReadOptions,
  StorageReadStream,
  StorageWriteOptions,
} from "./types.js";

export class LocalStorageAdapter implements StorageAdapter {
  readonly #root: string;
  #exactPaths=false;
  enableExactPaths():void{this.#exactPaths=true;}
  #path(value:string,allowEmpty=true):string{return this.#exactPaths?validateExactStoragePath(value,allowEmpty):normalizeStoragePath(value,allowEmpty);}
  #resolve(value:string):string{return resolveLocalPath(this.#root,value,this.#exactPaths);}

  constructor(root: string, private readonly verificationOwnership?: (request: StorageVerifyRequest) => Promise<void>) {
    this.#root = path.resolve(root);
  }

  async verify(request: StorageVerifyRequest, signal?: AbortSignal) {
    if (!this.verificationOwnership) throw Object.assign(new Error("unsupported"), { code: "unsupported" });
    return verifyLocalStorage(this.#root, request, () => requireDefined(this.verificationOwnership)(request), signal);
  }

  supportsVerify(): Promise<boolean> { return Promise.resolve(this.verificationOwnership !== undefined); }

  async initialize(): Promise<void> {
    await fs.mkdir(this.#root, { recursive: true });
  }

  async #info(storagePath: string): Promise<StorageFileInfo> {
    const normalized = this.#path(storagePath);
    const attributes = await fs.lstat(this.#resolve(normalized));
    if (attributes.isSymbolicLink()) throw new Error("Symbolic links are forbidden in Saturn storage");
    if (!attributes.isFile() && !attributes.isDirectory()) throw new Error("Unsupported storage entry type");
    return {
      path: normalized,
      name: normalized.slice(normalized.lastIndexOf('/')+1),
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
    const normalized = this.#path(storagePath);
    const start = cursor === undefined ? 0 : Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(start) || start < 0) throw new Error("Storage cursor is invalid");
    const names = (await fs.readdir(this.#resolve(normalized))).sort((left, right) => left.localeCompare(right));
    const selected = names.slice(start, start + limit);
    const entries = await Promise.all(selected.map((name) => this.#info(normalized ? `${normalized}/${name}` : name)));
    const next = start + selected.length;
    return {
      entries,
      ...(next < names.length ? { nextCursor: Buffer.from(String(next)).toString("base64url") } : {}),
    };
  }

  async openRead(storagePath: string, options: StorageReadOptions = {}): Promise<StorageReadStream> {
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Read offset is invalid");
    if (options.length !== undefined && (!Number.isSafeInteger(options.length) || options.length < 1)) {
      throw new Error("Read length is invalid");
    }
    const end = options.length === undefined ? undefined : offset + options.length - 1;
    const handle = await fs.open(this.#resolve(storagePath), "r");
    const proof = createStorageClosureProof(), close = handle.close.bind(handle);
    let closing: Promise<void> | undefined;
    // Capture the FIRST physical close promise. Calling FileHandle.close again
    // after fd becomes -1 can resolve before the first close has completed.
    handle.close = () => {
      if (!closing) { closing = close(); void closing.then(proof.confirm, proof.reject); }
      return closing;
    };
    try {
      const stream = handle.createReadStream({
        start: offset,
        ...(options.signal?{signal:options.signal}:{}),
        ...(end === undefined ? {} : { end }),
      });
      // Logical cancellation/IO failure is separate from physical close success.
      // Keep errors observable even if they occur before the consumer attaches.
      stream.on("error", () => undefined);
      return bindStorageReadClosure(stream, proof.closed);
    } catch (error) { await handle.close(); throw error; }
  }

  async write(storagePath: string, source: Readable, options: StorageWriteOptions): Promise<number> {
    if (!Number.isSafeInteger(options.offset) || options.offset < 0) throw new Error("Write offset is invalid");
    const target = this.#resolve(storagePath);
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
      await this.#syncDirectory(path.dirname(target));
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async mkdir(storagePath: string): Promise<void> {
    await fs.mkdir(this.#resolve(this.#path(storagePath,false)), { recursive: false, mode: 0o700 });
    await this.#syncDirectory(path.dirname(this.#resolve(storagePath)));
  }

  async truncate(storagePath: string, size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Truncate size is invalid");
    const handle = await fs.open(this.#resolve(storagePath), "r+");
    try { await handle.truncate(size); await handle.sync(); }
    finally { await handle.close(); }
  }

  async rename(source: string, destination: string): Promise<void> {
    const target = this.#resolve(destination);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const origin = this.#resolve(source);
    await fs.rename(origin, target);
    await this.#syncDirectory(path.dirname(target));
    if (path.dirname(origin) !== path.dirname(target)) await this.#syncDirectory(path.dirname(origin));
  }

  async copy(source: string, destination: string): Promise<void> {
    const target = this.#resolve(destination);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // CoW is an optimization; copyFile falls back to an independent physical copy.
    // COPYFILE_EXCL prevents replacing a concurrently occupied destination.
    await fs.copyFile(this.#resolve(source), target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const handle = await fs.open(target, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await this.#syncDirectory(path.dirname(target));
  }

  async delete(storagePath: string): Promise<void> {
    const info = await this.#info(storagePath);
    if (info.type === "directory") await fs.rmdir(this.#resolve(storagePath));
    else await fs.unlink(this.#resolve(storagePath));
    await this.#syncDirectory(path.dirname(this.#resolve(storagePath)));
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

  async #syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
