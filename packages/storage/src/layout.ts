import { Readable } from "node:stream";
import type { StorageAdapter, StorageFileInfo } from "./types.js";

export const SATURN_STORAGE_LAYOUT_VERSION = 3 as const;
export const SATURN_STORAGE_LAYOUT_MARKER = "_system/storage-layout-v3.json";

export const SATURN_BUSINESS_ROOT_DIRECTORIES = [
  "# drop point",
  "# laboratory",
  "# sync inner services",
  "# mastermind",
  "# volt",
  "# sync windows",
  "# sync outdoor connections",
  "# references",
] as const;

export const SATURN_LAYOUT_V2_ROOT_DIRECTORIES = [
  "drop point",
  "laboratory",
  "backups",
  "mastermind",
  "volt",
  "sync",
] as const;

// Roots represented by the file-resource registry. Laboratory and pipeline
// roots keep independent lifecycle rules and are excluded from ordinary
// file-resource orphan handling.
export const SATURN_RESOURCE_ROOT_DIRECTORIES = [
  "# drop point",
  "# mastermind",
  "# volt",
  "# sync windows",
  "# references",
] as const;

export const SATURN_SYSTEM_DIRECTORIES = [
  "_system",
  "_system/incoming",
  "_system/versions",
  "_system/trash",
  "_system/packages",
  "_system/previews",
  "_system/metadata-exports",
  "_system/orphaned",
] as const;

const LEGACY_ROOT_DIRECTORIES = ["Archive", "Documents", "Photos", "Projects"] as const;
const V1_TO_V2_MAPPINGS = [
  ["drive/Inbox", "drop point"],
  ["drive/Laboratory", "laboratory"],
  ["drive/mastermind", "mastermind"],
  ["drive/Passwords", "volt"],
  ["drive/Sync", "sync"],
] as const;
const V2_TO_V3_MAPPINGS = [
  ["drop point", "# drop point"],
  ["laboratory", "# laboratory"],
  ["backups", "# sync inner services"],
  ["mastermind", "# mastermind"],
  ["volt", "# volt"],
  ["sync", "# sync windows"],
] as const;

export interface StorageLayoutMigrationResult {
  readonly direction: "up" | "down";
  readonly state: "ready";
  readonly version: 2 | 3;
  readonly actions: readonly string[];
  readonly businessRoots: readonly string[];
  readonly systemRoot: "_system";
}

async function entries(storage: StorageAdapter, storagePath: string): Promise<readonly StorageFileInfo[]> {
  const values: StorageFileInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.list(storagePath, cursor, 1_000);
    values.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return values;
}

async function directoryState(storage: StorageAdapter, storagePath: string): Promise<"missing" | "empty" | "nonempty"> {
  if (!(await storage.exists(storagePath))) return "missing";
  if ((await storage.stat(storagePath)).type !== "directory") throw new Error(`Storage layout path is not a directory: ${storagePath}`);
  return (await entries(storage, storagePath)).length === 0 ? "empty" : "nonempty";
}

async function ensureDirectories(storage: StorageAdapter, directories: readonly string[], actions: string[]): Promise<void> {
  for (const directory of directories) {
    const state = await directoryState(storage, directory);
    if (state === "missing") {
      await storage.mkdir(directory);
      actions.push(`mkdir:${directory}`);
    }
  }
}

async function assertRootContainsDirectoriesOnly(storage: StorageAdapter): Promise<void> {
  const unexpected = (await entries(storage, "")).filter((entry) => entry.type !== "directory");
  if (unexpected.length > 0) throw new Error(`Files are not allowed directly in the storage root: ${unexpected.map((entry) => entry.path).join(", ")}`);
}

async function preflightPair(storage: StorageAdapter, source: string, target: string): Promise<void> {
  const [sourceState, targetState] = await Promise.all([directoryState(storage, source), directoryState(storage, target)]);
  if (sourceState === "nonempty" && targetState === "nonempty") {
    throw new Error(`Storage layout collision requires operator merge: ${source} -> ${target}`);
  }
}

