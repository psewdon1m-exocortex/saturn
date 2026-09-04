import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Injectable } from "@nestjs/common";
import type { AuditService } from "@saturn/audit";
import type { SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";
import {
  BACKUPS_RESOURCE_ID,
  DROP_POINT_RESOURCE_ID,
  LABORATORY_RESOURCE_ID,
  MASTERMIND_RESOURCE_ID,
  ROOT_RESOURCE_ID,
  SYNC_RESOURCE_ID,
  VOLT_RESOURCE_ID,
} from "@saturn/file-core";
import {
  RuntimeStorageManager,
  SATURN_BUSINESS_ROOT_DIRECTORIES,
  SATURN_SYSTEM_DIRECTORIES,
  SftpStorageAdapter,
  normalizeStorageName,
  type StorageAdapter,
  type StorageCapacity,
  type StorageFileInfo,
} from "@saturn/storage";

const PROFILE_MANIFEST = "_system/storage-profile.json";
const MAX_INDEX_ENTRIES = 100_000;
const MAX_INDEX_DEPTH = 128;

const ROLE_IDS = {
  "drop point": DROP_POINT_RESOURCE_ID,
  laboratory: LABORATORY_RESOURCE_ID,
  backups: BACKUPS_RESOURCE_ID,
  mastermind: MASTERMIND_RESOURCE_ID,
  volt: VOLT_RESOURCE_ID,
  sync: SYNC_RESOURCE_ID,
} as const;

type RoleName = keyof typeof ROLE_IDS;

export interface StorageConnectionInput {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly root: string;
  readonly hostFingerprint: string;
  readonly authMode: "password_file" | "private_key_file";
  readonly credential: string;
}

export interface StorageConnectionStatus {
  readonly profileId: string;
  readonly revision: number;
  readonly activatedAt: string;
  readonly source: "bootstrap" | "runtime";
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly root: string;
  readonly hostFingerprint: string;
  readonly authMode: "password_file" | "private_key_file";
  readonly credentialConfigured: true;
  readonly reachability: "ready" | "unavailable";
  readonly capacity?: StorageCapacity;
}

interface IndexedEntry {
  readonly id: string;
  readonly parentId: string;
  readonly type: "file" | "folder";
  readonly name: string;
  readonly storagePath: string;
  readonly modifiedAt: Date;
  readonly mimeType?: string;
  readonly sha256?: string;
  sizeBytes: number;
  readonly securityClassification: "internal" | "confidential";
  readonly retentionClass: "general" | "mastermind_markdown" | "mastermind_attachment" | "keepass";
}

interface StorageInventory {
  readonly roleNames: Readonly<Record<RoleName, string>>;
  readonly entries: readonly IndexedEntry[];
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly indexedBytes: number;
}

function normalizeRoot(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "") || ".";
  if (normalized.startsWith("/") || normalized.split("/").includes("..") || containsControlCharacter(normalized)) throw new Error("invalid_storage_root");
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) < 32) return true;
  return false;
}

function publicStatus(profile: ReturnType<RuntimeStorageManager["current"]>, reachability: "ready" | "unavailable", capacity?: StorageCapacity): StorageConnectionStatus {
  return {
    profileId: profile.profileId,
    revision: profile.revision,
    activatedAt: profile.activatedAt,
    source: profile.source,
    host: profile.config.host,
    port: profile.config.port,
    username: profile.config.username,
    root: profile.config.root,
    hostFingerprint: profile.config.hostFingerprint,
    authMode: profile.config.authMode,
    credentialConfigured: true,
    reachability,
    ...(capacity === undefined ? {} : { capacity }),
  };
}

async function listAll(storage: StorageAdapter, storagePath: string): Promise<readonly StorageFileInfo[]> {
  const entries: StorageFileInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.list(storagePath, cursor, 1_000);
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return entries;
}

