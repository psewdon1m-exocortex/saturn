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
      "0015_sidebar_preferences",
      "0016_remove_activity_laboratory_navigation",
      "0017_ui_unification",
      "0018_dashboard_transfer_tasks",
      "0019_internal_drop_codes",
      "0020_buffered_drop",
      "0021_folder_aggregate_sizes",
      "0022_drop_shared_channels",
      "0023_telegram_settings_section",
      "0024_runtime_storage_profiles",
      "0025_preview_archive_jobs",
      "0026_backup_connections_settings_section",
      "0027_gryphon_gateway",
      "0028_neptune_enrollment",
      "0029_remove_legacy_telegram",
      "0030_gryphon_settings_section",
      "0031_synchronization_navigation",
      "0032_trash_retention_setting",
      "0033_upload_limits_settings",
      "0034_laboratory_share_assets",
      "0035_neptune_fleet_control",
    ]);
    for (const pair of pairs) {
      await expect(fs.readFile(pair.up, "utf8")).resolves.toMatch(/\S/);
      await expect(fs.readFile(pair.down, "utf8")).resolves.toMatch(/\S/);
    }
  });
});
