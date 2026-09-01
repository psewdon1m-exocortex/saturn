import type { StorageAdapter, StorageFileInfo } from "./types.js";

export const SATURN_BUSINESS_ROOT_DIRECTORIES = [
  "drop point",
  "laboratory",
  "backups",
  "mastermind",
  "volt",
  "sync",
] as const;

// Default names for roots represented by the resource registry. Runtime
// reconciliation resolves their current paths from stable database IDs so a
// user rename is preserved. `laboratory` and `backups` retain independent
// lifecycles and are excluded from file-resource orphan handling.
export const SATURN_RESOURCE_ROOT_DIRECTORIES = [
  "drop point",
  "mastermind",
  "volt",
  "sync",
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
const UP_MAPPINGS = [
  ["drive/Inbox", "drop point"],
  ["drive/Laboratory", "laboratory"],
  ["drive/mastermind", "mastermind"],
  ["drive/Passwords", "volt"],
  ["drive/Sync", "sync"],
] as const;

export interface StorageLayoutMigrationResult {
  readonly direction: "up" | "down";
  readonly state: "ready";
  readonly actions: readonly string[];
  readonly businessRoots: typeof SATURN_BUSINESS_ROOT_DIRECTORIES;
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

async function migrateUp(storage: StorageAdapter, actions: string[]): Promise<void> {
  await assertRootContainsDirectoriesOnly(storage);
  const hasLegacyDrive = await storage.exists("drive");
  const hasSystemRoot = await storage.exists("_system");
  if (hasLegacyDrive) {
    if ((await storage.stat("drive")).type !== "directory") throw new Error("Legacy storage path is not a directory: drive");
    const allowed = new Set<string>([...UP_MAPPINGS.map(([source]) => source.slice("drive/".length)), ...LEGACY_ROOT_DIRECTORIES]);
    const unexpected = (await entries(storage, "drive")).filter((entry) => !allowed.has(entry.name));
    if (unexpected.length > 0) throw new Error(`Unclassified legacy root data must be moved manually: ${unexpected.map((entry) => entry.path).join(", ")}`);
    for (const directory of LEGACY_ROOT_DIRECTORIES) {
      const state = await directoryState(storage, `drive/${directory}`);
      if (state === "nonempty") throw new Error(`Legacy directory must be emptied before layout migration: drive/${directory}`);
    }
    for (const [source, target] of UP_MAPPINGS) await preflightPair(storage, source, target);
    for (const [source, target] of UP_MAPPINGS) await movePair(storage, source, target, actions);
    for (const directory of LEGACY_ROOT_DIRECTORIES) {
      const legacyPath = `drive/${directory}`;
      if (await storage.exists(legacyPath)) {
        await storage.delete(legacyPath);
        actions.push(`rmdir:${legacyPath}`);
      }
    }
    if ((await entries(storage, "drive")).length > 0) throw new Error("Legacy drive directory is not empty after migration");
    await storage.delete("drive");
    actions.push("rmdir:drive");
  }
  // Business roots are provisioned only for a new or legacy installation.
  // Once `_system` marks a v2 installation, their current names are governed
  // by stable resource IDs and must survive subsequent layout checks.
  if (hasLegacyDrive || !hasSystemRoot) await ensureDirectories(storage, SATURN_BUSINESS_ROOT_DIRECTORIES, actions);
  await ensureDirectories(storage, SATURN_SYSTEM_DIRECTORIES, actions);
  await assertRootContainsDirectoriesOnly(storage);
}

async function migrateDown(storage: StorageAdapter, actions: string[]): Promise<void> {
  await assertRootContainsDirectoriesOnly(storage);
  for (const [, source] of UP_MAPPINGS) {
    if ((await directoryState(storage, source)) === "missing") {
      throw new Error(`Storage layout rollback requires the original canonical name: ${source}`);
    }
  }
  await ensureDirectories(storage, ["drive"], actions);
  const mappings = UP_MAPPINGS.map(([legacy, current]) => [current, legacy] as const);
  for (const [source, target] of mappings) await preflightPair(storage, source, target);
  for (const [source, target] of mappings) await movePair(storage, source, target, actions);
  await ensureDirectories(storage, LEGACY_ROOT_DIRECTORIES.map((directory) => `drive/${directory}`), actions);
  await ensureDirectories(storage, ["backups", ...SATURN_SYSTEM_DIRECTORIES], actions);
}

export async function migrateStorageLayout(
  storage: StorageAdapter,
  direction: "up" | "down" = "up",
): Promise<StorageLayoutMigrationResult> {
  const actions: string[] = [];
  if (direction === "up") await migrateUp(storage, actions);
  else await migrateDown(storage, actions);
  return { direction, state: "ready", actions, businessRoots: SATURN_BUSINESS_ROOT_DIRECTORIES, systemRoot: "_system" };
}
