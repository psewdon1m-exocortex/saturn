import { fixtureValue } from './test-values.fixture.js';
import {expect,it} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {migrate,rollback} from '../../../packages/database/src/migrate.js';
import {activeFixture,databaseFixture,evidence,migrations,sha,uid} from './stage3-chat-a.fixture.js';
import type {SyncStreamPrepare} from '../../../packages/contracts/src/sync-stream.js';

// These cases qualify the 0071–0074 transition and its exact rollback, not
// every future migration. The current-head upgrade has its own cutoff suite.
async function scaleMigrations(directory:string){
  const selected=path.join(directory,'scale-through-0074');await fs.mkdir(selected);
  for(const file of await fs.readdir(migrations))if(/^\d{4}_.*\.(up|down)\.sql$/.test(file)&&Number(file.slice(0,4))<=74)
    await fs.copyFile(path.join(migrations,file),path.join(selected,file));
  return selected;
}

it('0071-0074 migrate and roll back a drained database with exact function restoration',async()=>{
  const f=await databaseFixture('scale-migration-empty',70);
  const selected=await scaleMigrations(f.directory);
  const signatures=['sync_backend_command(text,jsonb,jsonb)','catalog_upload_command(text,jsonb,jsonb,jsonb)','sync_stream_command(text,jsonb,jsonb,jsonb)','sync_policy_admission()','catalog_guard_active_shape_v1(jsonb)'];
  const definitions=()=>f.db.withSql(sql=>sql<{identity:string;definition:string}[]>`SELECT x AS identity,pg_get_functiondef(x::regprocedure) AS definition FROM unnest(${signatures}::text[]) x ORDER BY x`);
  try{
    const before=await definitions();expect(await migrate(f.url,selected)).toBe(4);
    expect((await definitions()).filter((r,n)=>r.definition!==fixtureValue(before[n]).definition)).toHaveLength(5);
    for(const revision of ['0074','0073','0072','0071'])expect(await rollback(f.url,selected)).toMatch(new RegExp('^'+revision));
    expect(await definitions()).toEqual(before);
    expect(await migrate(f.url,selected)).toBe(4);
    await evidence('scale-migration-empty','result',{status:'PASS',upgrade:4,rollback:4,reapply:4,exactFunctionRestoration:true});
  }finally{await f.close();}
},60000);

it('retained v1 stream survives migration and v2 blocks unsafe rollback',async()=>{
  const f=await activeFixture('scale-migration-retained','windows',70);
  const selected=await scaleMigrations(f.directory);
  try{
    const bytes=Buffer.from('original before scale migration');
    const prepared=f.uploadInput('retained-v1',bytes);
    const original:SyncStreamPrepare={schema:'saturn.stream-upload.v1',operationId:uid(),source:{generation:'1',witnessSha256:sha('source')},chunkBytes:4194304,prepare:{...prepared,intent:{...prepared.intent,sha256:null}}};
    expect((await f.streams.prepare(original,f.proof)).state).toBe('RECEIVING');
    const before=await f.admin.withSql(sql=>sql`SELECT input,node_id,version_id FROM sync_stream_uploads WHERE operation_id=${original.operationId}`);
    expect(await migrate(f.url,selected)).toBe(4);
    expect(await f.admin.withSql(sql=>sql`SELECT input,node_id,version_id FROM sync_stream_uploads WHERE operation_id=${original.operationId}`)).toEqual(before);
    const chunk={index:0,offset:'0',length:String(bytes.length),sha256:sha(bytes)};
    expect((await f.streams.append(original,chunk,bytes,f.proof)).receivedSizeBytes).toBe(String(bytes.length));
    expect((await f.streams.seal(original,{sha256:sha(bytes),sourceGeneration:'1',sourceWitnessSha256:original.source.witnessSha256},f.proof)).state).toBe('PUBLISHED');
    await expect(f.streams.prepare({...original,operationId:uid(),prepare:{...original.prepare,intent:{...original.prepare.intent,sizeBytes:'1073741825',idempotencyKey:uid(),name:'old-v1-too-large'}}},f.proof)).rejects.toThrow();
    await f.admin.withSql(sql=>sql`UPDATE sync_root_policy SET features=features||'"scale-transfer-v2"'::jsonb WHERE root_id=${f.rootId}`);
    const next={...original,schema:'saturn.stream-upload.v2' as const,operationId:uid(),prepare:{...original.prepare,intent:{...original.prepare.intent,idempotencyKey:uid(),name:'retained-v2'}}};
    expect((await f.streams.prepare(next,f.proof)).state).toBe('RECEIVING');
    await expect(rollback(f.url,selected)).rejects.toThrow('retained v2 state prevents rollback');
    expect((await f.streams.status(original,f.proof)).schema).toBe('saturn.stream-upload-status.v1');
    await evidence('scale-migration-retained','result',{status:'PASS',originalUnchanged:true,v1Published:true,v1LimitRetained:true,v2Admitted:true,unsafeRollbackRefused:true});
  }finally{await f.close();}
},60000);
