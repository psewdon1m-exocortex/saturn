import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Database, migrate } from "@saturn/database";
import { LocalStorageAdapter } from "@saturn/storage";
import { expect, it } from "vitest";
import { PostgresRootJournal, type RootJournalEvent } from "../../file-core/src/root-journal.js";
import { DatabaseMetadataExporter } from "./metadata-exporter.js";
import { PostgresCommandToolchain } from "./postgres-toolchain.js";
import { SaturnBackupService } from "./service.js";
import { BackupArchiveValidator } from "./archive.js";
import type { RecoverySnapshot } from "./consistent-snapshot.js";
import type { RecoveryLimits } from "./types.js";

const fixtureFile = process.env.SYNC_RECOVERY_TEST_FIXTURE;
const exec = promisify(execFile);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const limits: RecoveryLimits = { maxArchiveBytes: 256*1024*1024, maxMemberBytes: 256*1024*1024,
  maxExtractedBytes: 1024*1024*1024, maxEntries: 512, maxCompressionRatio: 2000, maxManifestBytes: 1024*1024 };

it.skipIf(!fixtureFile)("qualifies coherent logical backup and guarded recovery on its own PostgreSQL container", async () => {
  if (!fixtureFile) throw new Error("An explicitly owned recovery fixture is required");
  const fixture = JSON.parse(await fs.readFile(fixtureFile, "utf8")) as {
    containerId: string; runId: string; databaseUrl: string; fixtureDirectory: string; retainEvidence?: boolean;
  };
  const inspect = JSON.parse((await exec("docker", ["inspect", fixture.containerId], { windowsHide: true })).stdout) as {
    Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean };
    HostConfig: { NanoCpus: number; Memory: number }; NetworkSettings: { Ports: Record<string, {HostIp: string}[]> };
  }[];
  expect(inspect[0]?.Id).toBe(fixture.containerId);
  expect(inspect[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId);
  expect(inspect[0]?.State.Running).toBe(true);
  expect(inspect[0]?.HostConfig.NanoCpus).toBeLessThanOrEqual(1_000_000_000);
  expect(inspect[0]?.HostConfig.Memory).toBeLessThanOrEqual(512*1024*1024);
  expect(inspect[0]?.NetworkSettings.Ports["5432/tcp"]?.every(binding => binding.HostIp === "127.0.0.1")).toBe(true);
  const directory = path.join(fixture.fixtureDirectory, randomUUID().replaceAll("-", ""));
  await fs.mkdir(directory, { mode: 0o700 });
  const sourceName = new URL(fixture.databaseUrl).pathname.slice(1);
  if (fixture.retainEvidence && !/^recovery_source_[a-f0-9]{32}$/.test(sourceName)) {
    throw new Error("Retained recovery test requires a new owned source database");
  }
  await fs.writeFile(path.join(directory, "ownership.json"), JSON.stringify({sourceName, containerId: fixture.containerId, runId: fixture.runId}), {flag: "wx"});
  const databases: Database[] = [];
  const admin = new Database(fixture.databaseUrl, { max: 4 }); databases.push(admin);
  const database = admin;
  const dbNames: { name: string; scope: string }[] = [];
  const storages: LocalStorageAdapter[] = [];
  const checks: string[] = [], pageSamples: {table: string; items: number; bytes: number}[] = [];
  const pageQueries: Record<string,{query:string;parameters:readonly unknown[]}> = {};
  const plans: Record<string,unknown> = {};
  let passed = false;
  const migrations = fileURLToPath(new URL("../../database/migrations/", import.meta.url));
  const journal = new PostgresRootJournal(database);
  const rootId = "00000000-0000-7000-8000-000000000001";
  const storageDirectory = path.join(directory, "storage");
  const storage = new LocalStorageAdapter(storageDirectory); storages.push(storage); await storage.initialize();
  const toolchain = (db: Database, url: string, options: { timeout?: number; dumpPrefix?: readonly string[]; maxDump?: number; restorePrefix?: readonly string[] } = {}) => {
    const databaseName = new URL(url).pathname.slice(1);
    return new PostgresCommandToolchain({ database: db, databaseUrl: url, maximumDumpBytes: options.maxDump ?? 128*1024*1024,
      pgDumpExecutable: "docker", pgRestoreExecutable: "docker", commandTimeoutMs: 15_000, snapshotTimeoutMs: options.timeout ?? 15_000,
      pgDumpPrefixArgs: options.dumpPrefix ?? ["exec", fixture.containerId, "pg_dump"],
      pgRestorePrefixArgs: options.restorePrefix ?? ["exec", "-i", fixture.containerId, "pg_restore"],
      commandConnectionArgs: ["--username", "postgres", "--dbname", databaseName] });
  };
  const target = async (scope: string) => {
    const name = "recovery_" + randomUUID().replaceAll("-", ""); dbNames.push({name, scope});
    await admin.withSql(sql => sql.unsafe(`CREATE DATABASE ${name}`));
    const url = new URL(fixture.databaseUrl); url.pathname = "/" + name;
    const db = new Database(url.toString(), { max: 2 }); databases.push(db);
    return { db, url: url.toString(), tool: toolchain(db, url.toString()) };
  };
  const readRows = async (file: string) => (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  try {
    const [initial] = await database.withSql(sql => sql<{ name: string; empty: boolean }[]>`
      SELECT current_database() AS name, NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      ) AS empty`);
    if (initial?.name !== sourceName || !initial.empty) throw new Error("Recovery source database must be empty and owned");
    await migrate(fixture.databaseUrl, migrations);
    const profileId = randomUUID(), versionId = randomUUID(), fileId = randomUUID(), uploadId = randomUUID();
    const content = "stored bytes stay independently verified";
    await fs.writeFile(path.join(storageDirectory, "stored.bin"), content);
    await database.transaction(async sql => {
      await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status,size_bytes,sha256) VALUES
        (${fileId},'file',${rootId},'stored.bin','stored.bin','active',${content.length},${hash(content)})`;
      await sql`INSERT INTO file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason,state)
        VALUES(${versionId},${fileId},'stored.bin',${hash(content)},${content.length},'text/plain','initial','active')`;
      await sql`UPDATE resources SET current_version_id=${versionId} WHERE id=${fileId}`;
      await sql`INSERT INTO devices(id,name,token_hash,state,scope_ids,can_read,can_write,can_move,can_delete,device_kind,sync_root_id,client_platform,created_at,updated_at)
        VALUES(${profileId},'stable native identity',${hash(profileId)},'active',${[rootId]}::uuid[],true,true,false,false,'windows_sync',${rootId},'windows',now(),now())`;
      await sql`INSERT INTO upload_sessions(id,idempotency_key,parent_id,filename,temp_path,target_path,expected_size,received_size,status,expires_at)
        VALUES(${uploadId},${uploadId},${rootId},'pending','temporary/pending','pending',100,20,'uploading',now()+interval '1 hour')`;
      await sql`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,upload_id,payload)
        VALUES(${uploadId},'upload','created',${uploadId},${uploadId},${sql.json({ backend: "unknown", temp: "temporary/pending" })})`;
    });
    const compose = path.join(directory, "compose.yaml"); await fs.writeFile(compose, "services: {}\n");
    const sourceTool = toolchain(database, fixture.databaseUrl);
    const input = { publicConfiguration: {}, deploymentManifestPath: compose, migrationsDirectory: migrations, kind: "manual" as const };
    const service = new SaturnBackupService({ spoolRoot: path.join(directory, "spool"), limits, database: sourceTool,
      metadata: new DatabaseMetadataExporter(database), storage });
    const legacy = await service.createBackup({ ...input, outputPath: path.join(directory, "legacy.zip") });
    const legacyTarget = await target("legacy-target");
    const targetStorageDirectory = path.join(directory, "legacy-restore-storage");
    const targetStorage = new LocalStorageAdapter(targetStorageDirectory); storages.push(targetStorage);
    await targetStorage.initialize();
    await fs.copyFile(path.join(storageDirectory, "stored.bin"), path.join(targetStorageDirectory, "stored.bin"));
    const targetService = new SaturnBackupService({ spoolRoot: path.join(directory, "legacy-restore-spool"), limits,
      database: legacyTarget.tool, metadata: new DatabaseMetadataExporter(legacyTarget.db), storage: targetStorage });
    await targetService.restore({ archivePath: legacy.archivePath, mode: "clean" });
    await legacyTarget.tool.checkReady();
    const restoredProfile = await legacyTarget.db.withSql(sql => sql`SELECT * FROM devices WHERE id=${profileId}`);
    expect(restoredProfile[0]).toMatchObject({ id: profileId, token_hash: hash(profileId), name: "stable native identity" });
    expect(await legacyTarget.db.withSql(sql => sql`SELECT * FROM operation_journal`)).toHaveLength(0);
    expect(await legacyTarget.db.withSql(sql => sql`SELECT * FROM upload_sessions`)).toHaveLength(0);
    await legacyTarget.db.withSql(sql => sql`INSERT INTO system_metadata(key,value) VALUES('rollback-witness','{"before":true}'::jsonb)`);
    const beforeReplacement = await targetService.createBackup({ ...input, outputPath: path.join(directory, "before-replacement.zip") });
    const rollbackProof = await target("before-replacement-proof");
    const proofDirectory = path.join(directory, "before-replacement-storage");
    const proofStorage = new LocalStorageAdapter(proofDirectory); storages.push(proofStorage);
    await proofStorage.initialize();
    await fs.copyFile(path.join(targetStorageDirectory, "stored.bin"), path.join(proofDirectory, "stored.bin"));
    const proofService = new SaturnBackupService({ spoolRoot: path.join(directory, "before-replacement-spool"), limits,
      database: rollbackProof.tool, metadata: new DatabaseMetadataExporter(rollbackProof.db), storage: proofStorage });
    await proofService.restore({ archivePath: beforeReplacement.archivePath, mode: "clean" });
    await rollbackProof.tool.checkReady();
    expect(await rollbackProof.db.withSql(sql => sql`SELECT value FROM system_metadata WHERE key='rollback-witness'`)).toMatchObject([{value:{before:true}}]);
    expect(await fs.readFile(path.join(proofDirectory, "stored.bin"), "utf8")).toBe(content);
    let profileApplied = false, rolledBack = false;
    await expect(targetService.restore({ archivePath: legacy.archivePath, mode: "replace", configuration: {
      prepare: () => Promise.resolve(), apply: () => { profileApplied=true; return Promise.reject(new Error("injected configuration failure")); },
      rollback: () => { rolledBack=true; profileApplied=false; return Promise.resolve(); },
    } })).rejects.toThrow("injected configuration failure");
    expect(profileApplied).toBe(false); expect(rolledBack).toBe(true);
    expect(await legacyTarget.db.withSql(sql => sql`SELECT * FROM system_metadata WHERE key='rollback-witness'`)).toHaveLength(1);
    await legacyTarget.tool.checkReady();
    const mismatchDirectory = path.join(directory, "mismatch-storage");
    const mismatchStorage = new LocalStorageAdapter(mismatchDirectory); storages.push(mismatchStorage);
    await mismatchStorage.initialize();
    await fs.writeFile(path.join(mismatchDirectory, "stored.bin"), "wrong bytes", {flag: "wx"});
    const mismatchService = new SaturnBackupService({ spoolRoot: path.join(directory, "mismatch-spool"), limits,
      database: legacyTarget.tool, metadata: new DatabaseMetadataExporter(legacyTarget.db), storage: mismatchStorage });
    await expect(mismatchService.restore({ archivePath: legacy.archivePath, mode: "replace" })).rejects.toThrow("does not match stored file version");
    expect(await legacyTarget.db.withSql(sql => sql`SELECT * FROM system_metadata WHERE key='rollback-witness'`)).toHaveLength(1);
    expect(await fs.readFile(path.join(storageDirectory, "stored.bin"), "utf8")).toBe(content);
    expect(await fs.readFile(path.join(targetStorageDirectory, "stored.bin"), "utf8")).toBe(content);
    checks.push("real legacy coherent archive; clean restore; immutable native profile identity; transient pair excluded; replace configuration rollback; byte mismatch rollback");

    const ddlTarget = await target("concurrent-ddl");
    type TransactionSql = Parameters<Parameters<Database["transaction"]>[0]>[0];
    let interveningDdl = false;
    const ddlDatabase = new Proxy(ddlTarget.db, {
      get(targetDb, property) {
        if (property === "transaction") return <T>(action: (sql: TransactionSql) => Promise<T>) => targetDb.transaction(sql => action(new Proxy(sql, {
          get(transaction, method) {
            if (method === "unsafe") return async (query: string, parameters?: readonly unknown[]) => {
              if (query.startsWith("ALTER SCHEMA public RENAME")) {
                // A separate connection commits after the initial emptiness check.
                await ddlTarget.db.withSql(other => other.unsafe("CREATE TABLE public.concurrent_ddl(id integer)"));
                interveningDdl = true;
              }
              return transaction.unsafe(query, parameters as never[]);
            };
            const value: unknown = Reflect.get(transaction, method);
            return typeof value === "function" ? value.bind(transaction) as unknown : value;
          },
        })));
        const value: unknown = Reflect.get(targetDb, property);
        return typeof value === "function" ? value.bind(targetDb) as unknown : value;
      },
    });
    await expect(toolchain(ddlDatabase, ddlTarget.url).beginCleanRestore()).rejects.toThrow("empty public schema");
    expect(interveningDdl).toBe(true);
    expect(await ddlTarget.db.withSql(sql => sql`SELECT to_regclass('public.concurrent_ddl') AS table_name,
      to_regnamespace('_saturn_restore_guard') AS restore_guard`)).toMatchObject([{table_name:"concurrent_ddl",restore_guard:null}]);
    expect(await ddlTarget.db.withSql(sql => sql`SELECT count(*)::text AS count FROM pg_namespace WHERE nspname LIKE '_saturn_original_%'`)).toMatchObject([{count:"0"}]);
    checks.push("concurrent DDL after initial clean check is caught after exact-identity rename; transaction rolls back without losing the committed table or leaving a guard");

    const clock = await journal.registerRoot(rootId);
    const intent = hash(uploadId); await journal.bindOperation(rootId, clock.epoch, uploadId, intent);
    const publish = async (count: number, prefix: string, selected = clock) => {
      const operationId = randomUUID(), intentHash = hash(operationId);
      await database.withSql(sql => sql`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,resource_id)
        VALUES(${operationId},'isolated_metadata_fixture','created',${operationId},${rootId})`);
      await journal.bindOperation(rootId, selected.epoch, operationId, intentHash);
      const events: RootJournalEvent[] = Array.from({ length: count }, (_, i) => ({ nodeId: randomUUID(), kind: "upsert",
        description: { parentId: rootId, name: `${prefix}-${String(i)}`, type: "folder", sizeBytes: "0", sha256: null, versionId: null },
        reason: "isolated-metadata-fixture", actor: { type: "test", id: fixture.runId } }));
      const commitInput = { rootId, epoch: selected.epoch, operationId, intentHash, events, preparedBackend: "isolated_metadata_fixture" as const };
      const receipt = await journal.commit(commitInput, async sql => {
        await sql.query(`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
          SELECT id::uuid,'folder',$1::uuid,name,'journal/'||id,'active' FROM jsonb_to_recordset($2::text::jsonb) AS batch(id text,name text)`,
        [rootId,JSON.stringify(events.map(event => ({id:event.nodeId,name:event.description.name})))]);
        return { fixture: "metadata-only", identity: operationId };
      });
      return { commitInput, receipt };
    };
    const lostResponse = await publish(500, "first"); await publish(500, "second"); await publish(201, "third");
    const rotated = await journal.rotateEpoch(rootId, clock.epoch);
    await database.withSql(sql => sql`UPDATE sync_root_clock SET published_seq=9007199254740992,retained_after_seq=9007199254740992 WHERE root_id=${rootId}`);
    const final = await publish(1, "decimal", { ...rotated, publishedSeq: "9007199254740992", retainedAfterSeq: "9007199254740992" });
    class ConcurrentExport extends DatabaseMetadataExporter {
      override async exportFromSnapshot(destination: string, snapshot: RecoverySnapshot) {
        await publish(1, "after-cut", { ...rotated, publishedSeq: "9007199254740993", retainedAfterSeq: "9007199254740992" });
        const instrumented: RecoverySnapshot = { ...snapshot, query: async <T extends readonly Record<string, unknown>[]>(query: string, parameters?: readonly unknown[]): Promise<T> => {
          const rows = await snapshot.query<T>(query, parameters);
          if (query.includes("WITH page AS")) {
            const table=/FROM public\.(\w+)/.exec(query)?.[1] ?? "unknown";
            pageQueries[table]??={query,parameters:parameters??[]};
            pageSamples.push({ table, items: rows.length,
              bytes: rows.reduce((sum,row) => sum + (typeof row.value_text === "string" ? Buffer.byteLength(row.value_text)+1 : 0),0) });
          }
          return rows;
        } };
        return super.exportFromSnapshot(destination, instrumented);
      }
    }
    const registeredService = new SaturnBackupService({ spoolRoot: path.join(directory, "registered-spool"), limits,
      database: sourceTool, metadata: new ConcurrentExport(database), storage });
    const registered = await registeredService.createBackup({ ...input, outputPath: path.join(directory, "registered.zip") });
    const extracted = path.join(directory, "registered-extracted");
    await new BackupArchiveValidator(limits).validate(registered.archivePath, extracted);
    const exportedClock = await readRows(path.join(extracted, "metadata/sync_root_clock.jsonl"));
    expect(exportedClock[0]?.published_seq).toBe("9007199254740993");
    const changes = await readRows(path.join(extracted, "metadata/sync_root_changes.jsonl"));
    expect(changes).toHaveLength(1202); expect(changes.some(row => row.seq === "9007199254740993")).toBe(true);
    expect(changes.some(row => row.seq === "9007199254740994")).toBe(false);
    const intents = await readRows(path.join(extracted, "metadata/operation_journal.jsonl"));
    expect(intents.find(row => row.id === uploadId)).toMatchObject({ sync_epoch: clock.epoch, sync_result: null });
    expect(intents.find(row => row.id === final.commitInput.operationId)).toMatchObject({ sync_first_seq: "9007199254740993", sync_last_seq: "9007199254740993" });
    const coherence = JSON.parse(await fs.readFile(path.join(extracted, "metadata/coherence.json"), "utf8")) as {journal: Record<string,string>};
    expect(coherence.journal).toMatchObject({ changes: "1202", registeredRoots: "1", pendingOperations: "1", finalReceipts: "4", dumpPolicy: "durable-journal-with-upload-dependencies" });
    expect(pageSamples.every(page => page.items <= 500 && page.bytes <= 4*1024*1024)).toBe(true);
    expect(pageSamples.filter(page => page.table === "sync_root_changes" && page.items > 0).map(page => page.items)).toEqual([500,500,202]);
    checks.push("single pg_export_snapshot cut across real dump+JSONL during concurrent publication; 1202 multi-epoch events; composite 500-page keyset; bigint 9007199254740993 preserved; pending and final receipt identity");

    const inspectionTarget = await target("registered-inspection");
    await inspectionTarget.tool.restoreDump(path.join(extracted,"database/database.dump"), "clean");
    expect(await inspectionTarget.db.withSql(sql => sql`SELECT count(*)::text AS count FROM sync_root_changes`)).toMatchObject([{count:"1202"}]);
    expect(await inspectionTarget.db.withSql(sql => sql`SELECT published_seq::text AS seq FROM sync_root_clock`)).toMatchObject([{seq:"9007199254740993"}]);
    expect(await inspectionTarget.db.withSql(sql => sql`SELECT received_size::text AS bytes,status FROM upload_sessions WHERE id=${uploadId}`)).toMatchObject([{bytes:"20",status:"uploading"}]);
    await expect(inspectionTarget.tool.verifyRestoredDatabase()).rejects.toThrow("explicit backend reconciliation");
    await expect(inspectionTarget.tool.commitReplacement()).rejects.toThrow("explicit backend reconciliation");
    await expect(toolchain(inspectionTarget.db,inspectionTarget.url).checkReady()).rejects.toThrow("Interrupted restore");
    const recoveredJournal = new PostgresRootJournal(inspectionTarget.db);
    const replay = await recoveredJournal.commit(final.commitInput, () => Promise.reject(new Error("replay must not execute")));
    expect(replay.replayed).toBe(true); expect(replay.firstSeq).toBe("9007199254740993");
    await expect(recoveredJournal.bindOperation(rootId,rotated.epoch,lostResponse.commitInput.operationId,lostResponse.commitInput.intentHash)).rejects.toThrow();
    await inspectionTarget.tool.rollbackReplacement();
    await inspectionTarget.tool.checkReady();
    expect(await inspectionTarget.db.withSql(sql => sql`SELECT to_regclass('public.sync_root_clock') AS table_name`)).toMatchObject([{table_name:null}]);
    checks.push("real pg_restore all FK dependencies; pending state unchanged/unknown; final lost-response replay no new effect; old epoch ID refused; clean inspection-only persisted guard survives restart; empty original rollback");

    let applied = 0;
    await expect(service.restore({ archivePath: legacy.archivePath, mode: "replace", configuration: {
      prepare: () => Promise.resolve(), apply: () => { applied++; return Promise.resolve(); }, rollback: () => Promise.resolve(),
    } })).rejects.toThrow("explicit backend reconciliation");
    expect(applied).toBe(0);
    expect(await database.withSql(sql => sql`SELECT sync_result FROM operation_journal WHERE id=${final.commitInput.operationId}`)).toHaveLength(1);
    expect(await database.withSql(sql => sql`SELECT to_regnamespace('_saturn_restore_guard') AS guard`)).toMatchObject([{guard:null}]);
    await expect(targetService.restore({ archivePath: registered.archivePath, mode: "replace" })).rejects.toThrow("explicit backend reconciliation");
    checks.push("registered source fencing rejects legacy replacement before schema mutation; registered new archive rejected before applying profile");

    const unknown = await target("unknown-schema");
    await unknown.db.withSql(sql => sql`CREATE TABLE sync_root_clock(root_id text)`);
    const unknownOutput = path.join(directory, "unknown.dump");
    await expect(unknown.tool.createDump(unknownOutput)).rejects.toThrow("Unknown or incomplete");
    expect(await fs.stat(unknownOutput).then(()=>true,()=>false)).toBe(false);
    const cancelled = path.join(directory,"cancelled.dump"), abort = new AbortController(); abort.abort(new Error("requested cancellation"));
    await expect(sourceTool.createDump(cancelled,abort.signal)).rejects.toThrow("requested cancellation");
    expect(await fs.stat(cancelled).then(()=>true,()=>false)).toBe(false);
    const small = path.join(directory,"budget.dump");
    await expect(toolchain(database,fixture.databaseUrl,{maxDump:32}).createDump(small)).rejects.toThrow();
    expect(await fs.stat(small).then(()=>true,()=>false)).toBe(false);
    const failed = path.join(directory,"failed.dump");
    await expect(toolchain(database,fixture.databaseUrl,{dumpPrefix:["exec",fixture.containerId,"false"]}).createDump(failed)).rejects.toThrow();
    expect(await fs.stat(failed).then(()=>true,()=>false)).toBe(false);
    const timed = path.join(directory,"timed.dump");
    await expect(toolchain(database,fixture.databaseUrl,{timeout:150,dumpPrefix:["exec",fixture.containerId,"sh","-c","sleep 1; exec pg_dump \"$@\"","pg_dump"]}).createDump(timed)).rejects.toThrow();
    expect(await fs.stat(timed).then(()=>true,()=>false)).toBe(false);
    let lateSnapshot: RecoverySnapshot | undefined;
    class CancelledExport extends DatabaseMetadataExporter {
      override async exportFromSnapshot(_destination:string,snapshot:RecoverySnapshot):Promise<never> {
        lateSnapshot=snapshot;
        await snapshot.query("SELECT pg_sleep(2)");
        throw new Error('snapshot deadline should cancel the SQL query');
      }
    }
    const cancelledExportDump=path.join(directory,'cancelled-export.dump'),cancelledExportDirectory=path.join(directory,'cancelled-export');
    const cancelledExportStarted=performance.now();
    await expect(toolchain(database,fixture.databaseUrl,{timeout:600}).createCoherentBackup(cancelledExportDump,cancelledExportDirectory,new CancelledExport(database))).rejects.toThrow();
    expect(performance.now()-cancelledExportStarted).toBeLessThan(1800);
    expect(await fs.stat(cancelledExportDump).then(()=>true,()=>false)).toBe(false);
    expect(lateSnapshot).toBeDefined();
    await expect(lateSnapshot?.query('SELECT 1')).rejects.toThrow('deadline');
    const failedTarget = await target("invalid-dump"); await failedTarget.tool.beginCleanRestore();
    await expect(failedTarget.tool.restoreDump(path.join(directory,"legacy.zip"),"clean")).rejects.toThrow();
    await expect(failedTarget.tool.checkReady()).rejects.toThrow("Interrupted restore");
    await failedTarget.tool.rollbackReplacement(); await failedTarget.tool.checkReady();
    const limitedExport = path.join(directory,"limited-metadata");
    await expect(new DatabaseMetadataExporter(database,500,{maximumExportBytes:100}).exportTo(limitedExport)).rejects.toThrow("total byte budget");
    expect(await fs.readdir(limitedExport)).toHaveLength(0);
    const oversized = randomUUID();
    await database.withSql(sql => sql`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,payload)
      VALUES(${oversized},'fixture','created',${oversized},${sql.json({large:"x".repeat(4*1024*1024)})})`);
    const oversizedExport = path.join(directory,"oversized-metadata");
    await expect(new DatabaseMetadataExporter(database).exportTo(oversizedExport)).rejects.toThrow("4 MiB page budget");
    expect(await fs.readdir(oversizedExport)).toHaveLength(0);
    await database.withSql(sql => sql`DELETE FROM operation_journal WHERE id=${oversized}`);
    await database.withSql(sql => sql`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,payload)
      SELECT md5(${fixture.runId}||n::text)::uuid,'fixture','created','large-'||md5(${fixture.runId}||n::text),
        jsonb_build_object('large',repeat('x',16384)) FROM generate_series(1,500) AS candidates(n)`);
    let byteTruncatedPages=0,largeCount=0;
    class ByteBudgetExport extends DatabaseMetadataExporter {
      override async exportFromSnapshot(destination: string, snapshot: RecoverySnapshot) {
        return super.exportFromSnapshot(destination,{...snapshot,query:async <T extends readonly Record<string,unknown>[]>(query:string,parameters?:readonly unknown[]):Promise<T>=>{
          const rows=await snapshot.query<T>(query,parameters);
          if(query.includes("WITH page AS") && query.includes("public.operation_journal") && rows.length){
            const bytes=rows.reduce((sum,row)=>sum+(typeof row.value_text==='string'?Buffer.byteLength(row.value_text)+1:0),0);
            expect(bytes).toBeLessThanOrEqual(4*1024*1024);expect(rows.length).toBeLessThanOrEqual(500);
            if(rows.length<500 && bytes>3*1024*1024)byteTruncatedPages++;
            largeCount+=rows.length;
          }
          return rows;
        }});
      }
    }
    const bytePaged=path.join(directory,'byte-paged');await new ByteBudgetExport(database).exportTo(bytePaged);
    expect((await readRows(path.join(bytePaged,'operation_journal.jsonl'))).filter(row=>String(row.idempotency_key).startsWith('large-'))).toHaveLength(500);
    expect(byteTruncatedPages).toBeGreaterThanOrEqual(1);expect(largeCount).toBeGreaterThanOrEqual(500);
    checks.push('500 large candidates truncated before transport by SQL byte prefix; continuation exports every row without skip');
    const planTarget=await target("query-plan");await migrate(planTarget.url,migrations);
    const planEpoch=randomUUID(),planOperation=randomUUID();
    await planTarget.db.withSql(async sql=>{
      await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
        SELECT md5(n::text)::uuid,'folder',${rootId},'plan-'||n::text,'plan/'||n::text,'active' FROM generate_series(1,100000) AS nodes(n)`;
      await sql`INSERT INTO sync_root_clock(root_id,epoch,published_seq) VALUES(${rootId},${planEpoch},100000)`;
      await sql`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,resource_id,sync_root_id,sync_epoch,sync_first_seq,sync_last_seq,sync_intent_hash,sync_result)
        VALUES(${planOperation},'isolated_query_plan_fixture','active',${planOperation},${rootId},${rootId},${planEpoch},1,100000,${hash(planOperation)},'{}'::jsonb)`;
      // Synthetic rows qualify query plans only; they do not exercise publication.
      await sql`INSERT INTO sync_root_changes(root_id,epoch,seq,node_id,operation_id,document)
        SELECT ${rootId},${planEpoch},n,md5(n::text)::uuid,${planOperation},'{"fixture":"query-plan-only"}'::jsonb FROM generate_series(1,100000) AS events(n)`;
      await sql.unsafe('ANALYZE resources');await sql.unsafe('ANALYZE sync_root_changes');
      for(const table of ['resources','sync_root_changes']){
        const request=pageQueries[table];if(!request)throw new Error('Missing qualified SQL page query');
        const explained=await sql.unsafe<Record<string,unknown>[]>(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${request.query}`,[...request.parameters] as never[]);
        plans[table]=explained;
        const serialized=JSON.stringify(explained);
        expect(serialized).toContain(table+'_pkey');
        const visit=(value:unknown):void=>{
          if(Array.isArray(value)){value.forEach(visit);return;}
          if(typeof value!=='object'||value===null)return;
          const node=value as Record<string,unknown>;
          if(node['Relation Name']===table)expect(node['Node Type']).not.toBe('Seq Scan');
          Object.values(node).forEach(visit);
        };visit(explained);
      }
    });
    await fs.writeFile(path.join(directory,'explain-100k.json'),`${JSON.stringify({syntheticPlanOnly:true,rowsPerTable:100000,plans},null,2)}\n`);
    checks.push('actual EXPLAIN ANALYZE on 100000 catalog rows and 100000 synthetic changes; indexed page selection plus LATERAL exact PK lookup; no whole-table seqscan');
    expect(await database.withSql(sql => sql`SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND xact_start IS NOT NULL AND pid<>pg_backend_pid()`)).toMatchObject([{count:"0"}]);
    checks.push("unknown partial shape rejected before dump; pre-abort; failed/byte-limit/deadline dump cleanup; failed restore leaves guard then rolls back; <=4MiB row/page and total export budgets; no leaked snapshot transaction");
    passed = true;
  } finally {
    await Promise.all([...databases.map(db => db.close()), ...storages.map(store => store.close())]);
    if (!fixture.retainEvidence) {
      const cleanup = new Database(fixture.databaseUrl);
      try { for (const {name} of dbNames) await cleanup.withSql(sql => sql.unsafe(`DROP DATABASE ${name} WITH (FORCE)`)); }
      finally { await cleanup.close(); }
    }
    await fs.writeFile(path.join(directory,"results.json"),`${JSON.stringify({passed,checks,pageSamples,sourceName,dbNames,ownedContainerId:fixture.containerId,runId:fixture.runId,
      inactiveFoundationOnly:true,activatedRecoveryGate:"OPEN",logicalSnapshotOnly:true,createdAt:new Date().toISOString()},null,2)}\n`);
  }
}, 120_000);
