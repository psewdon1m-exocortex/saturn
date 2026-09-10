import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, statfs } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

export interface DropBufferStoreOptions {
  readonly root: string;
  readonly maxBytes: number | (() => Promise<number>);
  readonly minFreeBytes: number;
  readonly warningRatio: number;
  readonly criticalRatio: number;
  readonly refusalRatio: number;
}

export interface DropBufferCapacity {
  readonly state: "available" | "warning" | "critical" | "refusing";
  readonly reservedBytes: number;
  readonly maxBytes: number;
  readonly freeBytes: number;
  readonly ratio: number;
}

export class DropBufferStore {
  readonly #options: DropBufferStoreOptions;

  constructor(options: DropBufferStoreOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#options.root, { recursive: true, mode: 0o700 });
  }

  async reservationLimitBytes(): Promise<number> {
    return Math.floor(await this.#maximumBytes() * this.#options.refusalRatio);
  }

  relativePath(uploadId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new Error("Drop buffer upload ID is invalid");
    return `${uploadId}.part`;
  }

  async capacity(reservedBytes: number, additionalBytes = 0): Promise<DropBufferCapacity> {
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || !Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error("Drop buffer reservation is invalid");
    const maxBytes = await this.#maximumBytes();
    const stats = await statfs(this.#options.root);
    const freeBytes = stats.bavail * stats.bsize;
    const projected = reservedBytes + additionalBytes;
    const ratio = projected / maxBytes;
    const state = ratio >= this.#options.refusalRatio || freeBytes - additionalBytes < this.#options.minFreeBytes
      ? "refusing"
      : ratio >= this.#options.criticalRatio
        ? "critical"
        : ratio >= this.#options.warningRatio
          ? "warning"
          : "available";
    return { state, reservedBytes, maxBytes, freeBytes, ratio };
  }

  async create(relativePath: string): Promise<void> {
    await this.initialize();
    const handle = await open(this.#absolute(relativePath), "wx", 0o600);
    await handle.close();
  }

  async append(relativePath: string, offset: number, contentLength: number, source: Readable): Promise<number> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(contentLength) || contentLength < 0) throw new Error("Drop buffer offset is invalid");
    const handle = await open(this.#absolute(relativePath), "r+");
    let written = 0;
    try {
      for await (const chunk of source) {
        const value = Buffer.from(chunk as Uint8Array);
        if (written + value.length > contentLength) throw new Error("Drop buffer body exceeds Content-Length");
        let cursor = 0;
        while (cursor < value.length) {
          const result = await handle.write(value, cursor, value.length - cursor, offset + written + cursor);
          if (result.bytesWritten < 1) throw new Error("Drop buffer write made no progress");
          cursor += result.bytesWritten;
        }
        written += value.length;
      }
      if (written !== contentLength) throw new Error("Drop buffer body does not match Content-Length");
      await handle.sync();
      return written;
    } finally {
      await handle.close();
    }
  }

  async digest(relativePath: string): Promise<{ readonly bytes: number; readonly sha256: string }> {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(this.#absolute(relativePath))) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      hash.update(value);
    }
    return { bytes, sha256: hash.digest("hex") };
  }

  openRead(relativePath: string): Readable {
    return createReadStream(this.#absolute(relativePath));
  }

  async delete(relativePath: string): Promise<void> {
    await rm(this.#absolute(relativePath), { force: true });
  }

  async #maximumBytes(): Promise<number> {
    const value = typeof this.#options.maxBytes === "number" ? this.#options.maxBytes : await this.#options.maxBytes();
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Drop buffer maximum is invalid");
    return value;
  }

  #absolute(relativePath: string): string {
    if (!/^[0-9a-f-]{36}\.part$/i.test(relativePath)) throw new Error("Drop buffer path is invalid");
    const absolute = path.resolve(this.#options.root, relativePath);
    const root = path.resolve(this.#options.root);
    if (path.dirname(absolute) !== root) throw new Error("Drop buffer path escapes its root");
    return absolute;
  }
}
