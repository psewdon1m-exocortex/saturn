import {vi} from 'vitest';
import {fixtureForwardMethod} from './test-values.fixture.js';
import {Database} from '@saturn/database';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {CatalogUploadTransferExecutor} from '../../../packages/file-core/src/catalog-upload-transfer.js';
import {CatalogRootAdmission} from '../../../packages/file-core/src/catalog-root-admission.js';
import {DurableBackendExecutor} from '../../../packages/storage/src/durable-backend-executor.js';
import {BackendPayloadStore} from '../../../packages/storage/src/backend-payload-store.js';
import {RuntimeStorageManager} from '../../../packages/storage/src/runtime-storage.manager.js';
import {BackendCheckedStorage} from '../../../packages/sync/src/guarded-runtime.js';

/** Opt-in diagnostics in an isolated receiver process. Contains timings only,
 * never authority credentials, file paths, content or production switches. */
export function smallFilePhaseTrace(){
  const origin=performance.now(),events:{stage:string;start:number;end:number;members:number;failed:boolean}[]=[];
  const totals:Record<string,{calls:number;elapsedMs:number;maximumMs:number;failures:number}>={};
  function wrap<A extends unknown[],R>(stage:string,action:(...args:A)=>Promise<R>){
    return async function(this:unknown,...args:A):Promise<R>{
      const start=performance.now();let failed=false;
      try{return await action.apply(this,args);}catch(error){failed=true;throw error;}
      finally{
        const end=performance.now(),elapsed=end-start,t=totals[stage]??={calls:0,elapsedMs:0,maximumMs:0,failures:0};
        t.calls++;t.elapsedMs+=elapsed;t.maximumMs=Math.max(t.maximumMs,elapsed);t.failures+=failed?1:0;
        if(events.length<16384)events.push({stage,start:start-origin,end:end-origin,members:Array.isArray(args[0])?args[0].length:1,failed});
      }
    };
  }
  const c=CatalogUploadDatabaseCoordinator.prototype,b=DurableBackendExecutor.prototype,r=CatalogRootAdmission.prototype;
  // Capture all originals before spyOn replaces prototype members.
  const prepare=fixtureForwardMethod(c,'prepareSmall'),chunk=fixtureForwardMethod(c,'startReplayableChunk'),claim=fixtureForwardMethod(c,'verifyAndClaimGroup'),commit=fixtureForwardMethod(c,'commit');
  const job=fixtureForwardMethod(c,'prepareExecutionJob'),set=fixtureForwardMethod(c,'commitSet');
  vi.spyOn(c,'prepareExecutionJob').mockImplementation(wrap('catalog.executionJob',job));
  vi.spyOn(c,'commitSet').mockImplementation(wrap('catalog.commitSet',set));
  const write=fixtureForwardMethod(b,'writeOnce'),rename=fixtureForwardMethod(b,'renameGroupOnce'),run=fixtureForwardMethod(r,'run'),sqlRun=fixtureForwardMethod(r,'runSqlBatch');
  vi.spyOn(c,'prepareSmall').mockImplementation(wrap('catalog.prepareSmall',prepare));
  vi.spyOn(c,'startReplayableChunk').mockImplementation(wrap('catalog.startChunk',chunk));
  vi.spyOn(c,'verifyAndClaimGroup').mockImplementation(wrap('catalog.claimGroup',claim));
  vi.spyOn(c,'commit').mockImplementation(wrap('catalog.commit',commit));
  vi.spyOn(b,'writeOnce').mockImplementation(wrap('backend.writeOnce',write));
  vi.spyOn(b,'renameGroupOnce').mockImplementation(wrap('backend.renameGroup',rename));
  vi.spyOn(r,'run').mockImplementation(wrap('root.run',run));
  vi.spyOn(r,'runSqlBatch').mockImplementation(wrap('root.sqlBatch',sqlRun));
  const t=CatalogUploadTransferExecutor.prototype;
  const complete=fixtureForwardMethod(t,'completeSmall');vi.spyOn(t,'completeSmall').mockImplementation(wrap('transfer.completeSmall',complete));
  const materialize=fixtureForwardMethod(t,'materializeJob');vi.spyOn(t,'materializeJob').mockImplementation(wrap('transfer.materializeJob',materialize));
  const d=Database.prototype;
  const batch=fixtureForwardMethod(d,'catalogUploadBatch');vi.spyOn(d,'catalogUploadBatch').mockImplementation(wrap('sql.catalogBatch',batch));
  const backend=fixtureForwardMethod(d,'backendCommand');vi.spyOn(d,'backendCommand').mockImplementation(function(this:Database,...args:Parameters<Database['backendCommand']>){
    return wrap('sql.backend.'+args[0],backend).apply(this,args);
  });
  const verified=fixtureForwardMethod(b,'writeVerifiedOnce');vi.spyOn(b,'writeVerifiedOnce').mockImplementation(wrap('backend.writeVerified',verified));
  const refresh=fixtureForwardMethod(RuntimeStorageManager.prototype,'refresh');
  vi.spyOn(RuntimeStorageManager.prototype,'refresh').mockImplementation(wrap('storage.refresh',refresh));
  const checked=fixtureForwardMethod(BackendCheckedStorage.prototype,'writeVerifiedOnce');
  vi.spyOn(BackendCheckedStorage.prototype,'writeVerifiedOnce').mockImplementation(wrap('storage.checkedWrite',checked));
  const payload=BackendPayloadStore.prototype,put=fixtureForwardMethod(payload,'put'),read=fixtureForwardMethod(payload,'read'),remove=fixtureForwardMethod(payload,'remove');
  vi.spyOn(payload,'put').mockImplementation(wrap('payload.put',put));
  vi.spyOn(payload,'read').mockImplementation(wrap('payload.read',read));
  vi.spyOn(payload,'remove').mockImplementation(wrap('payload.remove',remove));
  return {totals,events};
}
