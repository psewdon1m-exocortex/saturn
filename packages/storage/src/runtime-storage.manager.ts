import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { StorageVerifyRequest } from "../../contracts/src/storage-verifier.js";
import { requireSftpStorage, type SaturnConfig } from "@saturn/config";
import { SftpStorageAdapter } from "./sftp-storage.adapter.js";
import { LocalCustodyStorageAdapter } from "./local-custody.js";
import type { StorageAdapter, StorageCapacity, StorageFileInfo, StorageListResult, StorageReadOptions, StorageWriteOptions } from "./types.js";

export interface ActiveStorageProfile {
  readonly profileId: string;
  readonly revision: number;
  readonly activatedAt: string;
  readonly source: "bootstrap" | "runtime";
  readonly config: SaturnConfig["storage"];
}

interface StoredStorageProfile {
  readonly version: 1;
  readonly profileId: string;
  readonly revision: number;
  readonly activatedAt: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly root: string;
  readonly hostFingerprint: string;
  readonly authMode: "password_file" | "private_key_file";
  readonly credentialFile: string;
  readonly operationTimeoutMs: number;
  readonly healthTimeoutMs: number;
  readonly maxConnections: number;
  readonly requireFsync?: boolean;
}

export type StorageAdapterFactory = (config: SaturnConfig["storage"]) => StorageAdapter;
export type StorageProfileGuard = (profile: ActiveStorageProfile) => Promise<void>;
const ORPHAN_CREDENTIAL_GRACE_MS = 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error("Runtime storage profile is invalid");
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error("Runtime storage profile is invalid");
  return value as number;
}

function withinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) < 32) return true;
  return false;
}

function parseStoredProfile(value: unknown, runtimeDirectory: string): StoredStorageProfile {
  if (!isRecord(value) || value.version !== 1) throw new Error("Runtime storage profile is invalid");
  const authMode = value.authMode;
  if (authMode !== "password_file" && authMode !== "private_key_file") throw new Error("Runtime storage profile is invalid");
  if (value.requireFsync !== undefined && typeof value.requireFsync !== "boolean") throw new Error("Runtime storage durability policy is invalid");
  const root = requiredString(value, "root");
  if (root.startsWith("/") || root.replaceAll("\\", "/").split("/").includes("..") || containsControlCharacter(root)) {
    throw new Error("Runtime storage profile root is invalid");
  }
  const fingerprint = requiredString(value, "hostFingerprint");
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fingerprint)) throw new Error("Runtime storage profile fingerprint is invalid");
  const credentialFile = path.resolve(requiredString(value, "credentialFile"));
  if (!withinDirectory(runtimeDirectory, credentialFile)) throw new Error("Runtime storage credential escaped its protected directory");
  return {
    version: 1,
    profileId: requiredString(value, "profileId"),
    revision: requiredInteger(value, "revision", 1, Number.MAX_SAFE_INTEGER),
    activatedAt: requiredString(value, "activatedAt"),
    host: requiredString(value, "host"),
    port: requiredInteger(value, "port", 1, 65_535),
    username: requiredString(value, "username"),
    root,
    hostFingerprint: fingerprint,
    authMode,
    credentialFile,
    operationTimeoutMs: requiredInteger(value, "operationTimeoutMs", 1_000, 120_000),
    healthTimeoutMs: requiredInteger(value, "healthTimeoutMs", 500, 5_000),
    maxConnections: requiredInteger(value, "maxConnections", 1, 8),
    ...(value.requireFsync === undefined ? {} : { requireFsync: value.requireFsync }),
  };
}

function storageConfig(profile: StoredStorageProfile, requireFsync = false): SaturnConfig["storage"] {
  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    root: profile.root,
    hostFingerprint: profile.hostFingerprint,
    authMode: profile.authMode,
    ...(profile.authMode === "password_file" ? { passwordFile: profile.credentialFile } : { privateKeyFile: profile.credentialFile }),
    operationTimeoutMs: profile.operationTimeoutMs,
    healthTimeoutMs: profile.healthTimeoutMs,
    maxConnections: profile.maxConnections,
    requireFsync: requireFsync || profile.requireFsync === true,
  };
}

