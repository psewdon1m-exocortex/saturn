import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {activeFixture,migrations,uid} from './stage3-chat-a.fixture.js';

it('uses the guarded registration proof once and checks existing siblings once in the same transaction',async()=>{
  const f=await activeFixture('smallfile-registration-proof','windows',104);
  const plan=(prefix:string)=>{
    const inputs=Array.from({length:16},(_,n)=>f.uploadInput(prefix+String(n),Buffer.alloc(8192,71)));
    return {manifest:{...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'1',items:inputs.map(input=>({operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:uid(),parent_id:f.rootId,name:input.intent.name,size_bytes:input.intent.sizeBytes,sha256:input.intent.sha256,expected:{kind:'absent'}}))},inputs};
  };
  const credential=f.issuer.deviceCredential(f.proof,f.rootId),first=plan('first-'),second=plan('second-');
  try{
    await f.writer.transaction(async sql=>{
      expect(fixtureValue((await sql<{tracking:string}[]>`SELECT current_setting('track_functions') AS tracking`)[0]).tracking).toBe('pl');
      await sql`SELECT catalog_upload_command('execute-job','{}'::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify({planBytes:JSON.stringify(first)})}::text::jsonb)`;
      expect(fixtureValue((await sql<{calls:string}[]>`SELECT coalesce(sum(calls),0)::text AS calls FROM pg_stat_xact_user_functions WHERE funcname='sync_small_batch_plan_valid'`)[0]).calls).toBe('2');
    });
    await f.writer.transaction(async sql=>{
      expect(fixtureValue((await sql<{tracking:string}[]>`SELECT current_setting('track_functions') AS tracking`)[0]).tracking).toBe('pl');
      await sql`SELECT catalog_upload_command('execute-job','{}'::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify({planBytes:JSON.stringify(second)})}::text::jsonb)`;
      expect(fixtureValue((await sql<{calls:string}[]>`SELECT coalesce(sum(calls),0)::text AS calls FROM pg_stat_xact_user_functions WHERE funcname='catalog_upload_private_read'`)[0]).calls).toBe('16');
    });
    const before=await f.admin.withSql(sql=>sql`SELECT * FROM sync_small_batch_budget`);
    const bad=plan('bad-');bad.inputs[15]={...fixtureValue(bad.inputs[15]),intent:{...fixtureValue(bad.inputs[15]).intent,name:'../invalid'}};
    await expect(f.writer.catalogUploadBatch('execute-job',credential,{planBytes:JSON.stringify(bad)})).rejects.toThrow('invalid_input');
    await expect(f.writer.catalogUploadBatch('execute-job',credential,{planBytes:JSON.stringify(plan('third-'))})).rejects.toThrow('admission_full');
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM sync_small_batch_budget`)).toEqual(before);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_small_batches`)).toHaveLength(2);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM operation_journal WHERE upload_execution_job IS NOT NULL`)).toHaveLength(32);
    await f.executor.close();await f.admin.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0104_job_registration_proof.down.sql'),'utf8')));
    expect((await f.writer.catalogUploadBatch('status-job',credential,{planBytes:JSON.stringify(first)}) as {items:unknown[]}).items).toHaveLength(16);
  }finally{await f.close();}
},60000);
