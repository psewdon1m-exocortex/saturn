import {assertUploadTreePlan,type UploadTreePlan,type UploadTreePlanItem,type UploadTreePlanJob} from "./upload-tree-plan.js";
import type {PreparedUploadTreeJob,UploadTreeSourceFingerprint,UploadTreeWireJob} from "./upload-tree-batch.js";
import {assertPreparedUploadTreeStream,type PreparedUploadTreeStreamJob,type UploadTreeStreamWireJob} from "./upload-tree-stream.js";
import {applyUploadTreeStreamStatus,beginUploadTreeStreamChunk,beginUploadTreeStreamSeal,validateUploadTreeStreamProgress,type UploadTreeStreamProgress,type UploadTreeStreamIdentity,type UploadTreeStreamChunkIntent} from "./upload-tree-stream-progress.js";
import {errorValue} from "./error-value.js";

export type UploadTreeScope={readonly kind:"owner";readonly rootId:string}|{readonly kind:"drop";readonly channelId:string};
export type UploadTreeJobPhase="planned"|"preparing"|"ready"|"sending"|"accepted"|"unknown"|"completed"|"cancelled";
export interface DurableTreeJob {
 readonly key:string;readonly treeId:string;readonly jobId:string;readonly scope:UploadTreeScope;
 readonly job:UploadTreePlanJob;readonly items:readonly UploadTreePlanItem[];
 readonly phase:UploadTreeJobPhase;readonly createdAt:number;readonly updatedAt:number;
 readonly encoded?:string;readonly intentSha256?:string;readonly fingerprints?:readonly UploadTreeSourceFingerprint[];readonly status?:TreeJobStatus;
 readonly stream?:UploadTreeStreamProgress;
}
export interface TreeJobStatus {
 readonly treeId:string;readonly jobId:string;readonly intentSha256:string;readonly state:"accepted"|"running"|"unknown"|"completed"|"cancelled";
 readonly items:readonly {readonly itemId:string;readonly parentItemId:string|null;readonly relativePath:string;readonly kind:"file"|"directory";readonly state:string;readonly receipt:unknown}[];
}
export interface UploadTreeSummary {readonly treeId:string;readonly createdAt:number;readonly jobs:number;readonly files:number;readonly directories:number}
interface PlanRecord {readonly treeId:string;readonly scope:UploadTreeScope;readonly plan:UploadTreePlan;readonly createdAt:number}
interface PlanIndex {treeId:string;scopeKey:string;metadataBytes:number;jobs:number;createdAt:number}
interface Slot {key:string;scopeKey:string;unknown:boolean}
const names=["plans","plan-index","jobs","slots"],uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,sha=/^[a-f0-9]{64}$/;
const phases=new Set(["planned","preparing","ready","sending","accepted","unknown","completed","cancelled"]);
const encoder=new TextEncoder(),size=(value:unknown)=>encoder.encode(JSON.stringify(value)).length;
const key=(treeId:string,jobId:string)=>{if(!uuid.test(treeId)||!uuid.test(jobId))throw Error("Invalid original tree job identity");return treeId+":"+jobId;};
function scopeKey(scope:UploadTreeScope):string{if(scope.kind==="owner"&&uuid.test(scope.rootId))return "owner";if(scope.kind==="drop"&&uuid.test(scope.channelId))return "drop:"+scope.channelId;throw Error("Invalid upload tree scope");}
async function digest(text:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(text)))].map(n=>n.toString(16).padStart(2,"0")).join("");}
function checked(value:unknown):DurableTreeJob{
 if(!value||typeof value!=="object")throw Error("Original tree job is unavailable");const row=value as DurableTreeJob;
 if(row.key!==key(row.treeId,row.jobId)||row.job.jobId!==row.jobId||!phases.has(row.phase)||!Array.isArray(row.items)||row.items.length<1||row.items.length>16
  ||!Number.isSafeInteger(row.createdAt)||!Number.isSafeInteger(row.updatedAt)||row.createdAt<0||row.updatedAt<row.createdAt)throw Error("Durable tree job is invalid; retain browser data for recovery");
 scopeKey(row.scope);
 if(row.encoded!==undefined&&(typeof row.encoded!=="string"||encoder.encode(row.encoded).length>4194304||!sha.test(row.intentSha256??"")))throw Error("Durable tree body is invalid");
 if(["ready","sending","accepted","unknown"].includes(row.phase)&&row.encoded===undefined)throw Error("Durable tree body is missing");
 if(row.job.kind==="stream"&&row.encoded!==undefined)validatePreparedTreeStream(row,{job:JSON.parse(row.encoded) as UploadTreeStreamWireJob,encoded:row.encoded,fingerprints:row.fingerprints??[],payloadBytes:0});
 if(row.stream!==undefined)validateUploadTreeStreamProgress(streamIdentity(row),row.stream);
 return row;
}
function streamIdentity(row:DurableTreeJob):UploadTreeStreamIdentity{
 const item=row.items[0],source=row.fingerprints?.[0],intentSha256=row.intentSha256;
 if(row.job.kind!=="stream"||row.items.length!==1||!item||item.kind!=="file"||row.fingerprints?.length!==1||!source||source.itemId!==item.itemId||source.sizeBytes!==item.sizeBytes
  ||source.relativePath!==item.relativePath||!sha.test(source.sha256)||intentSha256===undefined||!sha.test(intentSha256))throw Error("Durable streaming identity is unavailable");
 return {treeId:row.treeId,jobId:row.jobId,itemId:item.itemId,intentSha256,sizeBytes:item.sizeBytes,sha256:source.sha256};
}
function streamIsAdmitted(row:DurableTreeJob):boolean{return row.status?.state==="accepted"&&row.status.items.length===1&&row.status.items[0]?.state==="reserved";}
export function validatePreparedTreeStream(record:DurableTreeJob,prepared:PreparedUploadTreeStreamJob):void{
 assertPreparedUploadTreeStream(prepared);const original=record.items[0],item=prepared.job.item,fingerprint=prepared.fingerprints[0];if(fingerprint===undefined)throw Error("Prepared stream fingerprint is unavailable");
 if(record.job.kind!=="stream"||record.items.length!==1||record.job.itemIds.length!==1||record.job.itemIds[0]!==item.itemId||prepared.job.jobId!==record.jobId||record.job.jobId!==record.jobId
  ||!original||original.kind!=="file"||original.itemId!==item.itemId||original.parentItemId!==item.parentItemId||original.relativePath!==item.relativePath
  ||original.sizeBytes!==item.sizeBytes||original.name!==fingerprint.filename||original.lastModified!==fingerprint.lastModified)throw Error("Prepared stream differs from its original plan");
}
function checkPrepared(record:DurableTreeJob,prepared:PreparedUploadTreeJob):void{
 if(record.job.kind!=="small"||prepared.job.jobId!==record.jobId||prepared.encoded!==JSON.stringify(prepared.job)||(prepared.job.schema as unknown)!=="saturn.browser-tree-job.v1"||prepared.job.items.length!==record.items.length||encoder.encode(prepared.encoded).length>4194304)throw Error("Prepared tree job differs from its original plan");
 const ids=new Set<string>();let files=0;
 for(const item of prepared.job.items){
  const original=record.items.find(x=>x.itemId===item.itemId);if(!original||ids.has(item.itemId)||item.parentItemId!==original.parentItemId||item.relativePath!==original.relativePath||item.kind!==original.kind)throw Error("Prepared tree item identity changed");ids.add(item.itemId);
  if(item.kind==="file"&&original.kind==="file"){
   files++;const fingerprint=prepared.fingerprints.find(f=>f.itemId===item.itemId);
   if(item.sizeBytes!==original.sizeBytes||!sha.test(item.sha256)||!fingerprint||fingerprint.relativePath!==original.relativePath||fingerprint.filename!==original.name||fingerprint.lastModified!==original.lastModified||fingerprint.sizeBytes!==original.sizeBytes||fingerprint.sha256!==item.sha256)throw Error("Prepared source fingerprint changed");
  }
 }
 if(files!==prepared.fingerprints.length||new Set(prepared.fingerprints.map(f=>f.itemId)).size!==files)throw Error("Prepared source fingerprint set changed");
}
export function validateTreeJobStatus(record:DurableTreeJob,value:unknown):TreeJobStatus{
 if(!value||typeof value!=="object")throw Error("Invalid tree job status");const status=value as TreeJobStatus,items:unknown=status.items;
 if(status.treeId!==record.treeId||status.jobId!==record.jobId||status.intentSha256!==record.intentSha256||!["accepted","running","unknown","completed","cancelled"].includes(status.state)||!Array.isArray(items)||items.length!==record.items.length)throw Error("Tree status does not match the original job");
 const wire=record.encoded===undefined?undefined:JSON.parse(record.encoded) as UploadTreeWireJob|UploadTreeStreamWireJob,seen=new Set<string>();
 if(wire&&(record.job.kind==="stream"?wire.schema!=="saturn.browser-tree-stream-job.v1":wire.schema!=="saturn.browser-tree-job.v1"))throw Error("Tree body schema differs from its original plan");
 for(const item of status.items){
  const original=record.items.find(i=>i.itemId===item.itemId);if(!original||seen.has(item.itemId)||item.parentItemId!==original.parentItemId||item.relativePath!==original.relativePath||item.kind!==original.kind||!["reserved","materializing","verified","publishing","unknown","published","cancelled"].includes(item.state))throw Error("Tree status item differs from its original");seen.add(item.itemId);
  if(item.state==="published"){
   const receipt=item.receipt as {resourceId?:unknown;versionId?:unknown;kind?:unknown;sizeBytes?:unknown;sha256?:unknown;relativePath?:unknown}|null;
   if(!receipt||typeof receipt.resourceId!=="string"||!uuid.test(receipt.resourceId)||receipt.kind!==original.kind||receipt.relativePath!==original.relativePath)throw Error("Tree publication receipt is invalid");
   if(original.kind==="directory"){if(receipt.versionId!==null||receipt.sizeBytes!==0||receipt.sha256!==null)throw Error("Directory receipt changed");}
   else{const source=record.fingerprints?.find(f=>f.itemId===item.itemId),body=wire===undefined?undefined:wire.schema==="saturn.browser-tree-job.v1"?wire.items.find(i=>i.itemId===item.itemId):wire.item.itemId===item.itemId?wire.item:undefined;
    if(typeof receipt.versionId!=="string"||!uuid.test(receipt.versionId)||receipt.sizeBytes!==original.sizeBytes||!source||receipt.sha256!==source.sha256
     ||wire&&(!body||body.kind!=="file"||body.sha256!==source.sha256||body.sizeBytes!==original.sizeBytes))throw Error("File receipt differs from the source fingerprint");}
  }else if(item.receipt!==null)throw Error("Unpublished item has a receipt");
 }
 if(status.state==="completed"&&status.items.some(item=>item.state!=="published")||status.state==="cancelled"&&status.items.some(item=>item.state!=="cancelled"))throw Error("Tree job is not terminal for every item");
 for(const previous of record.status?.items??[])if(previous.state==="published"){
  const current=status.items.find(i=>i.itemId===previous.itemId);if(current?.state!=="published"||JSON.stringify(current.receipt)!==JSON.stringify(previous.receipt))throw Error("Confirmed tree publication cannot change");
 }
 return structuredClone(status);
}

