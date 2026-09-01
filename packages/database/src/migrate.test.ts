import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMigrationPairs } from "./migrate.js";

describe("migration manifest", () => {
  it("has a rollback pair for every ordered migration", async () => {
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
    const pairs = await listMigrationPairs(directory);
    expect(pairs.map((pair) => pair.name)).toEqual([
      "0001_foundation",
      "0002_file_core",
      "0003_protection_audit",
      "0004_recovery",
      "0005_owner_sessions",
      "0006_telegram_drop",
      "0007_external_shares",
      "0008_device_sync",
      "0009_backup_ingest",
      "0010_resource_graph",
      "0011_laboratory_assets",
      "0012_root_storage_layout",
      "0013_root_folder_policy",
      "0014_remove_resource_graph",
    ]);
    for (const pair of pairs) {
      await expect(fs.readFile(pair.up, "utf8")).resolves.toMatch(/\S/);
      await expect(fs.readFile(pair.down, "utf8")).resolves.toMatch(/\S/);
    }
  });
});
