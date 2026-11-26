import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database as ArchiveDatabase } from "@saturn/database";
import { checkpointReconciliation } from "../../protection/src/storage-catalog-checkpoint.fixture.js";
import postgres from "postgres";
import { expect, it } from "vitest";
import { Database, migrate } from "./index.js";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedTestDatabase } from "./isolated-test-database.fixture.js";

const baseUrl = process.env.PIPELINE_TEST_DATABASE_URL;
const evidence = process.env.SATURN_MAINTENANCE_EVIDENCE_DIR;

it.skipIf(!baseUrl)("keeps the catalog scope read bounded and isolated while preserving maintenance and interrupted-recovery fences", async () => {
  if (!baseUrl) throw Error("PIPELINE_TEST_DATABASE_URL is required");
  const fixture = await isolatedTestDatabase(baseUrl), raw = postgres(fixture.url, { max: 1 });
  const db = new Database(fixture.url, { max: 1, maintenanceBarrier: true });
  const root = "00000000-0000-7000-8000-000000000001";
  let closed = false;
  try {
    expect(await db.catalogGuardOutside([root])).toBe(true);
    const defaults = await db.withSql(sql => sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`);
    let acquired: () => void = () => undefined, release: () => void = () => undefined;
    const entered = new Promise<void>(r => { acquired = r; }), held = new Promise<void>(r => { release = r; });
    const lock = raw.begin(async sql => { await sql`LOCK TABLE resources IN ACCESS EXCLUSIVE MODE`; acquired(); await held; });
    try {
      await entered;
      const started = performance.now(), pending = db.catalogGuardOutside([root]).then(() => undefined, (error: unknown) => error);
      // The guard's dedicated connection cannot occupy the ordinary query pool.
      await Promise.race([db.ping(), delay(1000).then(() => { throw Error("Catalog guard occupied the ordinary query pool"); })]);
      const error = await pending;
      expect(error).toBeInstanceOf(postgres.PostgresError);
      expect(["57014", "55P03"]).toContain((error as { code: string }).code);
      expect(performance.now() - started).toBeLessThan(5000);
    } finally { release(); await lock; }
    expect(await db.catalogGuardOutside([root])).toBe(true);
    expect(await db.withSql(sql => sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`)).toEqual(defaults);

    let enteredExclusive: () => void = () => undefined, releaseExclusive: () => void = () => undefined;
    const exclusiveReady = new Promise<void>(r => { enteredExclusive = r; });
    const exclusiveHeld = new Promise<void>(r => { releaseExclusive = r; });
    const exclusive = db.withExclusiveMaintenance(async () => { enteredExclusive(); await exclusiveHeld; });
    let finished = false;
    let pending: Promise<boolean> | undefined;
    try {
      await exclusiveReady; pending = db.catalogGuardOutside([root]).then(value => { finished = true; return value; });
      await delay(40); expect(finished).toBe(false);
    } finally { releaseExclusive(); await exclusive; }
    expect(await pending).toBe(true);

    await raw`CREATE SCHEMA _saturn_restore_guard`;
    try { await expect(db.catalogGuardOutside([root])).rejects.toThrow("Interrupted recovery"); }
    finally { await raw`DROP SCHEMA _saturn_restore_guard`; }
    await db.close(); closed = true;
    const remaining = await raw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='saturn_catalog_guard'`;
    expect(remaining[0]?.n).toBe(0);
  } finally { if (!closed) await db.close(); await raw.end({ timeout: 2 }); }
}, 30_000);

async function save(scenario: string, name: string, proof: unknown) {
  if (evidence === undefined) return;
  const root = await fs.realpath(os.tmpdir());
  if (!path.isAbsolute(evidence) || path.dirname(await fs.realpath(evidence)) !== root || !/^audit_[a-f0-9]{32}$/.test(name)) {
    throw new Error("Maintenance evidence requires an owned test database and TEMP");
  }
  await fs.writeFile(path.join(evidence, scenario + ".json"), JSON.stringify({ scenario, name, proof }), { flag: "wx" });
}

it.skipIf(!baseUrl)("keeps short queries and transactions responsive while all filesystem admission slots are busy", async () => {
  if (!baseUrl) throw new Error("PIPELINE_TEST_DATABASE_URL is required");
  const name = `audit_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
  let database: Database | undefined, created = false;
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending: Promise<unknown>[] = [];
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
    const url = new URL(baseUrl); url.pathname = `/${name}`;
    database = new Database(url.toString(), { max: 1, maintenanceBarrier: true });
    const db = database;
    const entered: Promise<void>[] = [];
    for (let i = 0; i < 8; i++) {
      let started: () => void = () => undefined;
      entered.push(new Promise<void>(resolve => { started = resolve; }));
      pending.push(db.withSharedMaintenance(async () => { started(); await held; await db.ping(); }));
    }
    await Promise.all(entered);
    const started=performance.now();
    const queries = Promise.all([db.ping(), db.transaction(async sql => { await sql`SELECT 1`; })]);
    pending.push(queries);
    await Promise.race([queries, delay(1000).then(() => { throw new Error("Short queries waited for unrelated filesystem transfers"); })]);
    await save("short-query", name, { sharedSlots: entered.length, queryMs: performance.now()-started });
  } finally {
    release();
    await Promise.allSettled(pending);
    await database?.close();
    try {
      if (created && evidence === undefined) await admin.unsafe(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  }
}, 15_000);

it.skipIf(!baseUrl).each(["query", "transaction"] as const)("lets an admitted writer finish while %s traffic waits behind exclusive maintenance", async (kind) => {
  if (!baseUrl) throw new Error("PIPELINE_TEST_DATABASE_URL is required");
  const name = `audit_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
  let db: Database | undefined;
  let probe: ReturnType<typeof postgres> | undefined;
  let created = false, completed = false;
  let release: () => void = () => undefined;
  const pending: Promise<unknown>[] = [];
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
    const url = new URL(baseUrl); url.pathname = `/${name}`;
    db = new Database(url.toString(), { max: 1, maintenanceBarrier: true });
    probe = postgres(url.toString(), { max: 1 });
    const inspect = probe;
    let entered: () => void = () => undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const database = db;
    const writer = database.withSharedMaintenance(async () => { entered(); await held; await database.ping(); order.push("writer"); });
    pending.push(writer); void writer.catch(() => undefined);
    await started;
    const exclusive = database.withExclusiveMaintenance(async () => { order.push("exclusive"); });
    pending.push(exclusive); void exclusive.catch(() => undefined);
    const waitFor = async (condition: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) { if (await condition()) return; await delay(10); }
      throw new Error("Expected a PostgreSQL maintenance waiter");
    };
    await waitFor(async () => (await inspect`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=1397967206 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted AND mode='ExclusiveLock'`).length > 0);
    const waiting = kind === "query" ? database.ping() : database.transaction(async sql => { await sql`SELECT 1`; });
    pending.push(waiting); void waiting.catch(() => undefined);
    await waitFor(async () => (await inspect`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=1397967206 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted AND mode='ShareLock'`).length > 0);
    release();
    await Promise.race([Promise.all([writer, exclusive, waiting]), delay(1000).then(() => { throw new Error("Writer was starved by requests waiting for maintenance"); })]);
    expect(order).toEqual(["writer", "exclusive"]);
    completed = true;
    await save(kind, name, { order, actualExclusiveWaiter: true, actualSharedWaiter: true });
  } finally {
    release();
    // Cancel blocked admission on a failing reproduction, freeing the query
    // pool so the older writer and exclusive operation can drain before close.
    if (!completed && created) await admin.unsafe(`SELECT pg_cancel_backend(a.pid) FROM pg_stat_activity a JOIN pg_locks l ON a.pid=l.pid WHERE a.datname='${name}' AND l.locktype='advisory' AND l.mode='ShareLock' AND NOT l.granted`);
    await Promise.allSettled(pending);
    await db?.close().catch(() => undefined);
    await probe?.end().catch(() => undefined);
    try {
      if (created && evidence === undefined) await admin.unsafe(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  }
}, 15_000);

it.skipIf(!baseUrl)("keeps nested writers live with one query connection and recovers interrupted verification", async () => {
  if (!baseUrl) throw new Error("PIPELINE_TEST_DATABASE_URL is required");
  const name = `audit_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
  let created = false;
  let database: Database | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(baseUrl); url.pathname = `/${name}`;
    await migrate(url.toString());
    database = new Database(url.toString(), { max: 1, maintenanceBarrier: true });
    const db = database;
    await Promise.all(Array.from({ length: 12 }, () => db.withSharedMaintenance(() => db.withSharedMaintenance(() => db.ping()))));
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const writer = db.withSharedMaintenance(async () => { entered(); await held; await db.ping(); });
    await started;
    let exclusive = false;
    const maintenance = db.withExclusiveMaintenance(async () => { exclusive = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(exclusive).toBe(false);
    release();
    await Promise.all([writer, maintenance]);
    expect(exclusive).toBe(true);

    const upload = randomUUID(), operation = randomUUID();
    await db.withSql(async sql => {
      const roots = await sql<{ id: string }[]>`SELECT id FROM resources WHERE storage_path='# sync windows'`;
      const root = roots[0]?.id;
      if (root === undefined) throw new Error("Sync root was not migrated");
      await sql`INSERT INTO upload_sessions (id,idempotency_key,parent_id,filename,temp_path,target_path,expected_size,received_size,status,expires_at)
        VALUES (${upload},${upload},${root},'interrupted.txt',${`_system/temp/${upload}`},'sync/interrupted.txt',1,1,'verifying',now()+interval '1 hour')`;
      await sql`INSERT INTO operation_journal (id,operation_type,state,idempotency_key,upload_id)
        VALUES (${operation},'upload','verifying',${operation},${upload})`;
      await sql`INSERT INTO operation_locks (lock_key,operation_id,expires_at) VALUES ('interrupted',${operation},now()+interval '1 hour')`;
    });
    if (evidence !== undefined) {
      const root = await fs.realpath(os.tmpdir());
      const directory = await fs.mkdtemp(path.join(root, "saturn-maintenance-verification-"));
      const checkpoint = await fs.mkdtemp(path.join(root, "saturn-maintenance-proof-"));
      await fs.mkdir(path.join(directory, "storage"));
      await fs.writeFile(path.join(checkpoint, "ownership.json"), JSON.stringify({ name, directory }), { flag: "wx" });
      const archiveDb = new ArchiveDatabase(url.toString(), { max: 1 });
      try {
        await checkpointReconciliation("before-recovery", archiveDb, url.toString(), directory, checkpoint);
      } finally {
        await archiveDb.close();
      }
      await save("verification", name, { upload, operation, checkpoint, directory });
    }
    await db.reconcileInactiveFileLocks();
    await db.withSql(async sql => {
      expect((await sql`SELECT status FROM upload_sessions WHERE id=${upload}`)[0]?.status).toBe("failed_retryable");
      expect((await sql`SELECT error_code FROM operation_journal WHERE id=${operation}`)[0]?.error_code).toBe("verification_interrupted");
      expect(await sql`SELECT 1 FROM operation_locks`).toHaveLength(0);
    });
  } finally {
    await database?.close();
    try {
      if (created && evidence === undefined) await admin.unsafe(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  }
}, 20_000);
