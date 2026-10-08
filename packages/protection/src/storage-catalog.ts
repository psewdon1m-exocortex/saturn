import { createHash } from "node:crypto";
import { ROOT_RESOURCE_ID, DROP_POINT_RESOURCE_ID, MASTERMIND_RESOURCE_ID, SYNC_RESOURCE_ID, VOLT_RESOURCE_ID, LABORATORY_RESOURCE_ID, BACKUPS_RESOURCE_ID } from "@saturn/file-core";
import { normalizeStorageName, type StorageAdapter } from "@saturn/storage";
const CANONICAL_ROOT_RESOURCE_IDS = [DROP_POINT_RESOURCE_ID, MASTERMIND_RESOURCE_ID, SYNC_RESOURCE_ID, VOLT_RESOURCE_ID, LABORATORY_RESOURCE_ID, BACKUPS_RESOURCE_ID];

export interface CatalogResource {
  id: string; parentId: string | null; name: string; storagePath: string;
  type: "file" | "folder"; status: string; sizeBytes: number; sha256: string | null;
  currentVersionId: string | null; retentionClass: string; securityClassification: string; updatedAt: string;
}
export interface CatalogObservation {
  storagePath: string; name: string; type: "file" | "folder"; sizeBytes: number;
  sha256: string | null; modifiedAt: string;
}
export interface CatalogChange {
  kind: "added" | "changed" | "missing" | "blocked";
  storagePath: string; reason: string;
  before: CatalogResource | null; after: CatalogObservation | null;
}
export interface CatalogPlan {
  catalogStamp: string; inventoryStamp: string;
  changes: CatalogChange[];
  counts: { added: number; changed: number; missing: number; blocked: number };
}
export interface CatalogProgress { entries: number; bytes: number; currentPath: string }

