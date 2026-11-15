import {durableUploadTrees,type DurableTreeJob,type DurableUploadTreeStore} from "./upload-tree-durable.js";
import {plannedJobSources} from "./upload-tree-plan.js";
import {prepareUploadTreeJob} from "./upload-tree-batch.js";
import {uploadTreeTransport,type UploadTreeTransport,type UploadTreeAdvance} from "./upload-tree-transport.js";
import {UploadTreeStreamSource,type UploadTreeStreamWireJob} from "./upload-tree-stream.js";
import {uploadTreeStreamTransport,parseUploadTreeStreamCapability,type UploadTreeStreamTransport,type UploadTreeStreamAdvance} from "./upload-tree-stream-transport.js";
import {uploadTreeStreamHttp} from "./upload-tree-stream-http.js";
import {errorValue} from "./error-value.js";

export interface UploadTreeQueueState {
 readonly treeId:string;readonly totalJobs:number;readonly completedJobs:number;readonly cancelledJobs:number;
 readonly activeJobs:number;readonly completedFiles:number;readonly completedDirectories:number;
 readonly activeItemPaths:readonly string[];
 readonly activeStreamBytes?:readonly {readonly relativePath:string;readonly confirmedBytes:number;readonly totalBytes:number}[];
}
type Store=Pick<DurableUploadTreeStore,"loadPlan"|"loadJob"|"reserveJob"|"savePrepared">;
type Transport=Pick<UploadTreeTransport,"advance">;
type StreamStore=Store&Pick<DurableUploadTreeStore,"savePreparedStream">;
interface QueueOptions {
 readonly signal?:AbortSignal;readonly onState?:(state:UploadTreeQueueState)=>void;
 readonly store?:Store;readonly transport?:Transport;readonly prepare?:typeof prepareUploadTreeJob;
}
interface StreamQueueOptions {
 readonly transport:Pick<UploadTreeStreamTransport,"advance">;
 readonly prepare:typeof UploadTreeStreamSource.prepare;readonly reselect:typeof UploadTreeStreamSource.reselect;
 readonly capability:typeof uploadTreeStreamHttp.capability;
 readonly store:StreamStore;
 readonly wait:(milliseconds:number,signal:AbortSignal)=>Promise<void>;
}
function waitForStreamPoll(milliseconds:number,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();return new Promise((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);reject(errorValue(signal.reason));};
  const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},milliseconds);
  signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
 });
}
/** Mixed trees use the same two lanes and parent receipt barrier. Unsent
 * streams require capability before ANY tree effect; saved sent originals
 * can still be inspected when current capability is unavailable. */
export function runUploadTree(treeId:string,sources:ReadonlyMap<string,File>,options:Omit<QueueOptions,"store">&{
 readonly store?:StreamStore;readonly streamTransport?:StreamQueueOptions["transport"];
 readonly prepareStream?:StreamQueueOptions["prepare"];readonly reselectStream?:StreamQueueOptions["reselect"];
 readonly streamCapability?:StreamQueueOptions["capability"];
 readonly waitForStreamPoll?:StreamQueueOptions["wait"];
}={}):Promise<UploadTreeQueueState>{
 const store=options.store??durableUploadTrees;
 return runQueue(treeId,sources,{...options,store},{store,transport:options.streamTransport??uploadTreeStreamTransport,prepare:options.prepareStream??((...args)=>UploadTreeStreamSource.prepare(...args)),reselect:options.reselectStream??((...args)=>UploadTreeStreamSource.reselect(...args)),capability:options.streamCapability??((scope,signal)=>uploadTreeStreamHttp.capability(scope,signal)),wait:options.waitForStreamPoll??waitForStreamPoll});
}
/** Compatibility entry point for consumers explicitly limited to small jobs. */
export function runSmallUploadTree(treeId:string,sources:ReadonlyMap<string,File>,options:QueueOptions={}):Promise<UploadTreeQueueState>{return runQueue(treeId,sources,options);}
/** Two bounded preparation/send lanes across a persisted parent DAG. Never
 * launches descendants before their parent job's durable publication receipt.
 * A failure/abort joins all started work; source File handles are metadata-only
 * until the strict journal grants a slot. Existing originals need no handles. */
