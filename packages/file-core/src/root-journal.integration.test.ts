import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Database, migrate, rollback, listMigrationPairs } from "@saturn/database";
import { expect, it } from "vitest";
import { PostgresRootJournal, type RootJournalCursor, type RootJournalEvent, type RootJournalSql } from "./root-journal.js";
import { ROOT_RESOURCE_ID } from "./models.js";
import { checkpointRootJournal } from "../../protection/src/storage-catalog-checkpoint.fixture.js";

const baseUrl = process.env.SYNC_JOURNAL_TEST_DATABASE_URL;
const auditRoot = process.env.SYNC_JOURNAL_TEST_AUDIT;
const custody = process.env.SATURN_ROOT_JOURNAL_EVIDENCE_DIR;
const publishedPrefix = process.env.SATURN_ROOT_JOURNAL_PUBLISHED_MIGRATIONS;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

it.skipIf(!baseUrl || !auditRoot)("qualifies inactive commit-ordered root journal on an isolated upgraded catalog", async () => {
  if (!baseUrl || !auditRoot) throw new Error("Explicit isolated journal test settings required");
  if ((custody === undefined) !== (publishedPrefix === undefined)) throw new Error("Journal custody and published prefix are required together");
  const runId = randomUUID().replaceAll("-", ""), name = "sync_journal_" + runId;
  const evidence = path.join(auditRoot, runId), legacyMigrations = path.join(evidence, "legacy-migrations"), qualifiedMigrations=path.join(evidence,"qualified-migrations");
  await fs.mkdir(legacyMigrations, { recursive: true });
  await fs.mkdir(qualifiedMigrations,{recursive:true});
  const current = fileURLToPath(new URL("../../database/migrations/", import.meta.url));
  for (const pair of await listMigrationPairs(current)) {
    const number = Number(pair.name.slice(0, 4));
    if (number > 48) continue;
    for (const direction of ["up", "down"] as const) {
      const basename = path.basename(pair[direction]);
      const from = number < 48 && publishedPrefix ? path.join(publishedPrefix, basename) : pair[direction];
      await fs.copyFile(from, path.join(qualifiedMigrations, basename));
      if (number < 48) await fs.copyFile(from, path.join(legacyMigrations, basename));
    }
  }
  expect(await listMigrationPairs(legacyMigrations)).toHaveLength(47);
  expect((await listMigrationPairs(qualifiedMigrations)).at(-1)?.name).toBe("0048_sync_root_journal");
  const migrations=qualifiedMigrations;
  const admin = new Database(baseUrl);
  const scopedUrl = new URL(baseUrl); scopedUrl.pathname = "/" + name; scopedUrl.searchParams.delete("options");
  const database = new Database(scopedUrl.toString(), { max: 12 });
  const journal = new PostgresRootJournal(database);
  const checks: string[] = [], samples: number[] = [];
  let created = false, passed = false;
  const checkpoint = async (phase: Parameters<typeof checkpointRootJournal>[0]) => {
    if (custody) await checkpointRootJournal(phase, database, scopedUrl.toString(), evidence, custody);
  };
  try {
    const root = randomUUID(), peer = randomUUID(), legacyOperation = randomUUID();
    if (custody) {
      await fs.mkdir(path.join(evidence, "runtime"));
      await fs.mkdir(path.join(evidence, "storage"));
      await fs.writeFile(path.join(custody, "ownership.json"), JSON.stringify({ name, directory: evidence }), { flag: "wx" });
      await fs.writeFile(path.join(evidence, "runtime", "fixture.json"), JSON.stringify({ name, root, peer, legacyOperation, metadataOnly: true }), { flag: "wx" });
    }
    await admin.withSql(sql => sql.unsafe(`CREATE DATABASE ${name}`));
    created = true;
    expect(await migrate(scopedUrl.toString(), legacyMigrations)).toBe(47);
    await database.withSql(async sql => {
      await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status) VALUES
        (${root},'folder',${ROOT_RESOURCE_ID},'journal-root','journal-root','active'),
        (${peer},'folder',${ROOT_RESOURCE_ID},'journal-peer','journal-peer','active')`;
      await sql`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,resource_id,payload)
        VALUES(${legacyOperation},'fixture','created',${legacyOperation},${root},${sql.json({ legacy: true })})`;
      await sql`INSERT INTO system_metadata(key,value) VALUES('journal-migration-fixture',${sql.json({ preserved: true,profile: "existing" })})`;
      for(const [kind,rootId] of [["windows_sync",root],["pluto",peer]] as const){
        await sql`INSERT INTO devices(id,name,token_hash,state,scope_ids,can_read,can_write,can_move,can_delete,created_at,updated_at,device_kind,sync_root_id,client_platform)
          VALUES(${randomUUID()},${kind},${hash(kind+runId)},'active',${[rootId]}::uuid[],true,true,false,false,now(),now(),${kind},${rootId},${kind==="windows_sync"?"windows":"linux"})`;
      }
    });
    const snapshot = () => database.withSql(async sql => {
      const resources = await sql`SELECT * FROM resources ORDER BY id`;
      const settings = await sql`SELECT * FROM system_metadata ORDER BY key`;
      const devices = await sql`SELECT * FROM devices ORDER BY id`;
      return JSON.stringify({ resources, settings, devices });
    });
    const before = await snapshot();
    await checkpoint("before-journal-up");
    expect(await migrate(scopedUrl.toString(), migrations)).toBe(1);
    expect(await snapshot()).toBe(before);
    expect(await database.withSql(sql => sql`SELECT * FROM sync_root_clock`)).toHaveLength(0);
    // Empty downgrade succeeds; upgrade is replayable without modifying legacy data.
    await checkpoint("before-journal-down");
    expect(await rollback(scopedUrl.toString(), migrations)).toBe("0048_sync_root_journal");
    await checkpoint("before-journal-reup");
    expect(await migrate(scopedUrl.toString(), migrations)).toBe(1);
    expect(await migrate(scopedUrl.toString(), migrations)).toBe(0);
    expect(await snapshot()).toBe(before);
    await database.withSql(async sql => {
      await sql`UPDATE operation_journal SET state='failed_retryable',error_code='legacy' WHERE id=${legacyOperation}`;
      await sql`DELETE FROM operation_journal WHERE id=${legacyOperation}`;
    });
    const maintenanceUpload=randomUUID();
    await database.withSql(async sql=>{
      await sql`INSERT INTO upload_sessions(id,idempotency_key,parent_id,filename,temp_path,target_path,expected_size,status,expires_at)
        VALUES(${maintenanceUpload},${maintenanceUpload},${root},'maintenance','temporary/maintenance','journal-root/maintenance',0,'verifying',now()+interval '1 hour')`;
      await sql`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,upload_id)
        VALUES(${maintenanceUpload},'upload','verifying',${maintenanceUpload},${maintenanceUpload})`;
    });
    const maintenance=new Database(scopedUrl.toString(),{maintenanceBarrier:true});
    try{
      await checkpoint("before-journal-cleanup");
      await maintenance.reconcileInactiveFileLocks();
      const state=await maintenance.withSql(sql=>sql`SELECT state,error_code FROM operation_journal WHERE id=${maintenanceUpload}`);
      expect(state[0]).toMatchObject({state:"failed_retryable",error_code:"verification_interrupted"});
      await maintenance.withExclusiveTransaction(async sql=>{
        // Exact initial legacy storage-switch cleanup statements, on unbound fixtures only.
        await sql`DELETE FROM operation_journal`;await sql`DELETE FROM upload_sessions`;
      });
    }finally{await maintenance.close();}
    expect(await snapshot()).toBe(before);
    checks.push("existing-populated-catalog-settings-windows-and-pluto-profiles-preserved;empty-down-up;real-legacy-maintenance;unbound-storage-switch-cleanup-statements");
    const rootClock = await journal.registerRoot(root), peerClock = await journal.registerRoot(peer);
    expect((await journal.registerRoot(root)).epoch).toBe(rootClock.epoch);

    const operation = async (witness = root) => {
      const operationId = randomUUID(), intentHash = hash(operationId);
      await database.withSql(sql => sql`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,resource_id)
        VALUES(${operationId},'metadata_fixture','created',${operationId},${witness})`);
      return { operationId, intentHash };
    };
    const bind = async (witness = root, selected = rootClock) => {
      const op = await operation(witness);
      await journal.bindOperation(selected.rootId, selected.epoch, op.operationId, op.intentHash); return op;
    };
    const event = (nodeId: string, name: string, parentId = root): RootJournalEvent => ({
      nodeId, kind: "upsert", description: { parentId, name, type: "folder", sizeBytes: "0", sha256: null, versionId: null },
      reason: "isolated-metadata-fixture", actor: { type: "test", id: runId },
    });
    const insert = async (sql: RootJournalSql, e: RootJournalEvent) => {
      await sql.query("INSERT INTO resources(id,type,parent_id,name,storage_path,status) VALUES($1,'folder',$2,$3,$4,'active')",
        [e.nodeId,e.description.parentId,e.description.name,`journal/${e.nodeId}`]);
    };
    const input = (op: { operationId: string; intentHash: string }, events: readonly RootJournalEvent[], selected = rootClock) => ({
      rootId: selected.rootId, epoch: selected.epoch, ...op, events, preparedBackend: "isolated_metadata_fixture" as const,
    });

    const jobs = await Promise.all(Array.from({ length: 100 }, async (_, i) => {
      const op = await bind(), e = event(randomUUID(), `node-${String(i)}`); return { op,e,i };
    }));
    const completed: string[] = [];
    const publishing = Promise.all(jobs.map(async ({ op,e,i }) => {
      await delay((99-i)%13);
      const start = performance.now();
      const receipt = await journal.commit(input(op,[e]), async sql => {
        await sql.query("SELECT pg_sleep($1)", [(i%7)/1000]);
        await insert(sql,e); return { nodeId: e.nodeId };
      });
      samples.push(performance.now()-start); completed.push(receipt.lastSeq); return receipt;
    }));
    const readers = Promise.all(Array.from({length:3},async()=>{
      let next: RootJournalCursor={rootId:root,epoch:rootClock.epoch,afterSeq:"0"};
      const seen:string[]=[];
      for(let attempts=0;attempts<2000 && seen.length<100;attempts++){
        const page=await journal.read({...next,limit:7});
        expect(BigInt(page.next.afterSeq)).toBeLessThanOrEqual(BigInt(page.clock.publishedSeq));
        seen.push(...page.events.map(e=>e.seq));next=page.next;
        if(!page.hasMore)await delay(2);
      }
      return seen;
    }));
    const publications=await publishing;
    const readSequences = await readers;
    for(const sequence of readSequences)expect(sequence).toEqual(Array.from({length:100},(_,i)=>String(i+1)));
    expect(new Set(publications.map(r => r.lastSeq)).size).toBe(100);
    expect(publications.map(r => BigInt(r.lastSeq)).sort((a,b) => a<b ? -1 : a>b ? 1 : 0)).toEqual(Array.from({ length: 100 }, (_,i) => BigInt(i+1)));
    const observed: string[] = [];
    let cursor: RootJournalCursor = { rootId: root, epoch: rootClock.epoch, afterSeq: "0" };
    for (;;) {
      const page = await journal.read({ ...cursor, limit: 7, throughSeq: "100" });
      expect(page.clock.publishedSeq).toBe("100");
      observed.push(...page.events.map(e => e.seq)); cursor = page.next;
      if (!page.hasMore) break;
    }
    expect(observed).toEqual(Array.from({ length: 100 }, (_,i) => String(i+1)));
    expect((await journal.read(cursor)).events).toEqual([]);
    checks.push("100-concurrent-delayed-publications;3-simultaneous-readers-never-miss-prefix;no-gap;bounded-keyset-inclusive-pages;empty-page-no-backend");

    const replayJob = jobs[0]; if (!replayJob) throw new Error("Missing replay fixture");
    let replayInvocations = 0;
    const replay = await journal.commit(input(replayJob.op,[replayJob.e]), async () => { replayInvocations++; return {}; });
    expect(replay.replayed).toBe(true); expect(replayInvocations).toBe(0);
    await expect(journal.commit(input({ ...replayJob.op, intentHash: hash("different") },[replayJob.e]), async () => ({}))).rejects.toMatchObject({ code: "operation_reused" });
    await expect(journal.bindOperation(peer,peerClock.epoch,replayJob.op.operationId,replayJob.op.intentHash)).rejects.toMatchObject({ code: "operation_reused" });
    const foreign = await operation(peer);
    await expect(journal.bindOperation(root,rootClock.epoch,foreign.operationId,foreign.intentHash)).rejects.toMatchObject({ code: "operation_reused" });
    await expect(journal.bindOperation(peer,peerClock.epoch,replayJob.op.operationId,replayJob.op.intentHash)).rejects.toMatchObject({ code: "operation_reused" });
    checks.push("lost-response-replay-zero-second-effect;intent-reuse;foreign-global-operation-id-before-after-binding");

    const failed = await bind(), failedEvent = event(randomUUID(),"rolled-back");
    await checkpoint("before-journal-fault");
    await expect(journal.commit(input(failed,[failedEvent]), async sql => { await insert(sql,failedEvent); throw new Error("intentional callback rollback"); })).rejects.toThrow("intentional callback rollback");
    expect(await database.withSql(sql => sql`SELECT id FROM resources WHERE id=${failedEvent.nodeId}`)).toHaveLength(0);
    expect((await journal.read(cursor)).clock.publishedSeq).toBe("100");
    expect((await journal.commit(input(failed,[failedEvent]), async sql => { await insert(sql,failedEvent); return { repaired: true }; })).firstSeq).toBe("101");
    const mismatch = await bind(), wrongEvent = event(randomUUID(),"intended-name");
    await expect(journal.commit(input(mismatch,[wrongEvent]), async sql => {
      await insert(sql,{ ...wrongEvent, description: { ...wrongEvent.description, name: "wrong-name" } }); return {};
    })).rejects.toMatchObject({ code: "projection_mismatch" });
    expect(await database.withSql(sql => sql`SELECT id FROM resources WHERE id=${wrongEvent.nodeId}`)).toHaveLength(0);
    const eventFailure = await bind(), eventFailureNode = event(randomUUID(),"event-rollback");
    await checkpoint("before-journal-trigger");
    await database.withSql(sql => sql.unsafe(`CREATE FUNCTION reject_fixture_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected event failure'; END $$; CREATE TRIGGER reject_fixture_event BEFORE INSERT ON sync_root_changes FOR EACH ROW EXECUTE FUNCTION reject_fixture_event()`));
    try {
      await expect(journal.commit(input(eventFailure,[eventFailureNode]), async sql => { await insert(sql,eventFailureNode); return {}; })).rejects.toThrow("injected event failure");
    } finally { await database.withSql(sql => sql.unsafe("DROP TRIGGER reject_fixture_event ON sync_root_changes; DROP FUNCTION reject_fixture_event()")); }
    expect(await database.withSql(sql => sql`SELECT id FROM resources WHERE id=${eventFailureNode.nodeId}`)).toHaveLength(0);
    expect((await journal.read({ ...cursor, afterSeq: "101" })).clock.publishedSeq).toBe("101");
    checks.push("callback-rollback-no-gap;catalog-description-mismatch-rollback;event-failure-catalog-and-receipt-atomic");

    const timedOut = await bind(), timeoutEvent = event(randomUUID(),"must-not-commit");
    let captured: RootJournalSql | undefined;
    await checkpoint("before-journal-timeout");
    await expect(journal.commit(input(timedOut,[timeoutEvent]), async sql => {
      captured = sql; await insert(sql,timeoutEvent); await delay(1150);
      await sql.query("UPDATE resources SET name='late' WHERE id=$1",[timeoutEvent.nodeId]); return {};
    })).rejects.toMatchObject({ code: "callback_expired" });
    if (!captured) throw new Error("Missing timeout boundary");
    await expect(captured.query("SELECT 1")).rejects.toMatchObject({ code: "callback_expired" });
    await delay(200);
    expect(await database.withSql(sql => sql`SELECT id FROM resources WHERE id=${timeoutEvent.nodeId}`)).toHaveLength(0);
    expect((await journal.read({ ...cursor, afterSeq: "101" })).clock.publishedSeq).toBe("101");
    checks.push("callback-timeout-rollback;late-sql-cannot-commit");
    const sqlTimeout=await bind(),sqlTimeoutEvent=event(randomUUID(),"sql-timeout-rollback"),sqlTimeoutStarted=performance.now();
    await expect(journal.commit(input(sqlTimeout,[sqlTimeoutEvent]),async sql=>{
      await insert(sql,sqlTimeoutEvent);await sql.query("SELECT pg_sleep(5)");return{};
    })).rejects.toMatchObject({code:"callback_expired"});
    expect(performance.now()-sqlTimeoutStarted).toBeLessThan(4000);
    expect(await database.withSql(sql=>sql`SELECT id FROM resources WHERE id=${sqlTimeoutEvent.nodeId}`)).toHaveLength(0);
    checks.push("running-sql-statement-timeout-bounds-expired-callback-and-rolls-back");

    const blocked = await bind(), blockedEvent = event(randomUUID(),"root-blocked"), peerOp = await bind(peer,peerClock), peerEvent = event(randomUUID(),"peer-independent",peer);
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const blockedCommit = journal.commit(input(blocked,[blockedEvent]), async sql => {
      enteredResolve?.(); await sql.query("SELECT pg_sleep(0.35)"); await insert(sql,blockedEvent); return {};
    });
    await entered;
    let blockedDone = false; void blockedCommit.then(() => { blockedDone = true; });
    const peerReceipt = await journal.commit(input(peerOp,[peerEvent],peerClock), async sql => { await insert(sql,peerEvent); return {}; });
    expect(peerReceipt.firstSeq).toBe("1"); expect(blockedDone).toBe(false); await blockedCommit;
    checks.push("other-roots-independent-while-one-clock-locked");

    const scopeFailure=await bind();
    await expect(journal.commit(input(scopeFailure,[peerEvent]),async()=>({}))).rejects.toMatchObject({code:"projection_mismatch"});
    const inactiveParent=randomUUID();
    await database.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status) VALUES(${inactiveParent},'folder',${root},'inactive','journal/inactive','trashed')`);
    const inactiveChild=event(randomUUID(),"inactive-child",inactiveParent);
    await expect(journal.commit(input(scopeFailure,[inactiveChild]),async sql=>{await insert(sql,inactiveChild);return{};})).rejects.toMatchObject({code:"projection_mismatch"});
    const cycleA=randomUUID(),cycleB=randomUUID(),cyclic=[event(cycleA,"cycle-a",cycleB),event(cycleB,"cycle-b",cycleA)];
    await expect(journal.commit(input(scopeFailure,cyclic),async sql=>{for(const e of cyclic)await insert(sql,e);return{};})).rejects.toMatchObject({code:"projection_mismatch"});
    expect(await database.withSql(sql=>sql`SELECT id FROM resources WHERE id IN(${inactiveChild.nodeId},${cycleA},${cycleB})`)).toHaveLength(0);
    await expect(journal.commit(input(scopeFailure,[inactiveChild]),async sql=>{await sql.query("SELECT 1; COMMIT");return{};})).rejects.toMatchObject({code:"invalid_input"});
    checks.push("foreign-root-inactive-parent-cycle-projection-rejected-atomic;callback-transaction-control-rejected");

    const tombstoneOp = await bind(), tombstone = { ...failedEvent, kind: "tombstone" as const };
    const removed = await journal.commit(input(tombstoneOp,[tombstone]), async sql => {
      await sql.query("UPDATE resources SET status='trashed' WHERE id=$1",[failedEvent.nodeId]); return { removed: failedEvent.nodeId };
    });
    expect(removed.lastSeq).toBe("103");
    const tombstonePage = await journal.read({ rootId: root,epoch: rootClock.epoch,afterSeq: "102" });
    expect(tombstonePage.events[0]?.kind).toBe("tombstone");
    checks.push("tombstone-before-membership-and-after-absence-proof");

    const batchOp = await bind(), batch = [event(randomUUID(),"batch-a"),event(randomUUID(),"batch-b")];
    const batchReceipt = await journal.commit(input(batchOp,batch), async sql => { for (const e of batch) await insert(sql,e); return {}; });
    expect(batchReceipt.firstSeq).toBe("104"); expect(batchReceipt.lastSeq).toBe("105");
    await expect(journal.read({ rootId: root,epoch: rootClock.epoch,afterSeq: "106" })).rejects.toMatchObject({ code: "cursor_ahead" });
    await expect(journal.read({ rootId: root,epoch: rootClock.epoch,afterSeq: "0",throughSeq: "106" })).rejects.toMatchObject({ code: "cursor_ahead" });
    await expect(journal.read({ rootId: root,epoch: rootClock.epoch,afterSeq: "2",throughSeq: "1" })).rejects.toMatchObject({ code: "cursor_ahead" });
    await expect(journal.read({ rootId: root,epoch: rootClock.epoch,afterSeq: "9007199254740993" })).rejects.toMatchObject({ code: "cursor_ahead" });
    await expect(journal.read({ rootId: root,epoch: rootClock.epoch,afterSeq: "0",limit: 501 })).rejects.toMatchObject({ code: "invalid_input" });
    await journal.advanceRetentionFloor(root,rootClock.epoch,"50");
    await expect(journal.read({ rootId: root,epoch: rootClock.epoch,afterSeq: "49" })).rejects.toMatchObject({ code: "cursor_expired" });
    expect((await journal.read({ rootId: root,epoch: rootClock.epoch,afterSeq: "50",limit: 1 })).events[0]?.seq).toBe("51");
    await expect(journal.advanceRetentionFloor(root,rootClock.epoch,"49")).rejects.toMatchObject({ code: "cursor_ahead" });
    await expect(journal.advanceRetentionFloor(root,rootClock.epoch,"106")).rejects.toMatchObject({ code: "cursor_ahead" });
    checks.push("multi-event-contiguous-range;inclusive-prefix;pinned-high-water;beyond-prefix-reject;decimal-bigint;retention-floor");

    await checkpoint("before-journal-refusal");
    await expect(database.withSql(sql => sql`UPDATE operation_journal SET state='failed_retryable' WHERE id=${replayJob.op.operationId}`)).rejects.toThrow("immutable");
    await expect(database.withSql(sql => sql`DELETE FROM operation_journal WHERE id=${replayJob.op.operationId}`)).rejects.toThrow("cannot be deleted");
    await expect(database.withSql(sql => sql`DELETE FROM operation_journal WHERE id=${timedOut.operationId}`)).rejects.toThrow("cannot be deleted");
    await expect(rollback(scopedUrl.toString(), migrations)).rejects.toThrow("Cannot rollback sync root journal");
    expect((await journal.read({ rootId: root,epoch: rootClock.epoch,afterSeq: "50" })).clock.publishedSeq).toBe("105");
    checks.push("durable-pending-binding-and-final-receipt-protected-from-legacy-delete;published-down-guard");
    const rotated = await journal.rotateEpoch(root,rootClock.epoch);
    expect(rotated.epoch).not.toBe(rootClock.epoch); expect(rotated.publishedSeq).toBe("0");
    await expect(journal.read({ rootId: root,epoch: rootClock.epoch,afterSeq: "105" })).rejects.toMatchObject({ code: "epoch_mismatch" });
    await expect(journal.commit(input(replayJob.op,[replayJob.e]), async () => ({}))).rejects.toMatchObject({ code: "epoch_mismatch" });
    await expect(journal.commit(input(replayJob.op,[replayJob.e],rotated), async () => ({}))).rejects.toMatchObject({ code: "operation_reused" });
    expect(await database.withSql(sql => sql`SELECT seq FROM sync_root_changes WHERE root_id=${root}`)).toHaveLength(105);
    expect((await journal.read({ rootId: root,epoch: rotated.epoch,afterSeq: "0" })).events).toHaveLength(0);
    const maximumOp=await bind(root,rotated),maximumEvents=Array.from({length:500},(_,i)=>event(randomUUID(),"bounded-"+String(i)));
    await expect(journal.commit(input(maximumOp,[...maximumEvents,event(randomUUID(),"501st")],rotated),async()=>({}))).rejects.toMatchObject({code:"invalid_input"});
    const duplicate=maximumEvents[0];if(!duplicate)throw new Error("Missing maximum fixture");
    await expect(journal.commit(input(maximumOp,[duplicate,duplicate],rotated),async()=>({}))).rejects.toMatchObject({code:"invalid_input"});
    await expect(journal.commit(input(maximumOp,[{...duplicate,description:{...duplicate.description,name:"x".repeat(1021)}}],rotated),async()=>({}))).rejects.toMatchObject({code:"invalid_input"});
    await expect(journal.commit(input(maximumOp,[duplicate],rotated),async()=>({oversized:"x".repeat(65536)}))).rejects.toMatchObject({code:"invalid_input"});
    const maximumReceipt=await journal.commit(input(maximumOp,maximumEvents,rotated),async sql=>{
      const rows=maximumEvents.map(e=>({id:e.nodeId,parent_id:e.description.parentId,name:e.description.name,path:"journal/"+e.nodeId}));
      await sql.query("INSERT INTO resources(id,type,parent_id,name,storage_path,status) SELECT id,'folder',parent_id,name,path,'active' FROM jsonb_to_recordset($1::text::jsonb) AS rows(id uuid,parent_id uuid,name text,path text)",[JSON.stringify(rows)]);
      return{items:500};
    });
    expect(maximumReceipt.firstSeq).toBe("1");expect(maximumReceipt.lastSeq).toBe("500");
    const maximumPage=await journal.read({rootId:root,epoch:rotated.epoch,afterSeq:"0",limit:500});
    expect(maximumPage.events).toHaveLength(500);expect(Buffer.byteLength(JSON.stringify(maximumPage))).toBeLessThanOrEqual(4*1024*1024);
    checks.push("500-item-set-based-range-and-bounded-page;501-duplicate-name-receipt-byte-limits");
    const bigintRoot=randomUUID();
    await database.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status) VALUES(${bigintRoot},'folder',${ROOT_RESOURCE_ID},'bigint','journal-bigint','active')`);
    const bigintClock=await journal.registerRoot(bigintRoot);
    await database.withSql(sql=>sql`UPDATE sync_root_clock SET published_seq=9007199254740992,retained_after_seq=9007199254740992 WHERE root_id=${bigintRoot}`);
    const bigintOp=await bind(bigintRoot,bigintClock),bigintEvent=event(randomUUID(),"bigint-child",bigintRoot);
    expect((await journal.commit(input(bigintOp,[bigintEvent],bigintClock),async sql=>{await insert(sql,bigintEvent);return{};})).firstSeq).toBe("9007199254740993");
    expect((await journal.read({rootId:bigintRoot,epoch:bigintClock.epoch,afterSeq:"9007199254740992"})).events[0]?.seq).toBe("9007199254740993");
    await database.withSql(sql=>sql`UPDATE sync_root_clock SET published_seq=9223372036854775807,retained_after_seq=9223372036854775807 WHERE root_id=${bigintRoot}`);
    const exhaustedOp=await bind(bigintRoot,bigintClock);
    await expect(journal.commit(input(exhaustedOp,[event(randomUUID(),"exhausted",bigintRoot)],bigintClock),async()=>({}))).rejects.toMatchObject({code:"counter_exhausted"});
    checks.push("actual-counter-and-event-beyond-js-safe-integer-exact-decimal");
    await database.withSql(sql => sql`UPDATE resources SET status='trashed' WHERE id=${root}`);
    await expect(journal.read({ rootId: root,epoch: rotated.epoch,afterSeq: "0" })).rejects.toMatchObject({ code: "root_unavailable" });
    await expect(journal.registerRoot(root)).rejects.toMatchObject({ code: "root_unavailable" });
    checks.push("epoch-rotation-preserves-events-receipts;old-operation-never-reexecutes;softdeleted-root-unavailable");
    passed = true;
    await fs.writeFile(path.join(evidence,"results.json"),JSON.stringify({ passed,runId,name,checks,concurrentTransactions: 100,
      roots:{root,peer,bigintRoot,previousEpoch:rootClock.epoch,rotatedEpoch:rotated.epoch,peerEpoch:peerClock.epoch,bigintEpoch:bigintClock.epoch},
      originals:{legacyOperation,maintenanceUpload,replay:replayJob.op.operationId,timedOut:timedOut.operationId,maximum:maximumOp.operationId,bigint:bigintOp.operationId,
        eventFailure: eventFailure.operationId, failedEvent:failedEvent.nodeId, eventFailureNode:eventFailureNode.nodeId, timeoutEvent:timeoutEvent.nodeId, sqlTimeoutEvent:sqlTimeoutEvent.nodeId},
      readerSequencesSha256:readSequences.map(sequence=>hash(JSON.stringify(sequence))),
      events: 607,metadataFixtureOnly: true,completionResponseSeqOrder: completed,samplesMs: samples,
      capabilityActivation: false,recoveryExport: "PENDING" },null,2));
  } finally {
    let dropped = false;
    try {
      await database.close();
      if (created && !custody) {
        await admin.withSql(sql => sql.unsafe(`DROP DATABASE ${name}`));
        dropped = true;
      }
    } finally {
      await admin.close();
      await fs.writeFile(path.join(evidence,"cleanup.json"),JSON.stringify({ name,created,dropped,retained:created&&!dropped,passed }));
    }
  }
},120000);