/**
 * Stable process-local adapter used by long-lived services. The active profile
 * is stored in one protected shared volume so API and worker converge without
 * receiving credential contents through configuration or read APIs.
 */
export class RuntimeStorageManager implements StorageAdapter {
  readonly #runtimeDirectory: string;
  readonly #activePath: string;
  readonly #factory: StorageAdapterFactory;
  readonly #retired = new Set<StorageAdapter>();
  readonly #requireFsync: boolean;
  #active: ActiveStorageProfile;
  #adapter: StorageAdapter;
  #refreshing: Promise<void> | undefined;
  #profileGuard: StorageProfileGuard | undefined;
  #exactPaths=false;
  enableExactPaths():void{
    if(!this.#adapter.enableExactPaths)throw new Error('Exact storage paths unsupported');
    this.#adapter.enableExactPaths();this.#exactPaths=true;
  }

  constructor(bootstrap: SaturnConfig["storage"], runtimeDirectory: string, factory: StorageAdapterFactory = (config) => config.backend === "local" ? new LocalCustodyStorageAdapter(config) : new SftpStorageAdapter(config)) {
    this.#runtimeDirectory = path.resolve(runtimeDirectory);
    this.#activePath = path.join(this.#runtimeDirectory, "active.json");
    this.#factory = factory;
    this.#requireFsync = bootstrap.requireFsync === true;
    this.#active = { profileId: "bootstrap", revision: 1, activatedAt: new Date(0).toISOString(), source: "bootstrap", config: bootstrap };
    this.#adapter = factory(bootstrap);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.#runtimeDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.#runtimeDirectory, 0o700).catch(() => undefined);
    const previousPath = `${this.#activePath}.previous`;
    if (this.#active.config.backend === "local") {
      await this.localCustody();
      if (await fileExists(previousPath)) throw new Error("Local storage cannot restore an SFTP runtime profile");
      await this.refresh();
      return;
    }
    if (!(await fileExists(this.#activePath)) && await fileExists(previousPath)) {
      await fs.rename(previousPath, this.#activePath);
    }
    await this.refresh();
    await this.#removeOrphanedCredentials();
  }

  current(): ActiveStorageProfile {
    return this.#active;
  }

  runtimeDirectory(): string {
    return this.#runtimeDirectory;
  }

  async localCustody() {
    if (this.#active.config.backend !== "local" || !(this.#adapter instanceof LocalCustodyStorageAdapter)) throw new Error("Local custody is unavailable");
    return this.#adapter.custody();
  }

  /** Installed once by the qualified deployment factory before application I/O.
   * It cannot be replaced or disabled by a request/profile rollback. */
  async installProfileGuard(guard: StorageProfileGuard): Promise<void> {
    if (this.#profileGuard !== undefined) throw new Error("Storage profile guard is already installed");
    this.#profileGuard = guard;
    await guard(this.#active);
  }

  async refresh(): Promise<void> {
    if (this.#refreshing !== undefined) return this.#refreshing;
    this.#refreshing = (async () => {
      let raw: string;
      try { raw = await fs.readFile(this.#activePath, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (this.#active.config.backend === "local") throw new Error("Local storage cannot activate an SFTP runtime profile");
      const stored = parseStoredProfile(JSON.parse(raw) as unknown, this.#runtimeDirectory);
      await this.#profileGuard?.({ profileId: stored.profileId, revision: stored.revision, activatedAt: stored.activatedAt, source: "runtime", config: storageConfig(stored,this.#requireFsync) });
      if (stored.profileId === this.#active.profileId && stored.revision === this.#active.revision) return;
      const next = this.#factory(storageConfig(stored,this.#requireFsync));
      if(this.#exactPaths){if(!next.enableExactPaths)throw new Error('Exact storage paths unsupported');next.enableExactPaths();}
      this.#retired.add(this.#adapter);
      this.#adapter = next;
      this.#active = { profileId: stored.profileId, revision: stored.revision, activatedAt: stored.activatedAt, source: "runtime", config: storageConfig(stored,this.#requireFsync) };
    })().finally(() => { this.#refreshing = undefined; });
    return this.#refreshing;
  }

  async activate(profile: Omit<ActiveStorageProfile, "source">, adapter?: StorageAdapter): Promise<void> {
    if (this.#active.config.backend === "local" || profile.config.backend === "local") throw new Error("Local storage profile changes require operator requalification");
    await this.#profileGuard?.({ ...profile, source: "runtime" });
    if (this.#requireFsync && profile.config.requireFsync !== true) throw new Error("Runtime storage cannot downgrade the fsync requirement");
    const config = requireSftpStorage(profile.config);
    const credentialFile = config.authMode === "password_file" ? config.passwordFile : config.privateKeyFile;
    if (credentialFile === undefined || !withinDirectory(this.#runtimeDirectory, path.resolve(credentialFile))) {
      throw new Error("Runtime storage credential must be inside the protected storage directory");
    }
    const stored: StoredStorageProfile = {
      version: 1,
      profileId: profile.profileId,
      revision: profile.revision,
      activatedAt: profile.activatedAt,
      host: config.host,
      port: config.port,
      username: config.username,
      root: config.root,
      hostFingerprint: config.hostFingerprint,
      authMode: config.authMode,
      credentialFile: path.resolve(credentialFile),
      operationTimeoutMs: profile.config.operationTimeoutMs,
      healthTimeoutMs: profile.config.healthTimeoutMs,
      maxConnections: profile.config.maxConnections,
      ...(profile.config.requireFsync === undefined ? {} : { requireFsync: profile.config.requireFsync }),
    };
    await fs.mkdir(this.#runtimeDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.#runtimeDirectory, `.active-${profile.profileId}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(stored)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { await this.#replaceActiveFile(temporary); }
    catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    const next = adapter ?? this.#factory(profile.config);
    if(this.#exactPaths){if(!next.enableExactPaths)throw new Error('Exact storage paths unsupported');next.enableExactPaths();}
    this.#retired.add(this.#adapter);
    this.#adapter = next;
    this.#active = { ...profile, source: "runtime" };
  }

  async restore(profile: ActiveStorageProfile): Promise<void> {
    await this.#profileGuard?.(profile);
    if (this.#active.config.backend === "local" || profile.config.backend === "local") {
      if (profile.source !== this.#active.source || profile.profileId !== this.#active.profileId || profile.revision !== this.#active.revision
        || JSON.stringify(profile.config) !== JSON.stringify(this.#active.config)) throw new Error("Local storage recovery requires the same operator-pinned configuration");
      await this.localCustody();
      return;
    }
    if (profile.source === "runtime") {
      await this.activate({ profileId: profile.profileId, revision: profile.revision, activatedAt: profile.activatedAt, config: profile.config });
      return;
    }
    const source = profile.config.authMode === "password_file" ? profile.config.passwordFile : profile.config.privateKeyFile;
    if (source === undefined) throw new Error("Bootstrap storage credential is unavailable for rollback");
    const credentialFile = path.join(this.#runtimeDirectory, `credential-rollback-${randomUUID()}.${profile.config.authMode === "password_file" ? "password" : "key"}`);
    await fs.copyFile(source, credentialFile, fsConstants.COPYFILE_EXCL);
    await fs.chmod(credentialFile, 0o600).catch(() => undefined);
    const config: SaturnConfig["storage"] = {
      ...profile.config,
      ...(profile.config.authMode === "password_file" ? { passwordFile: credentialFile } : { privateKeyFile: credentialFile }),
    };
    await this.activate({
      profileId: `rollback-${randomUUID()}`,
      revision: Math.max(profile.revision, this.#active.revision) + 1,
      activatedAt: new Date().toISOString(),
      config,
    });
  }

  async #replaceActiveFile(temporary: string): Promise<void> {
    try {
      await fs.rename(temporary, this.#activePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
    }
    const previousPath = `${this.#activePath}.previous`;
    await fs.rm(previousPath, { force: true });
    await fs.rename(this.#activePath, previousPath);
    try {
      await fs.rename(temporary, this.#activePath);
      await fs.rm(previousPath, { force: true });
    } catch (error) {
      if (!(await fileExists(this.#activePath))) await fs.rename(previousPath, this.#activePath).catch(() => undefined);
      throw error;
    }
  }

  async #removeOrphanedCredentials(): Promise<void> {
    const activeCredential = this.#active.config.authMode === "password_file"
      ? this.#active.config.passwordFile
      : this.#active.config.privateKeyFile;
    const keep = activeCredential === undefined ? undefined : path.resolve(activeCredential);
    const names = await fs.readdir(this.#runtimeDirectory).catch(() => [] as string[]);
    await Promise.all(names
      .filter((name) => /^credential-[a-z0-9-]+\.(?:password|key)$/i.test(name))
      .map(async (name) => {
        const candidate = path.resolve(this.#runtimeDirectory, name);
        if (candidate === keep) return;
        const details = await fs.stat(candidate).catch(() => undefined);
        if (details !== undefined && Date.now() - details.mtimeMs >= ORPHAN_CREDENTIAL_GRACE_MS) await fs.rm(candidate, { force: true });
      }));
  }

  async #delegate(): Promise<StorageAdapter> {
    await this.refresh();
    return this.#adapter;
  }

  async stat(storagePath: string): Promise<StorageFileInfo> { return (await this.#delegate()).stat(storagePath); }
  async supportsVerify():Promise<boolean>{
    const adapter=await this.#delegate();
    return typeof adapter.verify==='function'&&(adapter.supportsVerify?await adapter.supportsVerify():true);
  }
  async verify(request:StorageVerifyRequest,signal?:AbortSignal){
    const adapter=await this.#delegate();
    if(!adapter.verify)throw Object.assign(new Error('unsupported'),{code:'unsupported'});
    return adapter.verify(request,signal);
  }
  async list(storagePath: string, cursor: string | undefined, limit: number): Promise<StorageListResult> { return (await this.#delegate()).list(storagePath, cursor, limit); }
  async openRead(storagePath: string, options?: StorageReadOptions): Promise<Readable> { return (await this.#delegate()).openRead(storagePath, options); }
  async write(storagePath: string, source: Readable, options: StorageWriteOptions): Promise<number> { return (await this.#delegate()).write(storagePath, source, options); }
  async truncate(storagePath: string, size: number): Promise<void> { await (await this.#delegate()).truncate(storagePath, size); }
  async mkdir(storagePath: string): Promise<void> { await (await this.#delegate()).mkdir(storagePath); }
  async rename(source: string, destination: string): Promise<void> { await (await this.#delegate()).rename(source, destination); }
  async copy(source: string, destination: string): Promise<void> { await (await this.#delegate()).copy(source, destination); }
  async delete(storagePath: string): Promise<void> { await (await this.#delegate()).delete(storagePath); }
  async exists(storagePath: string): Promise<boolean> { return (await this.#delegate()).exists(storagePath); }
  async statFs(): Promise<StorageCapacity> { return (await this.#delegate()).statFs(); }

  async close(): Promise<void> {
    const adapters = new Set([this.#adapter, ...this.#retired]);
    const results=await Promise.allSettled([...adapters].map(adapter=>adapter.close()));
    const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
    if(failures.length)throw new AggregateError(failures.map(result=>result.reason as unknown),"Storage shutdown unconfirmed");
    this.#retired.clear();
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; }
  catch { return false; }
}