async function readBounded(storage: StorageAdapter, storagePath: string, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of await storage.openRead(storagePath)) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new Error("storage_manifest_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function hashFile(storage: StorageAdapter, storagePath: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of await storage.openRead(storagePath)) {
    const buffer = Buffer.from(chunk as Uint8Array);
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function mimeType(name: string): string {
  const extension = path.extname(name).toLowerCase();
  return ({
    ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".pdf": "application/pdf",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
    ".zip": "application/zip", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".kdbx": "application/x-keepass2",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function policy(storagePath: string, roleNames: Readonly<Record<RoleName, string>>, type: "file" | "folder", name: string): Pick<IndexedEntry, "securityClassification" | "retentionClass"> {
  const inside = (role: RoleName): boolean => storagePath === roleNames[role] || storagePath.startsWith(`${roleNames[role]}/`);
  if (inside("volt")) return { securityClassification: "confidential", retentionClass: type === "file" && name.toLowerCase().endsWith(".kdbx") ? "keepass" : "general" };
  if (inside("mastermind") && type === "file") return { securityClassification: "internal", retentionClass: name.toLowerCase().endsWith(".md") ? "mastermind_markdown" : "mastermind_attachment" };
  return { securityClassification: "internal", retentionClass: "general" };
}

function defaultRoleNames(): Record<RoleName, string> {
  return Object.fromEntries(SATURN_BUSINESS_ROOT_DIRECTORIES.map((name) => [name, name])) as Record<RoleName, string>;
}

function parseRoleNames(value: unknown): Record<RoleName, string> | undefined {
  if (typeof value !== "object" || value === null || !("roleNames" in value)) return undefined;
  const source = (value as { roleNames?: unknown }).roleNames;
  if (typeof source !== "object" || source === null) return undefined;
  const result = {} as Record<RoleName, string>;
  const unique = new Set<string>();
  for (const role of SATURN_BUSINESS_ROOT_DIRECTORIES) {
    const candidate = (source as Record<string, unknown>)[role];
    if (typeof candidate !== "string") return undefined;
    const name = normalizeStorageName(candidate);
    if (name.includes("/") || name === "_system" || unique.has(name.toLocaleLowerCase())) return undefined;
    unique.add(name.toLocaleLowerCase());
    result[role] = name;
  }
  return result;
}

async function readRoleNames(storage: StorageAdapter): Promise<Record<RoleName, string>> {
  if (!(await storage.exists(PROFILE_MANIFEST))) return defaultRoleNames();
  try {
    return parseRoleNames(JSON.parse((await readBounded(storage, PROFILE_MANIFEST, 64 * 1024)).toString("utf8")) as unknown) ?? defaultRoleNames();
  } catch {
    throw new Error("invalid_storage_profile_manifest");
  }
}

async function writeRoleNames(storage: StorageAdapter, roleNames: Readonly<Record<RoleName, string>>, profileId: string): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify({ version: 1, profileId, roleNames })}\n`, "utf8");
  await storage.write(PROFILE_MANIFEST, Readable.from([payload]), { offset: 0, create: true, truncate: true });
}

@Injectable()
export class StorageConnectionService {
  readonly #database: Database;
  readonly #storage: RuntimeStorageManager;
  readonly #config: SaturnConfig;
  readonly #audit: AuditService;

  constructor(database: Database, storage: RuntimeStorageManager, config: SaturnConfig, audit: AuditService) {
    this.#database = database;
    this.#storage = storage;
    this.#config = config;
    this.#audit = audit;
  }

  async status(): Promise<StorageConnectionStatus> {
    const profile = this.#storage.current();
    try {
      const root = await this.#storage.stat("");
      if (root.type !== "directory") throw new Error("storage_root_not_directory");
      const capacity = await this.#storage.statFs().catch(() => undefined);
      return publicStatus(profile, "ready", capacity);
    } catch {
      return publicStatus(profile, "unavailable");
    }
  }

  async test(input: StorageConnectionInput): Promise<Omit<StorageConnectionStatus, "profileId" | "revision" | "activatedAt" | "source">> {
    const profileId = randomUUID();
    const { adapter, config, credentialPath } = await this.#candidate(input, profileId);
    try {
      const root = await adapter.stat("");
      if (root.type !== "directory") throw new Error("storage_root_not_directory");
      const capacity = await adapter.statFs().catch(() => undefined);
      return {
        host: config.host, port: config.port, username: config.username, root: config.root,
        hostFingerprint: config.hostFingerprint, authMode: config.authMode, credentialConfigured: true,
        reachability: "ready", ...(capacity === undefined ? {} : { capacity }),
      };
    } finally {
      await adapter.close().catch(() => undefined);
      await fs.rm(credentialPath, { force: true });
    }
  }

  async switch(input: StorageConnectionInput): Promise<StorageConnectionStatus & { readonly indexed: { readonly files: number; readonly directories: number; readonly bytes: number }; readonly revoked: { readonly shares: number; readonly devices: number } }> {
    const profileId = randomUUID();
    const switchId = randomUUID();
    const previous = this.#storage.current();
    const { adapter, config, credentialPath } = await this.#candidate(input, profileId);
    let releaseCandidate = async (): Promise<void> => {
      await adapter.close().catch(() => undefined);
      await fs.rm(credentialPath, { force: true });
    };
    try {
      const root = await adapter.stat("");
      if (root.type !== "directory") throw new Error("storage_root_not_directory");
      const rootEntries = await listAll(adapter, "");
      const directFiles = rootEntries.filter((entry) => entry.type === "file");
      if (directFiles.length > 0) throw new Error("files_are_not_allowed_in_storage_root");
      for (const directory of SATURN_SYSTEM_DIRECTORIES) if (!(await adapter.exists(directory))) await adapter.mkdir(directory);
      const roleNames = await readRoleNames(adapter);
      for (const role of SATURN_BUSINESS_ROOT_DIRECTORIES) {
        const name = roleNames[role];
        if (!(await adapter.exists(name))) await adapter.mkdir(name);
        if ((await adapter.stat(name)).type !== "directory") throw new Error("protected_storage_root_is_not_directory");
      }
      await this.#smoke(adapter, switchId);
      const inventory = await this.#inventory(adapter, roleNames);
      await writeRoleNames(adapter, roleNames, profileId);
      let revokedShares = 0;
      let revokedDevices = 0;
      let bufferedDropPaths: string[] = [];
      const activatedAt = new Date().toISOString();
      const revision = previous.revision + 1;
      try {
        await this.#database.withExclusiveTransaction(async (sql) => {
          const shareRows = await sql<Array<{ count: string }>>`UPDATE shares SET state='revoked', revoked_at=now(), updated_at=now() WHERE state='active' RETURNING id`;
          const deviceRows = await sql<Array<{ count: string }>>`UPDATE devices SET state='revoked', revoked_at=now(), updated_at=now() WHERE state='active' RETURNING id`;
          revokedShares = shareRows.length;
          revokedDevices = deviceRows.length;
          await sql`UPDATE share_sessions SET state='revoked' WHERE state='active'`;
          await sql`DELETE FROM share_packages`;
          await sql`UPDATE laboratory_assets SET state='disabled', pinned_version_id=NULL, disabled_at=coalesce(disabled_at, now()), updated_at=now() WHERE state='active'`;
          await sql`UPDATE sync_conflicts SET state='resolved', resolved_at=coalesce(resolved_at, now()) WHERE state='open'`;
          await sql`DELETE FROM service_backup_restore_tests`;
          await sql`DELETE FROM service_backup_runs`;
          await sql`DELETE FROM operation_journal`;
          const bufferRows = await sql<Array<{ local_path: string | null }>>`SELECT local_path FROM drop_uploads WHERE local_path IS NOT NULL`;
          bufferedDropPaths = bufferRows.flatMap((row) => row.local_path === null ? [] : [row.local_path]);
          await sql`DELETE FROM drop_uploads`;
          await sql`DELETE FROM upload_sessions`;
          await sql`DELETE FROM operation_locks`;
          await sql`DELETE FROM drop_sessions`;
          await sql`DELETE FROM drop_challenges`;
          await sql`DELETE FROM drop_channels`;
          await sql`UPDATE resources SET current_version_id=NULL WHERE current_version_id IS NOT NULL`;
          await sql`UPDATE file_versions SET storage_path=${`_detached/${switchId}/versions`} || '/' || id::text, state='missing', archived_at=coalesce(archived_at, now())`;
          await sql`
            UPDATE resources SET storage_path=${`_detached/${switchId}/resources`} || '/' || id::text,
              status='purged', parent_id=NULL, trashed_from_parent_id=NULL, trashed_from_name=NULL,
              purge_after=NULL, size_bytes=0, sha256=NULL, updated_at=now()
            WHERE NOT (id = ANY(${[ROOT_RESOURCE_ID, ...Object.values(ROLE_IDS)]}::uuid[]))
          `;
          await sql`UPDATE resources SET name='root', storage_path='', parent_id=NULL, status='active', size_bytes=${inventory.indexedBytes}, sha256=NULL, updated_at=now() WHERE id=${ROOT_RESOURCE_ID}`;
          for (const [role, id] of Object.entries(ROLE_IDS) as Array<[RoleName, string]>) {
            const roleEntry = inventory.entries.find((entry) => entry.id === id);
            await sql`
              UPDATE resources SET name=${roleNames[role]}, storage_path=${roleNames[role]}, parent_id=${ROOT_RESOURCE_ID},
                status='active', size_bytes=${roleEntry?.sizeBytes ?? 0}, sha256=NULL,
                security_classification=${role === "volt" ? "confidential" : "internal"},
                retention_class='general', updated_at=now()
              WHERE id=${id}
            `;
          }
          for (const entry of inventory.entries.filter((item) => !Object.values(ROLE_IDS).includes(item.id as never))) {
            await sql`
              INSERT INTO resources (id, type, parent_id, name, storage_path, mime_type, size_bytes, sha256, status, retention_class, security_classification, created_at, updated_at)
              VALUES (${entry.id}, ${entry.type}, ${entry.parentId}, ${entry.name}, ${entry.storagePath}, ${entry.mimeType ?? null}, ${entry.sizeBytes}, ${entry.sha256 ?? null}, 'active', ${entry.retentionClass}, ${entry.securityClassification}, ${entry.modifiedAt}, ${entry.modifiedAt})
            `;
            if (entry.type === "file" && entry.sha256 !== undefined && entry.mimeType !== undefined) {
              const versionId = randomUUID();
              await sql`INSERT INTO file_versions (id, resource_id, storage_path, sha256, size_bytes, mime_type, reason, created_at) VALUES (${versionId}, ${entry.id}, ${entry.storagePath}, ${entry.sha256}, ${entry.sizeBytes}, ${entry.mimeType}, 'initial', ${entry.modifiedAt})`;
              await sql`UPDATE resources SET current_version_id=${versionId} WHERE id=${entry.id}`;
            }
          }
          await sql`
            INSERT INTO storage_switches (id, profile_id, previous_profile_id, host, port, username, root, auth_mode, host_fingerprint, directory_count, file_count, indexed_bytes)
            VALUES (${switchId}, ${profileId}, ${previous.profileId}, ${config.host}, ${config.port}, ${config.username}, ${config.root}, ${config.authMode}, ${config.hostFingerprint}, ${inventory.directoryCount}, ${inventory.fileCount}, ${inventory.indexedBytes})
          `;
          await sql`
            INSERT INTO system_metadata(key, value) VALUES ('active_storage_profile', ${sql.json({ profileId, revision, source: "runtime", activatedAt })})
            ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()
          `;
          await this.#storage.activate({ profileId, revision, activatedAt, config }, adapter);
          releaseCandidate = () => Promise.resolve();
        });
      } catch (error) {
        await this.#storage.restore(previous).catch(() => undefined);
        throw error;
      }
      await Promise.all(bufferedDropPaths.map(async (relativePath) => {
        if (!/^[0-9a-f-]{36}\.part$/i.test(relativePath)) return;
        const absolute = path.resolve(this.#config.drop.bufferDirectory, relativePath);
        if (path.dirname(absolute) !== path.resolve(this.#config.drop.bufferDirectory)) return;
        await fs.rm(absolute, { force: true }).catch(() => undefined);
      }));
      const capacity = await this.#storage.statFs().catch(() => undefined);
      await this.#audit.write({ actorType: "owner", actorId: "owner", action: "storage.profile.switched", outcome: "success", correlationId: `storage-switch:${switchId}`, details: { profileId, previousProfileId: previous.profileId, host: config.host, port: config.port, username: config.username, root: config.root, authMode: config.authMode, fileCount: inventory.fileCount, directoryCount: inventory.directoryCount, indexedBytes: inventory.indexedBytes, migratedBytes: 0, revokedShares, revokedDevices } }).catch(() => undefined);
      return { ...publicStatus(this.#storage.current(), "ready", capacity), indexed: { files: inventory.fileCount, directories: inventory.directoryCount, bytes: inventory.indexedBytes }, revoked: { shares: revokedShares, devices: revokedDevices } };
    } catch (error) {
      await this.#audit.write({ actorType: "owner", actorId: "owner", action: "storage.profile.switched", outcome: "failure", correlationId: `storage-switch:${switchId}:failure`, details: { reason: error instanceof Error ? error.message : "storage_switch_failed" } }).catch(() => undefined);
      throw error;
    } finally {
      await releaseCandidate();
    }
  }

  async #candidate(input: StorageConnectionInput, profileId: string): Promise<{ readonly adapter: StorageAdapter; readonly config: SaturnConfig["storage"]; readonly credentialPath: string }> {
    const credential = input.credential;
    if (input.authMode === "password_file") {
      if (credential.length < 1 || credential.length > 4_096 || /[\r\n]/.test(credential)) throw new Error("invalid_storage_password");
    } else if (credential.length < 64 || credential.length > 65_536 || !credential.includes("PRIVATE KEY")) {
      throw new Error("invalid_storage_private_key");
    }
    const directory = this.#storage.runtimeDirectory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const credentialPath = path.join(directory, `credential-${profileId}.${input.authMode === "password_file" ? "password" : "key"}`);
    await fs.writeFile(credentialPath, input.authMode === "password_file" ? `${credential}\n` : credential, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const config: SaturnConfig["storage"] = {
      host: input.host,
      port: input.port,
      username: input.username,
      root: normalizeRoot(input.root),
      hostFingerprint: input.hostFingerprint,
      authMode: input.authMode,
      ...(input.authMode === "password_file" ? { passwordFile: credentialPath } : { privateKeyFile: credentialPath }),
      operationTimeoutMs: this.#config.storage.operationTimeoutMs,
      healthTimeoutMs: this.#config.storage.healthTimeoutMs,
      maxConnections: this.#config.storage.maxConnections,
    };
    return { adapter: new SftpStorageAdapter(config), config, credentialPath };
  }

  async #smoke(storage: StorageAdapter, switchId: string): Promise<void> {
    const storagePath = `_system/incoming/storage-switch-${switchId}.probe`;
    const body = randomBytes(64);
    try {
      await storage.write(storagePath, Readable.from([body]), { offset: 0, create: true, exclusive: true, truncate: true });
      const stored = await readBounded(storage, storagePath, 128);
      if (stored.length !== body.length || createHash("sha256").update(stored).digest("hex") !== createHash("sha256").update(body).digest("hex")) throw new Error("storage_smoke_checksum_failed");
    } finally {
      if (await storage.exists(storagePath).catch(() => false)) await storage.delete(storagePath).catch(() => undefined);
    }
  }

  async #inventory(storage: StorageAdapter, roleNames: Readonly<Record<RoleName, string>>): Promise<StorageInventory> {
    const entries: IndexedEntry[] = [];
    const rootNames = new Map<string, string>((Object.entries(roleNames) as Array<[RoleName, string]>).map(([role, name]) => [name.toLocaleLowerCase(), ROLE_IDS[role]]));
    const walk = async (storagePath: string, parentId: string, depth: number, forcedId?: string): Promise<number> => {
      if (depth > MAX_INDEX_DEPTH || entries.length >= MAX_INDEX_ENTRIES) throw new Error("storage_index_limit_exceeded");
      const stat = await storage.stat(storagePath);
      const id = forcedId ?? randomUUID();
      const name = stat.name || storagePath.split("/").at(-1) || storagePath;
      const item: IndexedEntry = { id, parentId, type: stat.type === "directory" ? "folder" : "file", name, storagePath, modifiedAt: stat.modifiedAt, sizeBytes: 0, ...policy(storagePath, roleNames, stat.type === "directory" ? "folder" : "file", name) };
      entries.push(item);
      if (stat.type === "file") {
        const hashed = await hashFile(storage, storagePath);
        if (hashed.bytes !== stat.size) throw new Error("storage_file_changed_during_index");
        Object.assign(item, { sizeBytes: hashed.bytes, sha256: hashed.sha256, mimeType: mimeType(name) });
        return hashed.bytes;
      }
      let bytes = 0;
      for (const child of await listAll(storage, storagePath)) {
        if (child.name === "_system") continue;
        bytes += await walk(child.path, id, depth + 1);
      }
      item.sizeBytes = bytes;
      return bytes;
    };
    for (const item of await listAll(storage, "")) {
      if (item.name === "_system") continue;
      if (item.type !== "directory") throw new Error("files_are_not_allowed_in_storage_root");
      await walk(item.path, ROOT_RESOURCE_ID, 1, rootNames.get(item.name.toLocaleLowerCase()));
    }
    const files = entries.filter((entry) => entry.type === "file");
    return { roleNames, entries, fileCount: files.length, directoryCount: entries.length - files.length, indexedBytes: files.reduce((sum, entry) => sum + entry.sizeBytes, 0) };
  }
}
