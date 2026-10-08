import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, it } from "vitest";
import { Database, migrate } from "./index.js";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.PIPELINE_TEST_DATABASE_URL;

it.skipIf(!baseUrl)("keeps short queries and transactions responsive while all filesystem admission slots are busy", async () => {
  if (!baseUrl) throw new Error("PIPELINE_TEST_DATABASE_URL is required");
  const name = `audit_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
  let database: Database | undefined;
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending: Promise<unknown>[] = [];
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
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
    const queries = Promise.all([db.ping(), db.transaction(async sql => { await sql`SELECT 1`; })]);
    pending.push(queries);
    await Promise.race([queries, delay(1000).then(() => { throw new Error("Short queries waited for unrelated filesystem transfers"); })]);
  } finally {
    release();
    await Promise.allSettled(pending);
    await database?.close();
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 15_000);

it.skipIf(!baseUrl).each(["query", "transaction"] as const)("lets an admitted writer finish while %s traffic waits behind exclusive maintenance", async (kind) => {
  if (!baseUrl) throw new Error("PIPELINE_TEST_DATABASE_URL is required");
  const name = `audit_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
  let db: Database | undefined;
  let probe: ReturnType<typeof postgres> | undefined;
  const pending: Promise<unknown>[] = [];
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(baseUrl); url.pathname = `/${name}`;
    db = new Database(url.toString(), { max: 1, maintenanceBarrier: true });
    probe = postgres(url.toString(), { max: 1 });
    const inspect = probe;
    let release: () => void = () => undefined;
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
  } finally {
    // Cancel blocked admission on a failing reproduction, freeing the query
    // pool so the older writer and exclusive operation can drain before close.
    await admin.unsafe(`SELECT pg_cancel_backend(a.pid) FROM pg_stat_activity a JOIN pg_locks l ON a.pid=l.pid WHERE a.datname='${name}' AND l.locktype='advisory' AND l.mode='ShareLock' AND NOT l.granted`);
    await Promise.allSettled(pending);
    await db?.close().catch(() => undefined);
    await probe?.end().catch(() => undefined);
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
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
      const roots = await sql<{ id: string }[]>`SELECT id FROM resources WHERE storage_path='sync'`;
      const root = roots[0]?.id;
      if (root === undefined) throw new Error("Sync root was not migrated");
      await sql`INSERT INTO upload_sessions (id,idempotency_key,parent_id,filename,temp_path,target_path,expected_size,received_size,status,expires_at)
        VALUES (${upload},${upload},${root},'interrupted.txt',${`_system/temp/${upload}`},'sync/interrupted.txt',1,1,'verifying',now()+interval '1 hour')`;
      await sql`INSERT INTO operation_journal (id,operation_type,state,idempotency_key,upload_id)
        VALUES (${operation},'upload','verifying',${operation},${upload})`;
      await sql`INSERT INTO operation_locks (lock_key,operation_id,expires_at) VALUES ('interrupted',${operation},now()+interval '1 hour')`;
    });
    await db.reconcileInactiveFileLocks();
    await db.withSql(async sql => {
      expect((await sql`SELECT status FROM upload_sessions WHERE id=${upload}`)[0]?.status).toBe("failed_retryable");
      expect((await sql`SELECT error_code FROM operation_journal WHERE id=${operation}`)[0]?.error_code).toBe("verification_interrupted");
      expect(await sql`SELECT 1 FROM operation_locks`).toHaveLength(0);
    });
  } finally {
    await database?.close();
    if (created && /^audit_[a-f0-9]{32}$/.test(name)) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 20_000);