async function movePair(storage: StorageAdapter, source: string, target: string, actions: string[]): Promise<void> {
  const sourceState = await directoryState(storage, source);
  if (sourceState === "missing") return;
  const targetState = await directoryState(storage, target);
  if (targetState === "nonempty") {
    if (sourceState !== "empty") throw new Error(`Storage layout collision requires operator merge: ${source} -> ${target}`);
    await storage.delete(source);
    actions.push(`rmdir:${source}`);
    return;
  }
  if (targetState === "empty") {
    await storage.delete(target);
    actions.push(`rmdir:${target}`);
  }
  await storage.rename(source, target);
  actions.push(`rename:${source}->${target}`);
}

async function writeMarker(storage: StorageAdapter, version: 2 | 3, actions: string[]): Promise<void> {
  const body = Buffer.from(`${JSON.stringify({ version, migratedAt: new Date().toISOString() })}\n`, "utf8");
  await storage.write(SATURN_STORAGE_LAYOUT_MARKER, Readable.from([body]), { offset: 0, create: true, truncate: true });
  actions.push(`write:${SATURN_STORAGE_LAYOUT_MARKER}:v${String(version)}`);
}

async function markerVersion(storage: StorageAdapter): Promise<2 | 3 | undefined> {
  if (!(await storage.exists(SATURN_STORAGE_LAYOUT_MARKER))) return undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of await storage.openRead(SATURN_STORAGE_LAYOUT_MARKER)) {
    const chunk = Buffer.from(raw as Uint8Array);
    bytes += chunk.length;
    if (bytes > 4_096) throw new Error("Storage layout marker is invalid");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { version?: unknown };
    return value.version === 2 || value.version === 3 ? value.version : undefined;
  } catch { throw new Error("Storage layout marker is invalid"); }
}

async function migrateLegacyToV2(storage: StorageAdapter, actions: string[]): Promise<void> {
  if (!(await storage.exists("drive"))) return;
  if ((await storage.stat("drive")).type !== "directory") throw new Error("Legacy storage path is not a directory: drive");
  const allowed = new Set<string>([...V1_TO_V2_MAPPINGS.map(([source]) => source.slice("drive/".length)), ...LEGACY_ROOT_DIRECTORIES]);
  const unexpected = (await entries(storage, "drive")).filter((entry) => !allowed.has(entry.name));
  if (unexpected.length > 0) throw new Error(`Unclassified legacy root data must be moved manually: ${unexpected.map((entry) => entry.path).join(", ")}`);
  for (const directory of LEGACY_ROOT_DIRECTORIES) {
    if ((await directoryState(storage, `drive/${directory}`)) === "nonempty") throw new Error(`Legacy directory must be emptied before layout migration: drive/${directory}`);
  }
  for (const [source, target] of V1_TO_V2_MAPPINGS) await preflightPair(storage, source, target);
  for (const [source, target] of V1_TO_V2_MAPPINGS) await movePair(storage, source, target, actions);
  for (const directory of LEGACY_ROOT_DIRECTORIES) {
    const legacyPath = `drive/${directory}`;
    if (await storage.exists(legacyPath)) { await storage.delete(legacyPath); actions.push(`rmdir:${legacyPath}`); }
  }
  if ((await entries(storage, "drive")).length > 0) throw new Error("Legacy drive directory is not empty after migration");
  await storage.delete("drive");
  actions.push("rmdir:drive");
  await ensureDirectories(storage, SATURN_LAYOUT_V2_ROOT_DIRECTORIES, actions);
}

async function plutoSource(storage: StorageAdapter): Promise<string | undefined> {
  for (const candidate of ["backups/pluto", "# sync inner services/pluto"] as const) {
    if (await storage.exists(candidate)) return candidate;
  }
  return undefined;
}

async function preflightPlutoMove(storage: StorageAdapter, source: string | undefined, targetParent: string): Promise<void> {
  if (source === undefined) return;
  if ((await storage.stat(source)).type !== "directory") throw new Error(`Pluto pipeline root is not a directory: ${source}`);
  for (const entry of await entries(storage, source)) {
    if (entry.type !== "directory") throw new Error(`Unexpected file in Pluto pipeline root: ${entry.path}`);
    await preflightPair(storage, entry.path, `${targetParent}/${entry.name}`);
  }
}

