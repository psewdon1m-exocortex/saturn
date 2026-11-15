import { isolatedTestDatabase } from "./isolated-test-database.fixture.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { expect, it } from "vitest";
import { listMigrationPairs, migrate, rollback } from "./migrate.js";
import { checkpointStorageLayout } from "../../protection/src/storage-catalog-checkpoint.fixture.js";
import { LocalStorageAdapter } from "../../storage/src/local-storage.adapter.js";
import { migrateStorageLayout, SATURN_LAYOUT_V2_ROOT_DIRECTORIES } from "../../storage/src/layout.js";

const databaseUrl = process.env.PIPELINE_TEST_DATABASE_URL;
const WINDOWS_ROOT = "00000000-0000-7000-8000-000000000004";
const BACKUP_ROOT = "00000000-0000-7000-8000-000000000007";
const REFERENCES_ROOT = "00000000-0000-7000-8000-000000000008";
const OUTDOOR_ROOT = "00000000-0000-7000-8000-000000000009";

it.skipIf(!databaseUrl)("migrates the production roots without invalidating Windows, Pluto or backup credentials", async () => {
  if (!databaseUrl) throw new Error("PIPELINE_TEST_DATABASE_URL is required");
  const evidence = process.env.SATURN_TEST_ISOLATION_EVIDENCE_DIR;
  const published = process.env.SATURN_LAYOUT_PUBLISHED_MIGRATIONS;
  if ((evidence === undefined) !== (published === undefined)) throw new Error("Layout evidence and published migrations must be supplied together");
  const directory = evidence === undefined ? undefined : await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "saturn-layout-originals-"));
  const isolated = await isolatedTestDatabase(databaseUrl, directory === undefined ? 47 : 46, directory);
  const url = isolated.url;
  const migrations = published ?? isolated.migrations;
  const storageRoot = directory === undefined ? undefined : path.join(directory, "storage");
  const storage = storageRoot === undefined ? undefined : new LocalStorageAdapter(storageRoot);
  try {
    if (published === undefined) {
      expect(await migrate(url, migrations)).toBe(0);
      expect(await rollback(url, migrations)).toBe("0047_storage_layout_v3");
    } else {
      const baseline = await listMigrationPairs(isolated.migrations);
      const release = await listMigrationPairs(published);
      expect(baseline).toHaveLength(46);
      expect(release).toHaveLength(47);
      expect(release.at(-1)?.name).toBe("0047_storage_layout_v3");
      for (const [index, pair] of baseline.entries()) {
        const publishedPair = release[index];
        if (!publishedPair) throw new Error("Published baseline migration is missing");
        expect(pair.name).toBe(publishedPair.name);
        for (const direction of ["up", "down"] as const) {
          expect(await fs.readFile(pair[direction])).toEqual(await fs.readFile(publishedPair[direction]));
        }
      }
    }
    const sql = postgres(url, { max: 1 });
    try {
      const plutoContainer = randomUUID();
      const plutoRoot = randomUUID();
      const plutoFile = randomUUID();
      const windowsRoot = randomUUID();
      const windowsFile = randomUUID();
      const plutoDevice = randomUUID();
      const windowsDevice = randomUUID();
      const backupService = randomUUID();
      const backupRun = randomUUID();
      const now = new Date("2026-10-11T12:00:00.000Z");
      const plutoTokenHash = "a".repeat(64);
      const windowsTokenHash = "b".repeat(64);
      const backupTokenHash = "c".repeat(64);
      const payloads = [
        { id: plutoFile, v2: "backups/pluto/Outdoor A/outdoor.txt", v3: "# sync outdoor connections/Outdoor A/outdoor.txt", bytes: Buffer.from("pluto-data") },
        { id: windowsFile, v2: "sync/Office PC/windows.txt", v3: "# sync windows/Office PC/windows.txt", bytes: Buffer.from("windowsdata") },
        { id: backupRun, v2: "backups/updater/host-a/state.age", v3: "# sync inner services/updater/host-a/state.age", bytes: Buffer.from("backupdata") },
      ] as const;
      const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      async function verifyPayloads(layout: "v2" | "v3") {
        if (!storageRoot || !storage) return;
        for (const payload of payloads) {
          expect(await fs.readFile(path.join(storageRoot, payload[layout]))).toEqual(payload.bytes);
          expect(await storage.exists(payload[layout === "v2" ? "v3" : "v2"])).toBe(false);
        }
        const marker = JSON.parse(await fs.readFile(path.join(storageRoot, "_system/storage-layout-v3.json"), "utf8")) as { version: number };
        expect(marker.version).toBe(layout === "v2" ? 2 : 3);
      }

      await sql`UPDATE resources SET size_bytes=21 WHERE id=${BACKUP_ROOT}`;
      await sql`UPDATE resources SET size_bytes=11 WHERE id=${WINDOWS_ROOT}`;
      await sql`
        INSERT INTO resources(id,type,parent_id,name,storage_path,size_bytes,status,security_classification,created_at,updated_at)
        VALUES
          (${plutoContainer},'folder',${BACKUP_ROOT},'pluto','backups/pluto',21,'active','internal',${now},${now}),
          (${plutoRoot},'folder',${plutoContainer},'Outdoor A','backups/pluto/Outdoor A',10,'active','internal',${now},${now}),
          (${plutoFile},'file',${plutoRoot},'outdoor.txt','backups/pluto/Outdoor A/outdoor.txt',10,'active','internal',${now},${now}),
          (${windowsRoot},'folder',${WINDOWS_ROOT},'Office PC','sync/Office PC',11,'active','internal',${now},${now}),
          (${windowsFile},'file',${windowsRoot},'windows.txt','sync/Office PC/windows.txt',11,'active','internal',${now},${now})
      `;
      await sql`
        INSERT INTO devices(id,name,token_hash,state,scope_ids,can_read,can_write,can_move,can_delete,
          created_at,updated_at,device_kind,client_platform,sync_root_id)
        VALUES
          (${plutoDevice},'Outdoor A',${plutoTokenHash},'active',ARRAY[${plutoRoot}]::uuid[],true,true,false,false,
            ${now},${now},'pluto','linux',${plutoRoot}),
          (${windowsDevice},'Office PC',${windowsTokenHash},'active',ARRAY[${windowsRoot}]::uuid[],true,true,true,true,
            ${now},${now},'windows_sync','windows',${windowsRoot})
      `;
      await sql`
        INSERT INTO backup_services(id,slug,name,token_hash,state,require_encryption,max_backup_bytes,daily_quota_bytes,
          stored_quota_bytes,max_concurrent_runs,freshness_sla_ms,retention_daily,retention_weekly,retention_monthly,
          retention_yearly,created_at,updated_at,namespace_slug,deployment_id,pipeline_kind,archive_pipeline)
        VALUES (${backupService},'updater-host-a','Updater host A',${backupTokenHash},'active',true,1024,2048,4096,1,
          60000,7,4,12,2,${now},${now},'updater','host-a','host_service',true)
      `;
      await sql`
        INSERT INTO service_backup_runs(id,service_id,client_key_hash,filename,source_created_at,backup_type,
          expected_size,expected_sha256,source_version,encrypted,state,received_size,temp_path,final_path,receipt,
          created_at,updated_at,committed_at)
        VALUES (${backupRun},${backupService},${"d".repeat(64)},'state.age',${now},'full',10,${digest(payloads[2].bytes)},
          '1.0.0',true,'complete',10,'_system/incoming/backups/state.part','backups/updater/host-a/state.age',
          ${sql.json({ logicalPath: "/backups/updater/host-a/state.age" })},${now},${now},${now})
      `;

      if (directory && evidence && storageRoot && storage) {
        const name = new URL(url).pathname.slice(1);
        const runtime = path.join(directory, "runtime");
        await fs.mkdir(runtime);
        await fs.writeFile(path.join(evidence, "ownership.json"), JSON.stringify({ name, directory }), { flag: "wx" });
        await fs.writeFile(path.join(runtime, "fixture-authority.json"), JSON.stringify({
          fixtureOnly: true, name, devices: [{ id: plutoDevice, root: plutoRoot, tokenHash: plutoTokenHash },
            { id: windowsDevice, root: windowsRoot, tokenHash: windowsTokenHash }],
          backup: { id: backupService, run: backupRun, tokenHash: backupTokenHash },
          payloads: payloads.map(({ bytes, ...entry }) => ({ ...entry, bytes: bytes.length, sha256: digest(bytes) })),
        }), { flag: "wx", mode: 0o600 });
        await storage.initialize();
        for (const root of SATURN_LAYOUT_V2_ROOT_DIRECTORIES) await storage.mkdir(root);
        await storage.mkdir("_system");
        await fs.writeFile(path.join(storageRoot, "_system/storage-layout-v3.json"), JSON.stringify({ version: 2 }), { flag: "wx" });
        for (const payload of payloads) {
          const file = path.join(storageRoot, payload.v2);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, payload.bytes, { flag: "wx" });
        }
        await verifyPayloads("v2");
        await checkpointStorageLayout("before-layout-up", url, directory, evidence);
        expect((await migrateStorageLayout(storage, "up")).version).toBe(3);
      }

      expect(await migrate(url, migrations)).toBe(1);
      expect(await migrate(url, migrations)).toBe(0);
      await verifyPayloads("v3");
      if (storage) expect((await migrateStorageLayout(storage, "up")).actions).toEqual([]);
      const roots = await sql<{ id: string; name: string; storage_path: string; status: string }[]>`
        SELECT id,name,storage_path,status FROM resources
        WHERE parent_id='00000000-0000-7000-8000-000000000001' ORDER BY storage_path
      `;
      expect(roots.filter(row => row.status === "active").map(row => row.storage_path)).toEqual([
        "# drop point", "# laboratory", "# mastermind", "# references", "# sync inner services",
        "# sync outdoor connections", "# sync windows", "# volt",
      ]);
      expect(roots.find(row => row.id === REFERENCES_ROOT)?.name).toBe("# references");
      expect(roots.find(row => row.id === OUTDOOR_ROOT)?.name).toBe("# sync outdoor connections");
      expect(await sql`SELECT id,parent_id,storage_path FROM resources WHERE id=${plutoRoot}`).toMatchObject([
        { id: plutoRoot, parent_id: OUTDOOR_ROOT, storage_path: "# sync outdoor connections/Outdoor A" },
      ]);
      expect(await sql`SELECT id,parent_id,storage_path FROM resources WHERE id=${plutoFile}`).toMatchObject([
        { id: plutoFile, parent_id: plutoRoot, storage_path: "# sync outdoor connections/Outdoor A/outdoor.txt" },
      ]);
      expect(await sql`SELECT id,parent_id,storage_path FROM resources WHERE id=${windowsRoot}`).toMatchObject([
        { id: windowsRoot, parent_id: WINDOWS_ROOT, storage_path: "# sync windows/Office PC" },
      ]);
      expect(await sql`SELECT id,token_hash,sync_root_id,scope_ids,state FROM devices ORDER BY id`).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: plutoDevice, token_hash: plutoTokenHash, sync_root_id: plutoRoot, scope_ids: [plutoRoot], state: "active" }),
          expect.objectContaining({ id: windowsDevice, token_hash: windowsTokenHash, sync_root_id: windowsRoot, scope_ids: [windowsRoot], state: "active" }),
        ]),
      );
      expect(await sql`SELECT id,token_hash,state FROM backup_services WHERE id=${backupService}`).toMatchObject([
        { id: backupService, token_hash: backupTokenHash, state: "active" },
      ]);
      expect(await sql`SELECT final_path,receipt->>'logicalPath' AS logical_path FROM service_backup_runs WHERE id=${backupRun}`).toMatchObject([
        { final_path: "# sync inner services/updater/host-a/state.age", logical_path: "/backups/updater/host-a/state.age" },
      ]);

      if (directory && evidence) await checkpointStorageLayout("before-layout-down", url, directory, evidence);
      expect(await rollback(url, migrations)).toBe("0047_storage_layout_v3");
      if (storage) expect((await migrateStorageLayout(storage, "down")).version).toBe(2);
      await verifyPayloads("v2");
      expect(await sql`SELECT id,parent_id,storage_path FROM resources WHERE id=${plutoRoot}`).toMatchObject([
        { id: plutoRoot, parent_id: plutoContainer, storage_path: "backups/pluto/Outdoor A" },
      ]);
      expect(await sql`SELECT id,parent_id,storage_path FROM resources WHERE id=${windowsRoot}`).toMatchObject([
        { id: windowsRoot, parent_id: WINDOWS_ROOT, storage_path: "sync/Office PC" },
      ]);
      expect(await sql`SELECT id,token_hash,sync_root_id,scope_ids,state FROM devices ORDER BY id`).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: plutoDevice, token_hash: plutoTokenHash, sync_root_id: plutoRoot, scope_ids: [plutoRoot], state: "active" }),
          expect.objectContaining({ id: windowsDevice, token_hash: windowsTokenHash, sync_root_id: windowsRoot, scope_ids: [windowsRoot], state: "active" }),
        ]),
      );
      expect(await sql`SELECT final_path,receipt->>'logicalPath' AS logical_path FROM service_backup_runs WHERE id=${backupRun}`).toMatchObject([
        { final_path: "backups/updater/host-a/state.age", logical_path: "/backups/updater/host-a/state.age" },
      ]);
    } finally {
      await sql.end();
    }
  } finally {
    await storage?.close();
  }
}, 60_000);
