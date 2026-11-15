import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import { expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { migrate } from "@saturn/database";
import { qualifyCatalogDatabaseRoles } from "../../../packages/database/src/catalog-role-qualification.js";
import { DurableBackendExecutor } from "../../../packages/storage/src/durable-backend-executor.js";
import { CatalogPlutoRetention } from "../../../packages/file-core/src/catalog-pluto-retention.js";
import { activeFixture, evidence, migrations, sha } from "./stage3-chat-a.fixture.js";

it.each([false,true])("retention does not queue single-version files or starve excess history behind a legacy backlog (upgrade=%s)", async upgrade => {
  const f = await activeFixture("retention-backlog", "pluto", upgrade ? 67 : 68);
  let replacement: DurableBackendExecutor | undefined;
  try {
    for (let n = 0; n < 32; n++) {
      const bytes = Buffer.from("unmodified-" + String(n));
      await f.upload(f.uploadInput("single-" + String(n), bytes), bytes);
    }
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT resource_id FROM sync_retention_work`), "only the old scheduler queues single versions").toHaveLength(upgrade ? 32 : 0);
    let previous: { nodeId: string; metadataVersion: string; versionId: string } | undefined;
    for (let n = 0; n < 13; n++) {
      const bytes = Buffer.from("revision-" + String(n));
      await f.upload(f.uploadInput("history", bytes, previous), bytes);
      const row = requireDefined((await f.admin.withSql(sql => sql<{ id:string;metadata_version:string;current_version_id:string }[]>`SELECT id,metadata_version,current_version_id FROM resources WHERE parent_id=${f.rootId} AND name='history'`))[0]);
      previous={nodeId:row.id,metadataVersion:row.metadata_version,versionId:row.current_version_id};
    }
    if (upgrade) {
      // Build the backlog through the actual old writer, then perform a drained
      // forward migration. Never impersonate a writer or edit guarded metadata.
      await f.executor.close();
      const selected=path.join(f.directory,"migrations");
      for(const suffix of ["up","down"]) {
        const name=`0068_retention_backlog_admission.${suffix}.sql`;
        await fs.copyFile(path.join(migrations,name),path.join(selected,name));
      }
      await migrate(f.url,selected);
      const rows=await f.admin.withSql(sql=>sql<{identity:string;source:string}[]>`SELECT p.oid::regprocedure::text AS identity,p.prosrc AS source FROM pg_proc p WHERE p.proowner=(SELECT oid FROM pg_roles WHERE rolname=${f.roles.writerOwner}) ORDER BY p.oid`);
      const approvedFunctions=rows.map(r=>({identity:"public."+r.identity.replace(/^public\./,""),sourceSha256:sha(r.source)}));
      expect(approvedFunctions.filter(r=>r.sourceSha256!==f.approvedFunctions.find(old=>old.identity===r.identity)?.sourceSha256).map(r=>r.identity)).toEqual(["public.sync_retention_command(uuid,jsonb)"]);
      for(const connection of ["runtime","writer"] as const) await qualifyCatalogDatabaseRoles(f[connection],{...f.roles,approvedFunctions,connection});
      replacement=new DurableBackendExecutor(f.raw,f.command,f.backendIdentity,f.generation);
      await replacement.start();
    }
    const retention = new CatalogPlutoRetention(f.writer, f.admission, (replacement??f.executor).identity);
    const progress = [];
    for (let n=0;n<4;n++) {
      progress.push(await retention.tick(f.rootId));
      await vi.waitFor(async()=>expect(await f.admin.withSql(sql=>sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_tasks WHERE state IN ('QUEUED','RUNNING')`)).toHaveLength(0));
    }
    expect(await f.admin.withSql(sql=>sql<Record<string, unknown>[]>`SELECT id FROM file_versions WHERE resource_id=${requireDefined(previous).nodeId} AND state='active'`)).toHaveLength(10);
    expect(await f.admin.withSql(sql=>sql<Record<string, unknown>[]>`SELECT resource_id FROM sync_retention_work`)).toHaveLength(0);
    const originals=await f.admin.withSql(sql=>sql<{state:string;storage_path:string;receipt:unknown}[]>`SELECT state,storage_path,receipt FROM sync_retention_originals`);
    expect(originals).toHaveLength(3);
    for(const original of originals){expect(original.state).toBe("DELETED");expect(original.receipt).toBeTruthy();expect(await f.raw.exists(original.storage_path)).toBe(false);}
    expect(await f.admin.withSql(sql=>sql<Record<string, unknown>[]>`SELECT id FROM resources WHERE parent_id=${f.rootId} AND name LIKE 'single-%' AND status='active'`)).toHaveLength(32);
    await evidence("retention-backlog",upgrade?"upgrade-result":"fresh-result",{status:"PASS",progress,originals});
  } finally { await replacement?.close(); await f.close(); }
},60000);