async function runQueue(treeId:string,sources:ReadonlyMap<string,File>,options:QueueOptions,stream?:StreamQueueOptions):Promise<UploadTreeQueueState>{
 const store=options.store??durableUploadTrees,transport=options.transport??uploadTreeTransport,prepare=options.prepare??prepareUploadTreeJob;
 const local=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,local.signal]):local.signal;
 // Abort callbacks may change this between synchronous admissions as well as awaits.
 const aborted=()=>signal.aborted;
 const streaming=()=>{if(stream===undefined)throw Error("This tree requires the streaming tree upload path; no jobs were sent");return stream;};
 signal.throwIfAborted();const {plan,scope}=await store.loadPlan(treeId);signal.throwIfAborted();
 if(!stream&&plan.jobs.some(job=>job.kind!=="small"))throw Error("This tree requires the streaming tree upload path; no jobs were sent");
 const complete=new Set<string>(),cancelled=new Set<string>(),remaining=new Set(plan.jobs.map(job=>job.jobId));
 const active=new Map<string,Promise<void>>(),activePaths=new Map<string,readonly string[]>(),phases=new Map<string,DurableTreeJob["phase"]>();
 const activeBytes=new Map<string,{relativePath:string;confirmedBytes:number;totalBytes:number}>();
 let completedFiles=0,completedDirectories=0;
 const failure:{present:boolean;value:unknown}={present:false,value:undefined};
 const snapshot=():UploadTreeQueueState=>({treeId,totalJobs:plan.jobs.length,completedJobs:complete.size,cancelledJobs:cancelled.size,activeJobs:active.size,completedFiles,completedDirectories,activeItemPaths:[...activePaths.values()].flat(),activeStreamBytes:[...activeBytes.values()]});
 const stop=(error:unknown)=>{if(!failure.present){failure.present=true;failure.value=error;}local.abort(error);};
 const report=()=>{try{options.onState?.(snapshot());}catch(error){stop(error);}};
 const count=(record:DurableTreeJob)=>{
  for(const item of record.status?.items??[])if(item.state==="published"){if(item.kind==="file")completedFiles++;else completedDirectories++;}
  if(record.phase==="completed")complete.add(record.jobId);else if(record.phase==="cancelled")cancelled.add(record.jobId);
 };
 // Restore terminal identity state once. At most two nonterminal payloads can
 // exist per scope; do not retain every encoded body in the queue's metadata.
 for(const job of plan.jobs){signal.throwIfAborted();const record=await store.loadJob(treeId,job.jobId);phases.set(job.jobId,record.phase);if(["completed","cancelled"].includes(record.phase)){remaining.delete(job.jobId);count(record);}}
 const phase=(jobId:string)=>{const value=phases.get(jobId);if(value===undefined)throw Error("Original tree job phase is unavailable");return value;};
 const unsentStreams=plan.jobs.filter(job=>job.kind==="stream"&&["planned","preparing","ready"].includes(phase(job.jobId)));
 let streamPreflightDone=false;
 const preflight=async()=>{
  if(streamPreflightDone)return;
  if(stream&&unsentStreams.length){
   const limits=parseUploadTreeStreamCapability(await stream.capability(scope,signal));signal.throwIfAborted();
   if(!limits)throw Error("Streaming tree upload is unavailable; no new jobs were sent");
   const ids=new Set(unsentStreams.flatMap(job=>job.itemIds));if(plan.items.some(item=>ids.has(item.itemId)&&item.kind==="file"&&item.sizeBytes>limits.maximumFileBytes))throw Error("A tree stream exceeds the current file limit; no new jobs were sent");
  }
  streamPreflightDone=true;
 };
 report();
 const launch=(jobId:string)=>{
  remaining.delete(jobId);
  const operation=Promise.resolve().then(async()=>{
   try{
    signal.throwIfAborted();let record=await store.loadJob(treeId,jobId);
    activePaths.set(jobId,record.items.map(item=>item.relativePath));report();signal.throwIfAborted();
    let source:UploadTreeStreamSource|undefined;
    if(["planned","preparing"].includes(record.phase)){
     const inputs=plannedJobSources(plan,jobId,sources); // Validate handles before consuming a new slot.
     record=await store.reserveJob(treeId,jobId);signal.throwIfAborted();
     if(record.phase==="preparing"){
      if(record.job.kind==="stream"){
       source=await streaming().prepare(jobId,inputs,{signal});signal.throwIfAborted();record=await streaming().store.savePreparedStream(treeId,jobId,source.prepared);
      }else{
       const prepared=await prepare(jobId,inputs,{signal});signal.throwIfAborted();record=await store.savePrepared(treeId,jobId,prepared);
      }
     }
    }
    signal.throwIfAborted();let result:UploadTreeAdvance|UploadTreeStreamAdvance;
    if(record.job.kind==="stream"){
     const original=record.items[0];if(original===undefined)throw Error("Original streaming item is unavailable");
     const onProgress=(confirmedBytes:number,totalBytes:number)=>{activeBytes.set(jobId,{relativePath:original.relativePath,confirmedBytes,totalBytes});report();};
     let pollMilliseconds=250;
     do{
      signal.throwIfAborted();result=await streaming().transport.advance(treeId,jobId,{...(source?{source}:{}),signal,onProgress});
      if(result.outcome==="source_required"){
       const saved=result.record,item=saved.items[0];if(item===undefined)throw Error("Original streaming item is unavailable");const file=sources.get(item.itemId);signal.throwIfAborted();
       if(!file)throw Error("Reselect the original file or folder to continue this saved upload");
       if(saved.encoded===undefined||!saved.fingerprints)throw Error("Original streaming metadata is unavailable");
       source=await streaming().reselect({job:JSON.parse(saved.encoded) as UploadTreeStreamWireJob,encoded:saved.encoded,fingerprints:saved.fingerprints,payloadBytes:0},file,{signal});signal.throwIfAborted();
       result=await streaming().transport.advance(treeId,jobId,{source,signal,onProgress});
      }
      if(result.outcome==="pending"){
       // A committed background request is ordinary progress. Keep its lane,
       // inspect the same original with bounded backoff, and count nothing as
       // stored until final publication. UNKNOWN still stops for reconciliation.
       phases.set(jobId,result.record.phase);report();await streaming().wait(pollMilliseconds,signal);pollMilliseconds=Math.min(2000,pollMilliseconds*2);
      }
     }while(result.outcome==="pending");
    }else result=await transport.advance(treeId,jobId,signal);
    phases.set(jobId,result.record.phase);count(result.record);
    if(result.outcome!=="completed"&&result.outcome!=="cancelled")throw Error(result.outcome==="reconciliation_required"?"The original tree job requires reconciliation; its data is retained":"The original tree job is still pending; inspect it before continuing");
   }catch(error){stop(error);}finally{active.delete(jobId);activePaths.delete(jobId);activeBytes.delete(jobId);report();}
  });
  active.set(jobId,operation);report();
 };
 while(!aborted()&&(remaining.size>0||active.size>0)){
  const candidates=plan.jobs.filter(job=>remaining.has(job.jobId)).sort((a,b)=>Number(phases.get(a.jobId)==="planned")-Number(phases.get(b.jobId)==="planned"));
  for(const job of candidates){
   if(aborted()||active.size>=2)break;
   if(!remaining.has(job.jobId))continue;
   // Inspect potentially sent originals before opening ANY new source body.
   // UNKNOWN capacity is deliberately retained across tabs and process death.
   const unsent=["planned","preparing","ready"].includes(phase(job.jobId));
   if(unsent&&[...phases.values()].some(phase=>["sending","accepted","unknown"].includes(phase)))continue;
   if(job.dependencies.some(id=>cancelled.has(id))){stop(Error("A cancelled original parent blocks its descendants"));break;}
   if(job.dependencies.every(id=>complete.has(id))){
    // A reduced current capability must not prevent inspection of already
    // sent originals. Recheck it before the FIRST new effect, after recovery.
    if(unsent){try{await preflight();}catch(error){stop(error);break;}}
    if(!aborted())launch(job.jobId);
   }
  }
  if(active.size>0)await Promise.race(active.values());
  else if(remaining.size>0&&!aborted())stop(Error("Original tree dependencies are unresolved"));
 }
 // Aborting UI/request does not release slots while hashing, journal writes,
 // fetch settlement or final receipt persistence are still in progress.
 await Promise.allSettled(active.values());
 if(failure.present)throw failure.value;signal.throwIfAborted();return snapshot();
}
