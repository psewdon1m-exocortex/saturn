import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {activeFixture,uid,migrations} from './stage3-chat-a.fixture.js';
const migration=Number(process.env.SMALL_FILE_SHAPE_MIGRATION??99);

it('reuses only exact protected immutable shape and still checks current authorization',async()=>{
  const f=await activeFixture('smallfile-stored-shape','windows',migration);
  try{
    const inputs=Array.from({length:16},(_,n)=>f.uploadInput('shape-'+String(n),Buffer.alloc(8192,71)));
    const plan={manifest:{...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'shape-v1',items:inputs.map(input=>({operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:uid(),parent_id:input.intent.parentId,name:input.intent.name,size_bytes:input.intent.sizeBytes,sha256:input.intent.sha256,expected:{kind:'absent'}}))},inputs};
    const wire=JSON.stringify(plan),credential=f.issuer.deviceCredential(f.proof,f.rootId);
    const call=(command:string,bytes=wire)=>f.writer.catalogUploadBatch(command as 'accept-job',credential,{planBytes:bytes});
    const accepted=await call('accept-job') as {items:{originalUploadId:string}[]};
    const known=await f.admin.withSql(sql=>sql<{plan:boolean;intent:boolean}[]>`SELECT sync_small_batch_known_shape(${wire}::text::jsonb) AS plan,catalog_upload_known_intent(${fixtureValue(accepted.items[0]).originalUploadId},${JSON.stringify(fixtureValue(inputs[0]).intent)}::text::jsonb) AS intent`);
    expect(known[0]).toEqual({plan:true,intent:true});
    await f.admin.transaction(async sql=>{
      expect(fixtureValue((await sql<{tracking:string}[]>`SELECT current_setting('track_functions') AS tracking`)[0]).tracking).toBe('pl');
      await sql`SELECT sync_small_batch_known_shape(${wire}::text::jsonb),catalog_upload_known_intent(${fixtureValue(accepted.items[0]).originalUploadId},${JSON.stringify(fixtureValue(inputs[0]).intent)}::text::jsonb)`;
      const counters=await sql<{calls:string}[]>`SELECT coalesce(sum(calls),0)::text AS calls FROM pg_stat_xact_user_functions WHERE funcname IN ('sync_small_batch_plan_valid','catalog_upload_intent_valid')`;
      expect(fixtureValue(counters[0]).calls).toBe('0');
      // Prove observation works on this very session after the zero-call
      // assertion. Pending function counters can survive a rapid COMMIT.
      await sql`SELECT sync_small_batch_plan_valid('null'::jsonb),catalog_upload_intent_valid('null'::jsonb)`;
      expect(await sql<{funcname:string;calls:string}[]>`SELECT funcname,calls::text FROM pg_stat_xact_user_functions WHERE funcname IN ('sync_small_batch_plan_valid','catalog_upload_intent_valid') ORDER BY funcname`).toEqual([
        {funcname:'catalog_upload_intent_valid',calls:'1'},
        {funcname:'sync_small_batch_plan_valid',calls:'1'},
      ]);
    });
    // Both helpers have exactly the old pure predicate's result for arbitrary
    // changed input. Stored shape never stands in for current authority.
    const variants:unknown[]=[null,{},[],{...plan,extra:true}];
    for(const key of Object.keys(plan.manifest))variants.push({...plan,manifest:{...plan.manifest,[key]:null}});
    variants.push({...plan,inputs:inputs.map((v,n)=>n===15?{...v,intent:{...v.intent,name:'../invalid'}}:v)});
    for(const value of variants){const json=JSON.stringify(value);const rows=await f.admin.withSql(sql=>sql<{same:boolean}[]>`SELECT sync_small_batch_known_shape(${json}::text::jsonb) IS NOT DISTINCT FROM sync_small_batch_plan_valid(${json}::text::jsonb) AS same`);expect(fixtureValue(rows[0]).same).toBe(true);}
    for(const key of Object.keys(fixtureValue(inputs[0]).intent)){
      const json=JSON.stringify({...fixtureValue(inputs[0]).intent,[key]:null});
      const rows=await f.admin.withSql(sql=>sql<{same:boolean}[]>`SELECT catalog_upload_known_intent(${fixtureValue(accepted.items[0]).originalUploadId},${json}::text::jsonb) IS NOT DISTINCT FROM catalog_upload_intent_valid(${json}::text::jsonb) AS same`);expect(fixtureValue(rows[0]).same).toBe(true);
    }
    await expect(call('accept-job',wire+' ')).rejects.toThrow('operation_reused');
    const bad=structuredClone(plan);bad.inputs[15]={...fixtureValue(bad.inputs[15]),intent:{...fixtureValue(bad.inputs[15]).intent,name:'../invalid'}};
    await expect(call('accept-job',JSON.stringify(bad))).rejects.toThrow('invalid_input');
    await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE sync_root_id=${f.rootId}`);
    await expect(call('start-job')).rejects.toThrow('authorization_changed');
    await expect(call('status-job')).rejects.toThrow('authorization_changed');
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
    await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=true WHERE sync_root_id=${f.rootId}`);
    // No new stored format: restore full validators while accepted originals
    // and their immutable manifests remain readable.
    await f.executor.close();
    const down=await fs.readFile(path.join(migrations,'0099_stored_immutable_shape.down.sql'),'utf8');
    await f.admin.transaction(sql=>sql.unsafe(down));
    const replay=await call('status-job') as typeof accepted;
    expect(replay.items.map(x=>x.originalUploadId)).toEqual(accepted.items.map(x=>x.originalUploadId));
  }finally{await f.close();}
},60000);