async function moveChildren(storage: StorageAdapter, source: string, target: string, actions: string[]): Promise<void> {
  await ensureDirectories(storage, [target], actions);
  for (const entry of await entries(storage, source)) await movePair(storage, entry.path, `${target}/${entry.name}`, actions);
  if ((await entries(storage, source)).length !== 0) throw new Error(`Storage layout source is not empty after migration: ${source}`);
  await storage.delete(source);
  actions.push(`rmdir:${source}`);
}

async function migrateUp(storage: StorageAdapter, actions: string[]): Promise<void> {
  await assertRootContainsDirectoriesOnly(storage);
  const hadSystemRoot = await storage.exists("_system");
  await migrateLegacyToV2(storage, actions);
  await ensureDirectories(storage, SATURN_SYSTEM_DIRECTORIES, actions);

  const hasV2Root = (await Promise.all(SATURN_LAYOUT_V2_ROOT_DIRECTORIES.map((root) => storage.exists(root)))).some(Boolean);
  const hasV3Root = (await Promise.all(SATURN_BUSINESS_ROOT_DIRECTORIES.map((root) => storage.exists(root)))).some(Boolean);
  if (!hasV2Root && !hasV3Root && !hadSystemRoot) {
    await ensureDirectories(storage, SATURN_BUSINESS_ROOT_DIRECTORIES, actions);
    if (await markerVersion(storage) !== 3) await writeMarker(storage, 3, actions);
    return;
  }

  const source = await plutoSource(storage);
  for (const [from, to] of V2_TO_V3_MAPPINGS) await preflightPair(storage, from, to);
  await preflightPlutoMove(storage, source, "# sync outdoor connections");
  for (const [from, to] of V2_TO_V3_MAPPINGS) await movePair(storage, from, to, actions);
  await ensureDirectories(storage, ["# sync outdoor connections", "# references"], actions);
  const relocatedSource = await plutoSource(storage);
  if (relocatedSource !== undefined) await moveChildren(storage, relocatedSource, "# sync outdoor connections", actions);
  await ensureDirectories(storage, SATURN_BUSINESS_ROOT_DIRECTORIES, actions);
  if (await markerVersion(storage) !== 3) await writeMarker(storage, 3, actions);
  await assertRootContainsDirectoriesOnly(storage);
}

async function migrateDown(storage: StorageAdapter, actions: string[]): Promise<void> {
  await assertRootContainsDirectoriesOnly(storage);
  const referencesState = await directoryState(storage, "# references");
  if (referencesState === "nonempty") throw new Error("Storage layout rollback requires # references to be empty");
  await ensureDirectories(storage, ["# sync inner services/pluto"], actions);
  if (await storage.exists("# sync outdoor connections")) {
    await moveChildren(storage, "# sync outdoor connections", "# sync inner services/pluto", actions);
  }
  if (await storage.exists("# references")) { await storage.delete("# references"); actions.push("rmdir:# references"); }
  const reverse = V2_TO_V3_MAPPINGS.map(([oldName, newName]) => [newName, oldName] as const);
  for (const [source, target] of reverse) await preflightPair(storage, source, target);
  for (const [source, target] of reverse) await movePair(storage, source, target, actions);
  await ensureDirectories(storage, SATURN_LAYOUT_V2_ROOT_DIRECTORIES, actions);
  if (await markerVersion(storage) !== 2) await writeMarker(storage, 2, actions);
  await assertRootContainsDirectoriesOnly(storage);
}

export async function migrateStorageLayout(
  storage: StorageAdapter,
  direction: "up" | "down" = "up",
): Promise<StorageLayoutMigrationResult> {
  const actions: string[] = [];
  if (direction === "up") {
    try { await migrateUp(storage, actions); }
    catch (error) {
      const v3Started = actions.some((action) => action.includes("#"));
      if (v3Started) {
        const rollbackActions: string[] = [];
        try { await migrateDown(storage, rollbackActions); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Storage layout migration and rollback failed"); }
      }
      throw error;
    }
  } else await migrateDown(storage, actions);
  return {
    direction,
    state: "ready",
    version: direction === "up" ? 3 : 2,
    actions,
    businessRoots: direction === "up" ? SATURN_BUSINESS_ROOT_DIRECTORIES : SATURN_LAYOUT_V2_ROOT_DIRECTORIES,
    systemRoot: "_system",
  };
}
