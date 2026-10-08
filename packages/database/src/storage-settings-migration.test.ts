import fs from "node:fs/promises";
import postgres from "postgres";
import { expect, it } from "vitest";

const databaseUrl = process.env.STORAGE_SETTINGS_TEST_DATABASE_URL;
type PreferencesRow = { id: string; settings_order: string[]; trash_retention_days: number };

it.skipIf(!databaseUrl)("migrates saved card orders once and rolls back without changing other preferences", async () => {
  if (!databaseUrl) throw new Error("STORAGE_SETTINGS_TEST_DATABASE_URL is required");
  const sql = postgres(databaseUrl, { max: 1 });
  const up = await fs.readFile(new URL("../migrations/0040_storage_settings_section.up.sql", import.meta.url), "utf8");
  const down = await fs.readFile(new URL("../migrations/0040_storage_settings_section.down.sql", import.meta.url), "utf8");
  const legacy = ["appearance", "security", "backup", "gryphon", "updates", "logs"];
  const custom = ["logs", "backup", "security", "updates", "appearance", "gryphon"];
  const current = ["storage", "logs", "backup", "security", "updates", "appearance", "gryphon"];
  try {
    await sql.begin(async (transaction) => {
      // A temporary table keeps this verification isolated from application data.
      await transaction`CREATE TEMP TABLE owner_preferences (
        id text PRIMARY KEY, settings_order jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), trash_retention_days int NOT NULL DEFAULT 45
      ) ON COMMIT DROP`;
      await transaction`INSERT INTO owner_preferences (id, settings_order) VALUES
        ('legacy', ${transaction.json(legacy)}), ('custom', ${transaction.json(custom)}),
        ('current', ${transaction.json(current)})`;
      await transaction.unsafe(up);
      await transaction.unsafe(up);
      const rows = await transaction<PreferencesRow[]>`SELECT id, settings_order, trash_retention_days FROM owner_preferences ORDER BY id`;
      expect(rows.map(row => [row.id, row.settings_order, row.trash_retention_days])).toEqual([
        ["current", current, 45],
        ["custom", ["logs", "backup", "security", "storage", "updates", "appearance", "gryphon"], 45],
        ["legacy", ["appearance", "security", "storage", "backup", "gryphon", "updates", "logs"], 45],
      ]);
      await transaction`INSERT INTO owner_preferences (id) VALUES ('new')`;
      expect((await transaction`SELECT settings_order FROM owner_preferences WHERE id = 'new'`)[0]?.settings_order)
        .toEqual(["appearance", "security", "storage", "backup", "gryphon", "updates", "logs"]);
      await transaction.unsafe(down);
      const reverted = await transaction<PreferencesRow[]>`SELECT id, settings_order, trash_retention_days FROM owner_preferences ORDER BY id`;
      expect(reverted.map(row => [row.id, row.settings_order, row.trash_retention_days])).toEqual([
        ["current", current.filter(card => card !== "storage"), 45],
        ["custom", custom, 45], ["legacy", legacy, 45], ["new", legacy, 45],
      ]);
      await transaction`INSERT INTO owner_preferences (id) VALUES ('after-rollback')`;
      expect((await transaction`SELECT settings_order FROM owner_preferences WHERE id = 'after-rollback'`)[0]?.settings_order).toEqual(legacy);
    });
  } finally { await sql.end(); }
});
