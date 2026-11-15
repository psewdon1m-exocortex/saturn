import type {SyncRootBinding} from '../../../packages/contracts/src/sync-protocol.js';
import type {CatalogFolderAuthority} from '../../../packages/file-core/src/catalog-folder-authority.js';
import type {PreparedCatalogExecutionJob} from '../../../packages/file-core/src/catalog-upload-database.js';
import type {FileService} from '../../../packages/file-core/src/file.service.js';
import {SmallBatchPlanError} from '../../../packages/file-core/src/small-batch-plan.js';
import {receiveSmallBatch} from './sync-small-batch-stream.js';
import {outcome,failed,type SmallBatchOutcome,type SmallBatchItemOutcome} from './sync-small-batch-executor.js';

/** Exact accepted plan plus individually checked file parts. Materialization
 * owns at most four body buffers; publication owns metadata, not those permits.
 * FileService keeps the common four physical workers and per-root FIFO. */
export class SmallExecutionJobExecutor {
  constructor(private readonly files:FileService,private readonly binding:SyncRootBinding,private readonly proof:CatalogFolderAuthority){}
  #response(job:PreparedCatalogExecutionJob,items:readonly SmallBatchItemOutcome[]):SmallBatchOutcome{
    return {...this.binding,schema:'saturn.small-file-batch-result.v1',batch_id:job.plan.manifest.batch_id,items};
  }
  async metadata(bytes:Uint8Array,command:'prepare'|'status'):Promise<SmallBatchOutcome>{
    const job=await this.files.prepareSmallExecutionJob(bytes,this.binding,this.proof,command);
    return this.#response(job,job.members.map((p,n)=>{
      const item=job.plan.manifest.items[n];if(!item)throw new SmallBatchPlanError('projection_mismatch');
      return outcome(item,p.status);
    }));
  }
  async receive(body:AsyncIterable<Uint8Array>,contentType:string,signal?:AbortSignal,singleRequest=false):Promise<SmallBatchOutcome>{
    let job:PreparedCatalogExecutionJob|undefined,failure:Error|undefined;
    const results=new Map<string,SmallBatchItemOutcome>(),materializing=new Set<Promise<void>>(),completions:Promise<void>[]=[];
    const check=()=>{signal?.throwIfAborted();if(failure)throw failure;};
    try{
      const manifest=await receiveSmallBatch(body,contentType,this.binding,{
        plan:async bytes=>{check();job=await this.files.prepareSmallExecutionJob(bytes,this.binding,this.proof,singleRequest?'execute':'data');return job.plan.manifest;},
        manifest:()=>Promise.resolve(),
        part:item=>{
          check();if(!job)throw new SmallBatchPlanError('projection_mismatch');
          const member=job.members.find(p=>p.input.intent.idempotencyKey===item.operation_id);
          if(!member)throw new SmallBatchPlanError('projection_mismatch');
          let bytes:Buffer|undefined=member.status.result?undefined:Buffer.alloc(Number(item.size_bytes)),offset=0;
          return Promise.resolve({
            write:chunk=>{check();bytes?.set(chunk,offset);offset+=chunk.length;return Promise.resolve();},
            interrupted:()=>{bytes=undefined;return Promise.resolve();},
            received:async()=>{
              check();if(offset!==Number(item.size_bytes))throw new SmallBatchPlanError('projection_mismatch');
              if(member.status.result){results.set(item.operation_id,outcome(item,member.status));return;}
              if(!bytes)throw new SmallBatchPlanError('projection_mismatch');const sealed=bytes;bytes=undefined;
              const recordError=(error:unknown)=>{try{results.set(item.operation_id,failed(item,error,signal));}catch(fatal){
                failure??=fatal instanceof Error?fatal:Object.assign(new Error('Batch publication failed',{cause:fatal}),
                  fatal&&typeof fatal==='object'&&'code'in fatal&&typeof fatal.code==='string'?{code:fatal.code}:{});
              }};
              const materialized=this.files.materializeSmallExecutionJob(member,this.proof,sealed).then(({completion})=>{
                completions.push(completion.then(done=>{results.set(item.operation_id,outcome(item,done.status));},recordError));
              },recordError).finally(()=>{materializing.delete(materialized);});
              materializing.add(materialized);
              if(materializing.size>=4)await Promise.race(materializing);
              check();
            },
          });
        },
      },signal);
      await Promise.all(materializing);await Promise.all(completions);check();
      if(!job)throw new SmallBatchPlanError('projection_mismatch');
      return this.#response(job,manifest.items.map(item=>{const result=results.get(item.operation_id);if(!result)throw new SmallBatchPlanError('projection_mismatch');return result;}));
    }finally{
      // Includes jobs accepted before malformed trailing bytes or cancellation.
      await Promise.all(materializing);await Promise.all(completions);
    }
  }
}
