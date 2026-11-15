import { fixtureValue } from './test-values.fixture.js';
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { activeFixture, evidence, migrations, sha, uid } from "./stage3-chat-a.fixture.js";
import { parseSyncMutationInput } from "../../../packages/contracts/src/sync-extensions.js";

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE)("bounds pending clone admission independently of completed journal history and preserves clone receipts through down/up", async () => {
  const f = await activeFixture("clone-admission-index", "windows", 69);
  try {
    await f.admin.withSql(sql => sql.unsafe(`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,payload)
      SELECT gen_random_uuid(),'fixture-unrelated-history','created','index-history-'||n,'{}'::jsonb FROM generate_series(1,30000)n`));
    await f.admin.withSql(sql => sql.unsafe("ANALYZE operation_journal"));
    const plan = await f.admin.withSql(sql => sql.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT (j.namespace_intent->'input'->'source'->>'sizeBytes')::bigint
      FROM operation_journal j WHERE j.sync_root_id='${f.rootId}'
      AND j.namespace_state<>'PUBLISHED' AND j.namespace_intent->'input'->>'kind'='clone-content'`));
    await evidence("clone-admission-index", "plan", plan);
    expect(JSON.stringify(plan)).toContain("operation_pending_clone_admission");
    expect(JSON.stringify(plan)).not.toContain('"Node Type":"Seq Scan"');

    const bytes = Buffer.from("clone-admission-original");
    await f.upload(f.uploadInput("source", bytes), bytes);
    const lookup = await f.mutations.lookup(f.rootId, f.binding.epoch, f.binding.bindingVersion, String(bytes.length), sha(bytes), f.proof);
    expect(lookup.reference).not.toBeNull();
    const input = parseSyncMutationInput({ schema: "saturn.namespace-mutation.v1", kind: "clone-content", operationId: uid(), idempotencyKey: uid(), rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, expected: { kind: "absent" }, parentId: f.rootId, name: "clone", source: lookup.reference });
    const receipt = await f.mutations.execute(input, f.namespace, f.proof);
    expect(receipt.state).toBe("PUBLISHED");
    const retained = () => f.admin.withSql(sql => sql`SELECT id,idempotency_key,sync_result,upload_receipt,namespace_state,namespace_intent FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`);
    const original = await retained();
    const functions = () => f.admin.withSql(sql => sql`SELECT p.oid::regprocedure::text AS identity,md5(p.prosrc) AS source FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid`);
    const signatures = await functions();
    const down = await fs.readFile(path.join(migrations,"0069_clone_admission_index.down.sql"),"utf8");
    const up = await fs.readFile(path.join(migrations,"0069_clone_admission_index.up.sql"),"utf8");
    await f.admin.transaction(sql => sql.unsafe(down));
    expect(await retained()).toEqual(original);
    expect(await f.mutations.status(input,f.namespace,f.proof)).toEqual(receipt);
    await f.admin.transaction(sql => sql.unsafe(up));
    expect(await retained()).toEqual(original);
    expect(await functions()).toEqual(signatures);
    expect(await f.mutations.execute(input,f.namespace,f.proof)).toEqual(receipt);
    const target = fixtureValue((await f.admin.withSql(sql => sql<{storage_path:string}[]>`SELECT storage_path FROM resources WHERE parent_id=${f.rootId} AND name='clone'`))[0]);
    const chunks:Buffer[]=[];for await(const chunk of await f.raw.openRead(target.storage_path))chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    await evidence("clone-admission-index","result",{status:"PASS",historyRows:30000,indexedPlan:true,actualCloneReadback:true,downUpOriginalReceipts:true,writerFunctionsUnchanged:true,sameKeyReplay:true});
  } finally { await f.close(); }
},120000);
