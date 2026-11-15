import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {activeFixture,migrations,uid} from './stage3-chat-a.fixture.js';

it('uses current-transaction creation proof only for new members and preserves the private-read oracle',async()=>{
  const f=await activeFixture('smallfile-job-proof-scope','windows',102);
  try{
    const inputs=Array.from({length:16},(_,n)=>f.uploadInput('proof-scope-'+String(n),Buffer.alloc(8192,51)));
    const plan={manifest:{...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'1',items:inputs.map(input=>({operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:uid(),parent_id:f.rootId,name:input.intent.name,size_bytes:input.intent.sizeBytes,sha256:input.intent.sha256,expected:{kind:'absent'}}))},inputs};
    const payload=JSON.stringify({planBytes:JSON.stringify(plan)}),credential=JSON.stringify(f.issuer.deviceCredential(f.proof,f.rootId));
    const result=await f.writer.transaction(async sql=>{
      const created=fixtureValue((await sql<{value:{items:{originalUploadId:string}[]}}[]>`SELECT catalog_upload_command('execute-job','{}'::jsonb,${credential}::text::jsonb,${payload}::text::jsonb) AS value`)[0]).value;
      expect(fixtureValue((await sql<{calls:string}[]>`SELECT coalesce(sum(calls),0)::text AS calls FROM pg_stat_xact_user_functions WHERE funcname='catalog_upload_private_read'`)[0]).calls).toBe('0');
      return created;
    });
    const source=fixtureValue((await f.admin.withSql(sql=>sql<{definition:string}[]>`SELECT definition FROM sync_extension_function_backup WHERE revision=102 AND identity='catalog_upload_private_read(operation_journal)'`))[0]).definition;
    await f.admin.withSql(sql=>sql.unsafe(source.replace('FUNCTION public.catalog_upload_private_read(', 'FUNCTION public.test_previous_private_read(')));
    const row=fixtureValue((await f.admin.withSql(sql=>sql<{value:Record<string,unknown>}[]>`SELECT to_jsonb(j) AS value FROM operation_journal j WHERE id=${fixtureValue(result.items[0]).originalUploadId}`))[0]).value;
    // Compare every changed row column, including NULLs, with the predecessor.
    for(const value of [row,...Object.keys(row).map(key=>({...row,[key]:null}))]){
      const json=JSON.stringify(value);
      const same=await f.admin.withSql(sql=>sql<{same:boolean}[]>`SELECT catalog_upload_private_read(j) IS NOT DISTINCT FROM test_previous_private_read(j) AS same FROM jsonb_populate_record(NULL::operation_journal,${json}::text::jsonb) j`);
      expect(fixtureValue(same[0]).same).toBe(true);
    }
    // Current upload state is still read, even for exact protected journal rows.
    await expect(f.admin.transaction(async sql=>{
      await sql`ALTER TABLE upload_sessions DISABLE TRIGGER USER`;
      await sql`UPDATE upload_sessions SET expected_size=expected_size+1 WHERE id=${fixtureValue(result.items[0]).originalUploadId}`;
      expect((await sql`SELECT catalog_upload_private_read(j) AS valid FROM operation_journal j WHERE id=${fixtureValue(result.items[0]).originalUploadId}`)[0]).toEqual({valid:false});
      throw Error('rollback fixture corruption');
    })).rejects.toThrow('rollback fixture corruption');
    await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE sync_root_id=${f.rootId}`);
    await expect(f.writer.catalogUploadBatch('execute-job',JSON.parse(credential),JSON.parse(payload))).rejects.toThrow('authorization_changed');
    await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=true WHERE sync_root_id=${f.rootId}`);
    await f.executor.close();await f.admin.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0102_job_transaction_proof.down.sql'),'utf8')));
    expect((await f.writer.catalogUploadBatch('status-job',JSON.parse(credential),JSON.parse(payload)) as typeof result).items.map(i=>i.originalUploadId)).toEqual(result.items.map(i=>i.originalUploadId));
  }finally{await f.close();}
},60000);