export function catalogStamp(resources: readonly CatalogResource[]): string {
  return createHash("sha256").update(JSON.stringify([...resources].sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");
}

// These limits bound metadata, not file contents: SHA-256 is calculated as a stream.
export async function scanStorageCatalog(storage: StorageAdapter, progress: (value: CatalogProgress) => Promise<void>): Promise<{ entries: CatalogObservation[]; blocked: CatalogChange[] }> {
  const entries: CatalogObservation[] = [];
  const blocked: CatalogChange[] = [];
  let bytes = 0;
  let visited = 0;
  let metadataBytes = 0;
  const paths = new Set<string>();
  const walk = async (directory: string, depth: number): Promise<number> => {
    if (depth > 128) throw new Error("storage_analysis_depth_limit");
    let cursor: string | undefined;
    const names = new Set<string>();
    let total = 0;
    do {
      const page = await storage.list(directory, cursor, 500);
      const previousCursor = cursor;
      cursor = page.nextCursor;
      if (cursor !== undefined && cursor === previousCursor) throw new Error("storage_analysis_invalid_cursor");
      for (const child of page.entries) {
        if (directory === "" && child.name === "_system") continue;
        if (++visited > 100_000) throw new Error("storage_analysis_entry_limit");
        metadataBytes += Buffer.byteLength(child.path) + 128;
        if (metadataBytes > 32 * 1024 * 1024) throw new Error("storage_analysis_metadata_limit");
        const expectedPath = directory === "" ? child.name : `${directory}/${child.name}`;
        let validName = false;
        try { validName = normalizeStorageName(child.name) === child.name; } catch { /* report the unsupported name */ }
        if (!validName || child.path !== expectedPath || child.path.startsWith("_system/")
          || child.path.length > 4_096 || paths.has(child.path) || names.has(child.name.toLowerCase())) {
          blocked.push({ kind: "blocked", storagePath: child.path, reason: "unsupported_or_conflicting_path", before: null, after: null });
          continue;
        }
        paths.add(child.path); names.add(child.name.toLowerCase());
        if (directory === "" && child.type !== "directory") {
          blocked.push({ kind: "blocked", storagePath: child.path, reason: "file_in_storage_root", before: null, after: null });
          continue;
        }
        const stat = await storage.stat(child.path);
        if (stat.type !== child.type || !Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error("storage_changed_during_analysis");
        const entry: CatalogObservation = {
          storagePath: child.path, name: child.name, type: stat.type === "directory" ? "folder" : "file",
          sizeBytes: 0, sha256: null, modifiedAt: stat.modifiedAt.toISOString(),
        };
        entries.push(entry);
        if (entry.type === "folder") entry.sizeBytes = await walk(entry.storagePath, depth + 1);
        else {
          const hash = createHash("sha256");
          const stream = await storage.openRead(child.path);
          try {
            for await (const chunk of stream) {
              const buffer = Buffer.from(chunk as Uint8Array);
              hash.update(buffer); entry.sizeBytes += buffer.length; bytes += buffer.length;
              await progress({ entries: visited, bytes, currentPath: child.path });
            }
          } finally { stream.destroy(); }
          const after = await storage.stat(child.path);
          if (entry.sizeBytes !== stat.size || after.type !== "file" || after.size !== stat.size
            || after.modifiedAt.getTime() !== stat.modifiedAt.getTime()) throw new Error("storage_changed_during_analysis");
          entry.sha256 = hash.digest("hex");
        }
        total += entry.sizeBytes;
        if (!Number.isSafeInteger(total) || !Number.isSafeInteger(bytes)) throw new Error("storage_analysis_size_limit");
        metadataBytes += Buffer.byteLength(JSON.stringify(entry));
        if (metadataBytes > 32 * 1024 * 1024) throw new Error("storage_analysis_metadata_limit");
        await progress({ entries: visited, bytes, currentPath: child.path });
      }
    } while (cursor !== undefined);
    return total;
  };
  const root = await storage.stat("");
  if (root.type !== "directory") throw new Error("storage_analysis_root_invalid");
  const total = await walk("", 0);
  entries.push({storagePath:"",name:"root",type:"folder",sizeBytes:total,sha256:null,modifiedAt:root.modifiedAt.toISOString()});
  return { entries, blocked };
}

export function buildCatalogPlan(resources: readonly CatalogResource[], inventory: { entries: readonly CatalogObservation[]; blocked: readonly CatalogChange[] }): CatalogPlan {
  const byPath = new Map(resources.map(row => [row.storagePath, row]));
  const byFoldedPath = new Map(resources.map(row => [row.storagePath.toLowerCase(), row]));
  const observed = new Map(inventory.entries.map(row => [row.storagePath, row]));
  const changes: CatalogChange[] = [...inventory.blocked];
  for (const after of inventory.entries) {
    const before = byPath.get(after.storagePath) ?? null;
    if (before === null && byFoldedPath.has(after.storagePath.toLowerCase())) changes.push({ kind: "blocked", storagePath: after.storagePath, reason: "unsupported_or_conflicting_path", before, after });
    else if (before === null) changes.push({ kind: "added", storagePath: after.storagePath, reason: "not_in_catalog", before, after });
    else if (before.type !== after.type || ["trashed", "purged", "pending"].includes(before.status)) {
      changes.push({ kind: "blocked", storagePath: after.storagePath, reason: "catalog_state_or_type_conflict", before, after });
    } else if (before.sizeBytes !== after.sizeBytes || before.sha256 !== after.sha256 || before.status !== "active") {
      const immutable = before.retentionClass === "laboratory_immutable";
      changes.push({ kind: immutable ? "blocked" : "changed", storagePath: after.storagePath,
        reason: immutable ? "immutable_resource_changed" : before.status !== "active" ? "resource_can_be_recovered" : after.type === "folder" ? "folder_size_changed" : "content_changed", before, after });
    }
  }
  for (const before of resources) {
    if (before.id === ROOT_RESOURCE_ID || ["trashed", "purged", "pending"].includes(before.status) || observed.has(before.storagePath)) continue;
    const canonical = CANONICAL_ROOT_RESOURCE_IDS.includes(before.id);
    if (before.status === "missing" && !canonical) continue;
    changes.push({ kind: canonical ? "blocked" : "missing", storagePath: before.storagePath,
      reason: canonical ? "protected_root_missing" : "not_on_storage", before, after: null });
  }
  // A blocked parent/path must never permit an incomplete catalog rebuild.
  changes.sort((a, b) => a.storagePath.localeCompare(b.storagePath));
  const counts = { added: 0, changed: 0, missing: 0, blocked: 0 };
  for (const change of changes) counts[change.kind] += 1;
  return {
    catalogStamp: catalogStamp(resources),
    inventoryStamp: createHash("sha256").update(JSON.stringify([...inventory.entries].sort((a, b) => a.storagePath.localeCompare(b.storagePath)))).digest("hex"),
    changes, counts,
  };
}
