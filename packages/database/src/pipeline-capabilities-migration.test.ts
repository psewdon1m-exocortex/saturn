import fs from "node:fs/promises";
import postgres from "postgres";
import { expect, it } from "vitest";

const databaseUrl = process.env.PIPELINE_TEST_DATABASE_URL;

it.skipIf(!databaseUrl)("rolls pipeline capabilities up and down without widening Windows access or losing resources", async () => {
  if (!databaseUrl) throw new Error("PIPELINE_TEST_DATABASE_URL is required");
  const sql = postgres(databaseUrl, { max: 1 });
  const up = await fs.readFile(new URL("../migrations/0042_pipeline_capabilities.up.sql", import.meta.url), "utf8");
  const down = await fs.readFile(new URL("../migrations/0042_pipeline_capabilities.down.sql", import.meta.url), "utf8");
  try {
    await sql.begin(async transaction => {
      await transaction`CREATE TEMP TABLE resources (id uuid PRIMARY KEY, name text NOT NULL)`;
      await transaction`CREATE TEMP TABLE devices (id uuid PRIMARY KEY, device_kind text NOT NULL, state text NOT NULL,
        revoked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`;
      await transaction`CREATE TEMP TABLE backup_services (id uuid PRIMARY KEY, state text NOT NULL, mirror_root text,
        revoked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`;
      const folder = crypto.randomUUID(), windows = crypto.randomUUID(), generic = crypto.randomUUID(), archive = crypto.randomUUID(), mirror = crypto.randomUUID();
      await transaction`INSERT INTO resources VALUES (${folder},'Office PC')`;
      await transaction`INSERT INTO devices(id,device_kind,state) VALUES (${windows},'windows_sync','active'),(${generic},'generic','active')`;
      await transaction`INSERT INTO backup_services(id,state) VALUES (${archive},'active')`;
      await transaction.unsafe(up);
      expect((await transaction`SELECT archive_pipeline FROM backup_services WHERE id=${archive}`)[0]?.archive_pipeline).toBe(true);
      expect((await transaction`SELECT sync_root_id FROM devices WHERE id=${windows}`)[0]?.sync_root_id).toBeNull();
      await transaction`UPDATE devices SET sync_root_id=${folder} WHERE id=${windows}`;
      await expect(transaction.savepoint(nested => nested`UPDATE devices SET sync_root_id=${folder} WHERE id=${generic}`)).rejects.toMatchObject({ code: "23505" });
      await expect(transaction.savepoint(nested => nested`UPDATE devices SET sync_root_id=${crypto.randomUUID()} WHERE id=${generic}`)).rejects.toMatchObject({ code: "23503" });
      const removedFolder = crypto.randomUUID();
      await transaction`INSERT INTO resources VALUES (${removedFolder},'Owner removes this folder')`;
      await transaction`UPDATE devices SET sync_root_id=${removedFolder} WHERE id=${generic}`;
      await transaction`DELETE FROM resources WHERE id=${removedFolder}`;
      expect((await transaction`SELECT sync_root_id FROM devices WHERE id=${generic}`)[0]?.sync_root_id).toBeNull();
      await expect(transaction.savepoint(nested => nested`INSERT INTO backup_services(id,state,archive_pipeline) VALUES (${crypto.randomUUID()},'active',false)`)).rejects.toMatchObject({ code: "23514" });
      await transaction`INSERT INTO backup_services(id,state,archive_pipeline,mirror_root) VALUES (${mirror},'active',false,'volt')`;
      await transaction.unsafe(down);
      expect((await transaction`SELECT state FROM devices WHERE id=${windows}`)[0]?.state).toBe("revoked");
      expect((await transaction`SELECT state FROM devices WHERE id=${generic}`)[0]?.state).toBe("active");
      expect((await transaction`SELECT state FROM backup_services WHERE id=${mirror}`)[0]?.state).toBe("revoked");
      expect((await transaction`SELECT state FROM backup_services WHERE id=${archive}`)[0]?.state).toBe("active");
      expect((await transaction`SELECT name FROM resources WHERE id=${folder}`)[0]?.name).toBe("Office PC");
      await transaction.unsafe(up);
      expect((await transaction`SELECT state,sync_root_id FROM devices WHERE id=${windows}`)[0]).toMatchObject({ state: "revoked", sync_root_id: null });
    });
  } finally { await sql.end(); }
});