/** Strict IndexedDB identity/byte journal. No localStorage fallback, TTL expiry,
 * unknown-original deletion or network side effects. Call markSending and await
 * its strict commit before POST. Ready small bodies allow same-ID replay after
 * browser death even when the original File handles are no longer available. */
export class DurableUploadTreeStore {
 #opening:Promise<IDBDatabase>|undefined;
 constructor(private readonly databaseName="saturn-browser-tree-v1"){}
 async #database():Promise<IDBDatabase>{
  this.#opening??=new Promise<IDBDatabase>((resolve,reject)=>{
   if(typeof indexedDB==="undefined"){reject(Error("Durable tree storage is unavailable"));return;}
   const request=indexedDB.open(this.databaseName,1);let abandoned=false;
   request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore("plans",{keyPath:"treeId"});db.createObjectStore("plan-index",{keyPath:"treeId"});const jobs=db.createObjectStore("jobs",{keyPath:"key"});jobs.createIndex("treeId","treeId");const slots=db.createObjectStore("slots",{keyPath:"key"});slots.createIndex("scopeKey","scopeKey");};
   request.onerror=()=>reject(request.error??Error("Cannot open durable tree storage"));request.onblocked=()=>{abandoned=true;reject(Error("Tree storage upgrade is blocked by another tab"));};
   request.onsuccess=()=>{if(abandoned){request.result.close();return;}const db=request.result;db.onversionchange=()=>{db.close();this.#opening=undefined;};db.onclose=()=>{this.#opening=undefined;};resolve(db);};
  }).catch((error: unknown) =>{this.#opening=undefined;throw error;});return this.#opening;
 }
 async #transaction<T>(writable:boolean,action:(tx:IDBTransaction,done:(value:T)=>void,fail:(error:unknown)=>void)=>void):Promise<T>{
  const db=await this.#database();return new Promise<T>((resolve,reject)=>{
   let tx:IDBTransaction;try{tx=writable?db.transaction(names,"readwrite",{durability:"strict"}):db.transaction(names,"readonly");if(writable&&tx.durability!=="strict"){tx.abort();throw Error("Strict IndexedDB durability is required before tree admission");}}catch(error){reject(errorValue(error));return;}
   let result:T,failure:unknown;tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(errorValue(failure??tx.error??Error("Durable tree transaction aborted")));tx.onerror=()=>{failure??=tx.error;};
   const fail=(error:unknown)=>{failure=error;try{tx.abort();}catch{reject(errorValue(error));}};try{action(tx,value=>{result=value;},fail);}catch(error){fail(error);}
  });
 }
 async savePlan(scope:UploadTreeScope,plan:UploadTreePlan):Promise<void>{
  const snapshot=structuredClone(plan),savedScope=structuredClone(scope),scoped=scopeKey(savedScope);assertUploadTreePlan(snapshot);const metadataBytes=size(snapshot);
  await this.#transaction<undefined>(true,(tx,done,fail)=>{
   const index=tx.objectStore("plan-index"),plans=tx.objectStore("plans"),existing=plans.get(snapshot.treeId);
   existing.onsuccess=()=>{try{if(existing.result){const before=existing.result as PlanRecord;if(JSON.stringify(before.scope)!==JSON.stringify(savedScope)||JSON.stringify(before.plan)!==JSON.stringify(snapshot))throw Error("Original tree plan cannot change");const count=tx.objectStore("jobs").index("treeId").count(snapshot.treeId);count.onsuccess=()=>{if(count.result!==snapshot.jobs.length)fail(Error("Durable tree job set is incomplete"));else done(undefined);};return;}
    const all=index.getAll(undefined,17);all.onsuccess=()=>{try{const rows=all.result as PlanIndex[];if(rows.length>=16||rows.reduce((n,r)=>n+r.metadataBytes,0)+metadataBytes>33554432)throw Error("Resolve existing upload trees before starting another");const now=Date.now();
     plans.add({treeId:snapshot.treeId,scope:savedScope,plan:snapshot,createdAt:now} satisfies PlanRecord);index.add({treeId:snapshot.treeId,scopeKey:scoped,metadataBytes,jobs:snapshot.jobs.length,createdAt:now} satisfies PlanIndex);
     const byId=new Map(snapshot.items.map(i=>[i.itemId,i]));for(const job of snapshot.jobs)tx.objectStore("jobs").add({key:key(snapshot.treeId,job.jobId),treeId:snapshot.treeId,jobId:job.jobId,scope:savedScope,job,items:job.itemIds.map(id=>{const item=byId.get(id);if(!item)throw Error("Original tree item is unavailable");return item;}),phase:"planned",createdAt:now,updatedAt:now} satisfies DurableTreeJob);done(undefined);
    }catch(error){fail(error);}};
   }catch(error){fail(error);}};
  });
 }
 async loadPlan(treeId:string):Promise<{readonly scope:UploadTreeScope;readonly plan:UploadTreePlan}>{
  if(!uuid.test(treeId))throw Error("Invalid tree identity");const record=await this.#transaction<PlanRecord>(false,(tx,done,fail)=>{const request=tx.objectStore("plans").get(treeId);request.onsuccess=()=>{try{const row=request.result as PlanRecord|undefined;if(!row||row.treeId!==treeId)throw Error("Original tree is unavailable");scopeKey(row.scope);assertUploadTreePlan(row.plan);done(row);}catch(error){fail(error);}};});return {scope:record.scope,plan:record.plan};
 }
 /** At most16 retained plans; return metadata only, never saved payload bytes.
  * Exact destination/channel matching is separate from the owner-wide slot cap. */
 async listPlans(scope:UploadTreeScope):Promise<readonly UploadTreeSummary[]>{
  const savedScope=structuredClone(scope);scopeKey(savedScope);
  return this.#transaction<readonly UploadTreeSummary[]>(false,(tx,done,fail)=>{
   const request=tx.objectStore("plans").getAll(undefined,17);
   request.onsuccess=()=>{try{
    const rows=request.result as PlanRecord[];if(rows.length>16)throw Error("Retained tree count exceeds its bound");
    const results:UploadTreeSummary[]=[];
    for(const row of rows){scopeKey(row.scope);assertUploadTreePlan(row.plan);
     if(row.scope.kind!==savedScope.kind||(row.scope.kind==="owner"&&savedScope.kind==="owner"?row.scope.rootId!==savedScope.rootId:row.scope.kind==="drop"&&savedScope.kind==="drop"?row.scope.channelId!==savedScope.channelId:true))continue;
     results.push({treeId:row.treeId,createdAt:row.createdAt,jobs:row.plan.jobs.length,files:row.plan.items.filter(item=>item.kind==="file").length,directories:row.plan.items.filter(item=>item.kind==="directory").length});
    }
    done(results.sort((a,b)=>b.createdAt-a.createdAt));
   }catch(error){fail(error);}};
  });
 }
 async loadJob(treeId:string,jobId:string):Promise<DurableTreeJob>{
  const row=await this.#transaction<DurableTreeJob>(false,(tx,done,fail)=>{const request=tx.objectStore("jobs").get(key(treeId,jobId));request.onsuccess=()=>{try{done(checked(request.result));}catch(error){fail(error);}};});
  if(row.encoded!==undefined&&await digest(row.encoded)!==row.intentSha256)throw Error("Durable tree body hash changed; retain this original");return row;
 }
 async #change(treeId:string,jobId:string,action:(row:DurableTreeJob,tx:IDBTransaction)=>DurableTreeJob):Promise<DurableTreeJob>{
  return this.#transaction<DurableTreeJob>(true,(tx,done,fail)=>{const store=tx.objectStore("jobs"),request=store.get(key(treeId,jobId));request.onsuccess=()=>{try{const result=action(checked(request.result),tx);store.put(result);done(result);}catch(error){fail(error);}};});
 }
 async reserveJob(treeId:string,jobId:string):Promise<DurableTreeJob>{
  return this.#transaction<DurableTreeJob>(true,(tx,done,fail)=>{const jobs=tx.objectStore("jobs"),slots=tx.objectStore("slots"),request=jobs.get(key(treeId,jobId));request.onsuccess=()=>{try{const row=checked(request.result);if(row.phase!=="planned"){done(row);return;}const scoped=scopeKey(row.scope),all=slots.index("scopeKey").getAll(scoped,3);all.onsuccess=()=>{try{const active=all.result as Slot[];if(active.length>=2||active.some(s=>s.unknown))throw Error("Resolve the two existing tree jobs before preparing another");const count=slots.count();count.onsuccess=()=>{try{if(count.result>=8)throw Error("Browser tree preparation capacity is exhausted");const result={...row,phase:"preparing" as const,updatedAt:Date.now()};slots.add({key:row.key,scopeKey:scoped,unknown:false} satisfies Slot);jobs.put(result);done(result);}catch(error){fail(error);}};}catch(error){fail(error);}};}catch(error){fail(error);}};});
 }
 async savePrepared(treeId:string,jobId:string,prepared:PreparedUploadTreeJob):Promise<DurableTreeJob>{
  const snapshot=structuredClone(prepared),record=await this.loadJob(treeId,jobId);checkPrepared(record,snapshot);const intentSha256=await digest(snapshot.encoded);
  return this.#change(treeId,jobId,row=>{checkPrepared(row,snapshot);if(row.encoded!==undefined){if(row.encoded!==snapshot.encoded||row.intentSha256!==intentSha256||JSON.stringify(row.fingerprints)!==JSON.stringify(snapshot.fingerprints))throw Error("Original prepared bytes cannot change");return row;}if(row.phase!=="preparing")throw Error("Reserve a bounded job slot before preparation");return {...row,phase:"ready",encoded:snapshot.encoded,intentSha256,fingerprints:snapshot.fingerprints,updatedAt:Date.now()};});
 }
 async savePreparedStream(treeId:string,jobId:string,prepared:PreparedUploadTreeStreamJob):Promise<DurableTreeJob>{
  const snapshot=structuredClone(prepared),record=await this.loadJob(treeId,jobId);validatePreparedTreeStream(record,snapshot);const intentSha256=await digest(snapshot.encoded);
  return this.#change(treeId,jobId,row=>{
   validatePreparedTreeStream(row,snapshot);
   if(row.encoded!==undefined){if(row.encoded!==snapshot.encoded||row.intentSha256!==intentSha256||JSON.stringify(row.fingerprints)!==JSON.stringify(snapshot.fingerprints))throw Error("Original prepared stream cannot change");return row;}
   if(row.phase!=="preparing")throw Error("Reserve a bounded job slot before streaming preparation");
   return {...row,phase:"ready",encoded:snapshot.encoded,intentSha256,fingerprints:snapshot.fingerprints,updatedAt:Date.now()};
  });
 }
 async markSending(treeId:string,jobId:string):Promise<DurableTreeJob>{
  await this.loadJob(treeId,jobId);return this.#change(treeId,jobId,row=>{if(!["ready","sending"].includes(row.phase)||row.encoded===undefined)throw Error("Original job is not ready; inspect its server status first");return {...row,phase:"sending",updatedAt:Date.now()};});
 }
 async markUnknown(treeId:string,jobId:string):Promise<DurableTreeJob>{
  return this.#change(treeId,jobId,(row,tx)=>{if(["completed","cancelled"].includes(row.phase))return row;if(!["sending","accepted","unknown"].includes(row.phase))throw Error("This original has not been sent");tx.objectStore("slots").put({key:row.key,scopeKey:scopeKey(row.scope),unknown:true} satisfies Slot);return {...row,phase:"unknown",updatedAt:Date.now()};});
 }
 /** Only the transport's authenticated exact-original404 path may call this.
  * Retain the uncertain slot until a server receipt, and resend IDENTICAL bytes;
  * this never mints a replacement identity or frees capacity after a timeout. */
 async retryMissingAdmission(treeId:string,jobId:string):Promise<DurableTreeJob>{
  await this.loadJob(treeId,jobId);return this.#change(treeId,jobId,row=>{
   if(!["sending","accepted","unknown"].includes(row.phase)||row.encoded===undefined)throw Error("Original admission body is unavailable");
   if(row.job.kind==="stream"&&(row.stream!==undefined||row.status!==undefined))throw Error("Previously observed streaming original is missing; reconciliation is required");
   return {...row,phase:"sending",updatedAt:Date.now()};
  });
 }
 /** Persist exactly one append intent BEFORE the HTTP body is sent. Unknown
  * capacity stays held until its matching server progress receipt commits. */
 async markStreamChunkPending(treeId:string,jobId:string,value:UploadTreeStreamChunkIntent):Promise<DurableTreeJob>{
  const intent=structuredClone(value);return this.#change(treeId,jobId,(row,tx)=>{
   if(!["accepted","unknown"].includes(row.phase)||!streamIsAdmitted(row)||row.stream===undefined||row.phase==="unknown"&&row.stream.pending===null)throw Error("Inspect the admitted stream before starting a chunk");
   const stream=beginUploadTreeStreamChunk(streamIdentity(row),row.stream,intent);tx.objectStore("slots").put({key:row.key,scopeKey:scopeKey(row.scope),unknown:true} satisfies Slot);
   return {...row,stream,phase:"unknown",updatedAt:Date.now()};
  });
 }
 async recordStreamProgress(treeId:string,jobId:string,value:unknown):Promise<DurableTreeJob>{
  const snapshot=structuredClone(value);return this.#change(treeId,jobId,(row,tx)=>{
   if(!["accepted","unknown"].includes(row.phase)||!row.status)throw Error("Stream has no durable admission receipt");
   const stream=applyUploadTreeStreamStatus(streamIdentity(row),row.stream,snapshot),uncertain=stream.pending!==null||stream.sealPending||!streamIsAdmitted(row);
   tx.objectStore("slots").put({key:row.key,scopeKey:scopeKey(row.scope),unknown:uncertain} satisfies Slot);
   return {...row,stream,phase:uncertain?"unknown":"accepted",updatedAt:Date.now()};
  });
 }
 async markStreamSealPending(treeId:string,jobId:string):Promise<DurableTreeJob>{
  return this.#change(treeId,jobId,(row,tx)=>{
   if(!["accepted","unknown"].includes(row.phase)||!streamIsAdmitted(row)||row.stream===undefined||row.phase==="unknown"&&!row.stream.sealPending)throw Error("Inspect the admitted stream before sealing");
   const stream=beginUploadTreeStreamSeal(streamIdentity(row),row.stream);tx.objectStore("slots").put({key:row.key,scopeKey:scopeKey(row.scope),unknown:stream.sealPending} satisfies Slot);
   return {...row,stream,phase:stream.sealPending?"unknown":"accepted",updatedAt:Date.now()};
  });
 }
 async recordStatus(treeId:string,jobId:string,value:unknown):Promise<DurableTreeJob>{
  const snapshot=structuredClone(value);return this.#change(treeId,jobId,(row,tx)=>{const status=validateTreeJobStatus(row,snapshot);if(["planned","preparing","ready"].includes(row.phase))throw Error("Tree original has no durable send boundary");if(["completed","cancelled"].includes(row.phase)&&row.phase!==status.state)throw Error("Terminal tree status cannot regress");
   const phase:UploadTreeJobPhase=status.state==="completed"?"completed":status.state==="cancelled"?"cancelled":status.state==="unknown"||row.stream?.pending!=null||row.stream?.sealPending?"unknown":"accepted";
   const next={...row,phase,status,updatedAt:Date.now()};if(phase==="completed"||phase==="cancelled"){tx.objectStore("slots").delete(row.key);const {encoded,...retained}=next;void encoded;return retained;}
   tx.objectStore("slots").put({key:row.key,scopeKey:scopeKey(row.scope),unknown:phase==="unknown"} satisfies Slot);return next;});
 }
 async cancelUnsent(treeId:string,jobId:string):Promise<DurableTreeJob>{
  return this.#change(treeId,jobId,(row,tx)=>{if(!["planned","preparing","ready"].includes(row.phase))throw Error("Inspect and cancel the same server job; its outcome may be unknown");tx.objectStore("slots").delete(row.key);const {encoded,...original}=row;void encoded;return {...original,phase:"cancelled",updatedAt:Date.now()};});
 }
 /** Release browser metadata only after EVERY original has a confirmed terminal
  * result (or was cancelled before its durable send boundary). Server receipts
  * retain idempotency; unknown/active work never expires to make room. */
 async releaseCompletedTree(treeId:string):Promise<void>{
  if(!uuid.test(treeId))throw Error("Invalid tree identity");
  await this.#transaction<undefined>(true,(tx,done,fail)=>{const index=tx.objectStore("plan-index"),request=index.get(treeId);request.onsuccess=()=>{try{const metadata=request.result as PlanIndex|undefined;if(!metadata)throw Error("Original tree is unavailable");const keys:string[]=[],cursor=tx.objectStore("jobs").index("treeId").openCursor(IDBKeyRange.only(treeId));cursor.onsuccess=()=>{try{const current=cursor.result;if(current){const row=checked(current.value);if(!["completed","cancelled"].includes(row.phase))throw Error("Unresolved original tree jobs must be retained");keys.push(row.key);if(keys.length>20000)throw Error("Durable tree job set exceeds its bound");current.continue();return;}if(keys.length!==metadata.jobs)throw Error("Durable tree job set is incomplete");for(const id of keys){tx.objectStore("jobs").delete(id);tx.objectStore("slots").delete(id);}tx.objectStore("plans").delete(treeId);index.delete(treeId);done(undefined);}catch(error){fail(error);}};}catch(error){fail(error);}};});
 }
 async close():Promise<void>{const db=await this.#opening;db?.close();this.#opening=undefined;}
}
export const durableUploadTrees=new DurableUploadTreeStore();
