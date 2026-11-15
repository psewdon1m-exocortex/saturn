import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import { LocalStorageAdapter } from "./local-storage.adapter.js";
import { normalizeStoragePath, validateExactStoragePath } from "./paths.js";
import type { StorageAdapter, StorageReadOptions, StorageWriteOptions } from "./types.js";

export interface LocalCustodyConfig {
  readonly backend: "local";
  readonly root: string;
  readonly custodyFile: string;
}

export interface LocalCustodyReceipt {
  readonly schema: "saturn.local-custody.v1";
  readonly backendIdentity: string;
  readonly generation: string;
  readonly root: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}

const SHA = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("local_storage_custody_invalid"); }
function absolute(value: string): string {
  if (!path.isAbsolute(value) || value !== path.resolve(value) || value === path.parse(value).root || Array.from(value).some(character => character.charCodeAt(0) < 32)) invalid();
  return value;
}
function receipt(value: unknown, root: string): LocalCustodyReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const r = value as Record<string, unknown>;
  const keys = ["schema", "backendIdentity", "generation", "root", "device", "inode", "birthtimeNs"];
  if (Object.keys(r).length !== keys.length || keys.some(key => !Object.hasOwn(r, key))
    || r.schema !== "saturn.local-custody.v1" || r.root !== root
    || typeof r.backendIdentity !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(r.backendIdentity)
    || typeof r.generation !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(r.generation)
    || ["device", "inode", "birthtimeNs"].some(key => typeof r[key] !== "string" || !/^\d{1,30}$/.test(r[key]))
    || r.inode === "0") invalid();
  return Object.freeze(r) as unknown as LocalCustodyReceipt;
}

async function noLinks(...directories: readonly string[]): Promise<void> {
  // Only deduplicate within this admission. Every subsequent call observes all
  // ancestors again; no path, permission or custody-generation cache is kept.
  const ancestors = new Set<string>();
  for (const directory of directories) {
    let current = path.parse(directory).root;
    for (const part of path.relative(current, directory).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      ancestors.add(current);
    }
  }
  const pending = [...ancestors]; let next = 0;
  const checks = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (next < pending.length) {
      const current = pending[next++];
      if (current === undefined) invalid();
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    }
  }));
  for (const checked of checks) if (checked.status === 'rejected') throw checked.reason;
  for (const directory of directories) if (await fs.realpath(directory) !== directory) invalid();
}

/** Operator enrollment helper: returns a proof for an existing dedicated root.
 * The caller must write it with exclusive creation outside the writable root;
 * startup never creates or renews custody for an unexpected replacement root. */
export async function inspectLocalCustody(root: string, backendIdentity: string, generation: string): Promise<LocalCustodyReceipt> {
  absolute(root); await noLinks(root);
  const stat = await fs.lstat(root, { bigint: true });
  return receipt({ schema: "saturn.local-custody.v1", backendIdentity, generation, root,
    device: stat.dev.toString(), inode: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() }, root);
}

export class LocalCustodyStorageAdapter implements StorageAdapter {
  readonly #config: LocalCustodyConfig;
  readonly #adapter: LocalStorageAdapter;
  #expectedSha256: string | undefined;
  #exactPaths = false;

  constructor(config: LocalCustodyConfig) {
    absolute(config.root); absolute(config.custodyFile);
    const relative = path.relative(config.root, config.custodyFile);
    if (!relative || !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) invalid();
    this.#config = Object.freeze({ ...config });
    this.#adapter = new LocalStorageAdapter(config.root);
  }

  enableExactPaths(): void { this.#exactPaths = true; this.#adapter.enableExactPaths(); }

  async custody(): Promise<{ readonly receipt: LocalCustodyReceipt; readonly sha256: string }> {
    await noLinks(this.#config.root, path.dirname(this.#config.custodyFile));
    const before = await fs.lstat(this.#config.custodyFile, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 4096n
      || process.platform !== "win32" && ((before.mode & 0o077n) !== 0n || before.uid !== BigInt(process.getuid?.() ?? -1))) invalid();
    const handle = await fs.open(this.#config.custodyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) invalid();
      const buffer = Buffer.alloc(4097);
      const read = await handle.read(buffer, 0, buffer.length, 0);
      if (read.bytesRead !== Number(before.size)) invalid();
      bytes = buffer.subarray(0, read.bytesRead);
      const after = await handle.stat({ bigint: true });
      const current = await fs.lstat(this.#config.custodyFile, { bigint: true });
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
        || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) invalid();
    } finally { await handle.close(); }
    const sha256 = SHA(bytes);
    if (this.#expectedSha256 !== undefined && sha256 !== this.#expectedSha256) invalid();
    const value = receipt(JSON.parse(bytes.toString("utf8")) as unknown, this.#config.root);
    const root = await fs.lstat(this.#config.root, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev.toString() !== value.device || root.ino.toString() !== value.inode || root.birthtimeNs.toString() !== value.birthtimeNs) invalid();
    if (process.platform !== "win32" && ((root.mode & 0o022n) !== 0n || root.uid !== BigInt(process.getuid?.() ?? -1))) invalid();
    this.#expectedSha256 ??= sha256;
    return { receipt: value, sha256 };
  }

  async #check(...paths: readonly string[]): Promise<void> {
    await this.custody();
    for (const storagePath of paths) {
      const normalized = this.#exactPaths ? validateExactStoragePath(storagePath) : normalizeStoragePath(storagePath);
      let current = this.#config.root;
      for (const segment of normalized.split("/").filter(Boolean)) {
        current = path.join(current, segment);
        const stat = await fs.lstat(current).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (stat === undefined) break;
        if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) invalid();
      }
    }
  }

  // No claim of the optional verifier capability. File-core retains its complete
  // independent, generation-checked physical readback when that proof is absent.
  async supportsVerify(): Promise<boolean> { await this.custody(); return false; }
  async stat(p: string) { await this.#check(p); return this.#adapter.stat(p); }
  async list(p: string, cursor: string | undefined, limit: number) { await this.#check(p); return this.#adapter.list(p, cursor, limit); }
  async openRead(p: string, options?: StorageReadOptions) { await this.#check(p); return this.#adapter.openRead(p, options); }
  async write(p: string, source: Readable, options: StorageWriteOptions) { await this.#check(p); return this.#adapter.write(p, source, options); }
  async truncate(p: string, size: number) { await this.#check(p); await this.#adapter.truncate(p, size); }
  async mkdir(p: string) { await this.#check(p); await this.#adapter.mkdir(p); }
  async rename(a: string, b: string) { await this.#check(a, b); await this.#adapter.rename(a, b); }
  async copy(a: string, b: string) { await this.#check(a, b); await this.#adapter.copy(a, b); }
  async delete(p: string) { await this.#check(p); await this.#adapter.delete(p); }
  async exists(p: string) { await this.#check(p); return this.#adapter.exists(p); }
  async statFs() { await this.custody(); return this.#adapter.statFs(); }
  async close() { await this.#adapter.close(); }
}
