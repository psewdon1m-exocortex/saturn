import { fixtureValue } from './test-values.fixture.js';
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { activeFixture, evidence, migrations, sha, uid } from "./stage3-chat-a.fixture.js";
import { parseSyncDeletePlan, parseSyncMutationInput } from "../../../packages/contracts/src/sync-extensions.js";

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE)("bounds resource namespace guards independently of journal history and preserves upload/move/delete/restore across index down/up", async () => {
  const f = await activeFixture("namespace-guard-index", "windows", 70);
  try {
    await f.admin.withSql(sql => sql.unsafe(`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,payload)
      SELECT gen_random_uuid(),'fixture-unrelated-history','created','guard-history-'||n,'{}'::jsonb FROM generate_series(1,30000)n`));
    await f.admin.withSql(sql => sql.unsafe("ANALYZE operation_journal"));
    // Same predicate as renew_resource_metadata_version, including exact-node and descendant paths.
    const plan = await f.admin.withSql(sql => sql.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT 1 FROM catalog_guard_roots g JOIN operation_journal j ON j.sync_root_id=g.root_id
      WHERE g.writer_owner='${f.roles.writerOwner}' AND g.writer_login='${f.roles.writerLogin}'
        AND j.namespace_state='PHYSICAL_PENDING'
        AND j.namespace_intent->'input'->>'kind' IN ('move','restore','quarantine-delete')
        AND ('${f.rootId}'=j.namespace_execution->>'nodeId' OR starts_with('root/child',(j.namespace_execution->>'sourcePath')||'/'))`));
    await evidence("namespace-guard-index", "plan", plan);
    expect(JSON.stringify(plan)).toContain("operation_pending_namespace_guard");
    const journalScans = (value: unknown): unknown[] => {
      if (Array.isArray(value)) return value.flatMap(journalScans);
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      if (row["Node Type"] === "Seq Scan" && row["Relation Name"] === "operation_journal") return [row];
      return Object.values(row).flatMap(journalScans);
    };
    expect(journalScans(plan)).toEqual([]);

    const bytes = Buffer.from("immutable upload and namespace guard regression");
    const input = f.uploadInput("original.txt", bytes);
    const uploaded = await f.upload(input, bytes);
    expect(uploaded.status.result?.status).toBe("PUBLISHED");
    const node = fixtureValue((await f.admin.withSql(sql => sql<{id:string;metadata_version:string;current_version_id:string}[]>`
      SELECT id,metadata_version,current_version_id FROM resources WHERE parent_id=${f.rootId} AND name='original.txt'`))[0]);
    const base = { schema: "saturn.namespace-mutation.v1", rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion };
    const make = (fields: object) => parseSyncMutationInput({ ...base, operationId: uid(), idempotencyKey: uid(), ...fields });
    const move = make({ kind: "move", expected: { kind: "version", node_id: node.id, version: node.metadata_version }, parentId: f.rootId, name: "renamed.txt" });
    const moved = await f.mutations.execute(move, f.namespace, f.proof);
    expect(moved.state).toBe("PUBLISHED");
    await expect(f.mutations.execute(parseSyncMutationInput({ ...move, operationId: uid(), idempotencyKey: uid(), name: "stale.txt" }), f.namespace, f.proof)).rejects.toMatchObject({ code: "precondition_failed" });
    const description = fixtureValue(moved.result).description;
    const deletionPlan = parseSyncDeletePlan({ schema: "saturn.delete-plan.v1", planId: uid(), planDigest: sha("reviewed-index-regression"), items: [{ nodeId: node.id, version: description.version }] });
    const deletion = make({ kind: "quarantine-delete", expected: { kind: "version", node_id: node.id, version: description.version }, planId: deletionPlan.planId, planDigest: deletionPlan.planDigest });
    await expect(f.mutations.execute(deletion, f.namespace, f.proof)).rejects.toMatchObject({ code: "approval_stale" });
    await f.mutations.approveDeletePlan(f.rootId, f.binding.epoch, f.binding.bindingVersion, deletionPlan, f.namespace, f.proof);
    const deleted = await f.mutations.execute(deletion, f.namespace, f.proof);
    expect(fixtureValue(deleted.result).tombstone).toBe(true);
    const restore = make({ kind: "restore", expected: { kind: "version", node_id: node.id, version: fixtureValue(deleted.result).description.version }, parentId: f.rootId, name: "restored.txt", deletedOperationId: deletion.operationId });
    const restored = await f.mutations.execute(restore, f.namespace, f.proof);
    expect(restored.state).toBe("PUBLISHED");
    const target = fixtureValue((await f.admin.withSql(sql => sql<{storage_path:string;sync_availability:string;current_version_id:string}[]>`
      SELECT storage_path,sync_availability,current_version_id FROM resources WHERE id=${node.id}`))[0]);
    expect(target.sync_availability).toBe("AVAILABLE");
    expect(target.current_version_id).toBe(node.current_version_id);
    const chunks: Buffer[]=[]; for await (const chunk of await f.raw.openRead(target.storage_path)) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    const retained = () => f.admin.withSql(sql => sql`SELECT * FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`);
    const originals = await retained();
    const functions = () => f.admin.withSql(sql => sql`SELECT p.oid::regprocedure::text AS identity,md5(p.prosrc) AS source FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid`);
    const signatures = await functions();
    for (const direction of ["down", "up"] as const) {
      await f.admin.transaction(async sql => sql.unsafe(await fs.readFile(path.join(migrations, `0070_namespace_guard_index.${direction}.sql`), "utf8")));
      expect(await retained()).toEqual(originals);
      expect(await functions()).toEqual(signatures);
      expect(await f.mutations.execute(move, f.namespace, f.proof)).toEqual(moved);
      expect(await f.mutations.execute(deletion, f.namespace, f.proof)).toEqual(deleted);
      expect(await f.mutations.execute(restore, f.namespace, f.proof)).toEqual(restored);
      expect((await f.files.prepareCatalogUpload(input, f.proof)).status.result).toEqual(uploaded.status.result);
    }
    await evidence("namespace-guard-index", "result", {status:"PASS",historyRows:30000,indexedPlan:true,actualUploadReadback:true,moveDeleteRestore:true,staleCasRefused:true,unapprovedDeleteRefused:true,downUpOriginals:true,writerFunctionsUnchanged:true,sameKeyReplay:true});
  } finally { await f.close(); }
},120000);
