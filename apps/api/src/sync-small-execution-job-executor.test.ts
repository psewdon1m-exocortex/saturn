import {createHash,randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import type {SyncRootBinding} from '../../../packages/contracts/src/sync-protocol.js';
import type {SmallBatchItem,SmallBatchManifest} from '../../../packages/contracts/src/sync-small-batch.js';
import type {CatalogFolderAuthority} from '../../../packages/file-core/src/catalog-folder-authority.js';
import type {PreparedCatalogExecutionJob,PreparedCatalogUpload} from '../../../packages/file-core/src/catalog-upload-database.js';
import type {CatalogUploadPrepareInput} from '../../../packages/file-core/src/catalog-upload-intent.js';
import type {FileService} from '../../../packages/file-core/src/file.service.js';
import {SmallExecutionJobExecutor} from './sync-small-execution-job-executor.js';

// Projection doubles cover the HTTP executor's ordering/error contract only.
// PostgreSQL authority, physical storage and native continuation remain separate gates.
function fixture(){
  const rootId=randomUUID(),epoch=randomUUID(),version=randomUUID(),operation=randomUUID(),deviceId=randomUUID();
  const bytes=Buffer.from('original bytes'),sha256=createHash('sha256').update(bytes).digest('hex');
  const binding:SyncRootBinding={protocol:'neptune-sync/1',descriptor_schema:'saturn.current-namespace.v1',server_identity:'executor-fixture',root_id:rootId,server_epoch:epoch,policy_version:'1',binding_version:version};
  const input:CatalogUploadPrepareInput={epoch,bindingVersion:version,backendIdentity:'fixture-backend',intent:{
    schema:'saturn.upload-intent.v2',deviceKind:'windows_sync',deviceId,rootId,requestPath:'root/file.bin',idempotencyKey:operation,parentId:rootId,name:'file.bin',targetId:null,
    sizeBytes:String(bytes.length),sha256,ifMatch:null,ifNoneMatch:'*',requireAbsent:true,expectedVersionId:null,condition:{kind:'absent'},parentTopology:[{nodeId:rootId,parentId:null,name:'root'}],
  }};
  const item:SmallBatchItem={operation_id:operation,source_generation:'1',source_identity:'sealed-original',parent_id:rootId,name:'file.bin',size_bytes:String(bytes.length),sha256,expected:{kind:'absent'}};
  const manifest:SmallBatchManifest={...binding,schema:'saturn.small-file-batch.v1',batch_id:randomUUID(),rules_version:'fixture-v1',items:[item]};
  const member:PreparedCatalogUpload={input,claimToken:null,execution:{schema:'saturn.catalog-upload-execution.v1',epoch,bindingVersion:version,guardRevision:randomUUID(),backendIdentity:'fixture-backend',
    nodeId:randomUUID(),versionId:randomUUID(),tempPath:'fixture/temp',targetPath:'fixture/final',archivePath:null,before:null,pathTopology:[]},
    status:{session:{uploadId:operation,operationId:operation,rootId,intentHash:sha256,expectedSizeBytes:String(bytes.length),receivedSizeBytes:'0',phase:'transport',transferPending:false},replayed:false}};
  const job:PreparedCatalogExecutionJob={plan:{manifest,inputs:[input]},manifestSha256:sha256,replayed:false,executionAdmitted:true,members:[member]};
  const prepare=vi.fn(async()=>job),materialize=vi.fn(async()=>{throw new Error('Unexpected physical dispatch');});
  const files={prepareSmallExecutionJob:prepare,materializeSmallExecutionJob:materialize} as unknown as FileService;
  const executor=new SmallExecutionJobExecutor(files,binding,{} as CatalogFolderAuthority);
  return{executor,prepare,materialize,job,item,member,bytes};
}

it('returns metadata for the exact original without starting physical publication',async()=>{
  const f=fixture(),result=await f.executor.metadata(Buffer.from('{}'),'status');
  expect(result.items).toEqual([{operation_id:f.item.operation_id,source_generation:f.item.source_generation,source_identity:f.item.source_identity,state:'PENDING',status:f.member.status}]);
  expect(f.materialize).not.toHaveBeenCalled();
});

it('rejects an inconsistent stored member projection before returning partial metadata',async()=>{
  const f=fixture();f.prepare.mockResolvedValueOnce({...f.job,plan:{...f.job.plan,manifest:{...f.job.plan.manifest,items:[]}}});
  await expect(f.executor.metadata(Buffer.from('{}'),'status')).rejects.toMatchObject({code:'projection_mismatch'});
  expect(f.materialize).not.toHaveBeenCalled();
});

it('preserves a fatal authority code from an asynchronous non-Error rejection and joins its input',async()=>{
  const f=fixture(),failure={code:'authorization_changed'},boundary='executor-fixture-boundary';let closed=false;
  f.materialize.mockRejectedValueOnce(failure);
  const metadata=Buffer.from(JSON.stringify(f.job.plan));
  const wire=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(metadata.length)}\r\n\r\n`),metadata,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${f.item.operation_id}>\r\nContent-Length: ${String(f.bytes.length)}\r\n\r\n`),f.bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  async function* body(){try{yield wire;}finally{closed=true;}}
  await expect(f.executor.receive(body(),`multipart/related; boundary=${boundary}`)).rejects.toMatchObject({code:'authorization_changed',cause:failure});
  expect(closed).toBe(true);expect(f.materialize).toHaveBeenCalledOnce();
});
