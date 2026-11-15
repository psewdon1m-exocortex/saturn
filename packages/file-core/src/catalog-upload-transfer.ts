import { requiredValue } from "./required-value.js";
import {createHash,randomUUID} from "node:crypto";
import {Readable} from "node:stream";
import {ensureStorageDirectory,type StorageAdapter} from "@saturn/storage";
import type {CatalogFolderAuthority} from "./catalog-folder-authority.js";
import {detectContentType} from "./content-type.js";
import {CatalogUploadError,type CatalogUploadDatabaseCoordinator,type PreparedCatalogUpload,type CatalogUploadTransfer} from "./catalog-upload-database.js";
import type {CatalogRootAdmission} from "./catalog-root-admission.js";
export type CatalogStorageVerify = (prepared: PreparedCatalogUpload, path: string, sizeBytes: string, sha256: string, contentVersionId: string) => Promise<void>;
interface ReadyPublication {prepared:PreparedCatalogUpload;proof:CatalogFolderAuthority;mime:string;window:number;transfer?:CatalogUploadTransfer;resolve:(p:PreparedCatalogUpload)=>void;reject:(e:unknown)=>void}

async function digest(stream:Readable,maximumBytes:string):Promise<{sha256:string;sizeBytes:string;prefix:Buffer}>{
  const hash=createHash("sha256"),prefix=Buffer.alloc(512);let size=0n,prefixBytes=0;
  for await(const chunk of stream){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array);size+=BigInt(bytes.length);if(size>BigInt(maximumBytes))throw new CatalogUploadError("verification_failed");hash.update(bytes);
    const take=Math.min(bytes.length,prefix.length-prefixBytes);if(take){bytes.copy(prefix,prefixBytes,0,take);prefixBytes+=take;}}
  return {sha256:hash.digest("hex"),sizeBytes:size.toString(),prefix:prefix.subarray(0,prefixBytes)};
}
/** Explicit inactive guarded physical executor. Four stream slots, durable per-upload chunk
 * reservations and a cross-process per-root final slot. No stat/adoption/compensation on ambiguity. */
export class CatalogUploadTransferExecutor {
  #active=0;readonly #uploads=new Set<string>();
  #jobActive=0;readonly #materializerWaiting:(()=>void)[]=[];
  readonly #freshProgress=new WeakSet<PreparedCatalogUpload>();
  #ready:ReadyPublication[]=[];
  #readyTimers=new Map<ReadyPublication,ReturnType<typeof setTimeout>>();
  constructor(private readonly database:CatalogUploadDatabaseCoordinator,private readonly storage:StorageAdapter,private readonly maximumBytes:number,private readonly admission?:CatalogRootAdmission,private readonly verifyStorage?:CatalogStorageVerify){if(!Number.isSafeInteger(maximumBytes)||maximumBytes<0)throw new CatalogUploadError("invalid_input");}
  #writeOnce(...args:Parameters<NonNullable<StorageAdapter["writeOnce"]>>):Promise<number>{
    const write=this.storage.writeOnce?.bind(this.storage);
    if(!write)return Promise.reject(new CatalogUploadError("transfer_unresolved"));
    return write(...args);
  }
  #renameGroupOnce(...args:Parameters<NonNullable<StorageAdapter["renameGroupOnce"]>>):Promise<void>{
    const rename=this.storage.renameGroupOnce?.bind(this.storage);
    if(!rename)return Promise.reject(new CatalogUploadError("transfer_unresolved"));
    return rename(...args);
  }
  async #verify(prepared:PreparedCatalogUpload,path:string,sizeBytes:string,sha256:string,versionId:string):Promise<Buffer|undefined>{
    if(this.verifyStorage){
      try{await this.verifyStorage(prepared,path,sizeBytes,sha256,versionId);return;}catch(error){
        const code=error&&typeof error==="object"&&"code"in error?String(error.code):"verifier_unavailable";
        if(!["unsupported","verifier_unavailable","capacity","cancelled"].includes(code))throw error;
      }
    }
    const actual=await digest(await this.storage.openRead(path),sizeBytes);
    if(actual.sha256!==sha256||actual.sizeBytes!==sizeBytes)throw new CatalogUploadError("verification_failed");
    return actual.prefix;
  }
  #admit<T>(prepared:PreparedCatalogUpload,action:()=>Promise<T>):Promise<T>{return this.admission?this.admission.run(prepared.input.intent.rootId,action):action();}
  async supportsReplayableChunks():Promise<boolean>{
    return typeof this.storage.writeOnce==='function'&&typeof this.storage.supportsWriteOnce==='function'
      &&await this.database.supportsReplayableChunks()&&await this.storage.supportsWriteOnce();
  }
  async #admitPrivateSql<T>(prepared:PreparedCatalogUpload,action:()=>Promise<T>):Promise<T>{
    return this.admission&&await this.database.supportsPublicationGroups()?this.admission.runSqlBatch(prepared.input.intent.rootId,action):this.#admit(prepared,action);
  }
  async #bounded<T>(prepared:PreparedCatalogUpload,action:()=>Promise<T>,physicalLimit=true):Promise<T>{
    if(this.#active>=4||this.#uploads.has(prepared.status.session.uploadId))throw new CatalogUploadError("admission_full");
    if(physicalLimit&&BigInt(prepared.input.intent.sizeBytes)>BigInt(this.maximumBytes))throw new CatalogUploadError("upload_too_large");
    this.#active++;this.#uploads.add(prepared.status.session.uploadId);
    try{return await action();}finally{this.#releaseMaterializer();this.#uploads.delete(prepared.status.session.uploadId);}
  }
  #releaseMaterializer():void{const next=this.#materializerWaiting.shift();if(next)next();else this.#active--;}
  async #acquireMaterializer():Promise<void>{if(this.#active<4){this.#active++;return;}await new Promise<void>(resolve=>this.#materializerWaiting.push(resolve));}
  /** Two-stage job execution. Stored bytes are independently verified before
   * releasing the materializer. Original ownership remains held until the
   * returned publication finishes; the caller must join every completion. */
  async materializeJob(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,bytes:Buffer):Promise<{readonly completion:Promise<PreparedCatalogUpload>}>{
    this.database.assertExecutionJobMember(prepared,proof);
    if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>262144||String(bytes.length)!==prepared.input.intent.sizeBytes)throw new CatalogUploadError('invalid_input');
    const jobLimit=await this.database.jobMaterializationLimit();
    if(this.#jobActive>=jobLimit||this.#uploads.has(prepared.status.session.uploadId))throw new CatalogUploadError('admission_full');
    if(BigInt(prepared.input.intent.sizeBytes)>BigInt(this.maximumBytes))throw new CatalogUploadError('upload_too_large');
    this.#jobActive++;this.#uploads.add(prepared.status.session.uploadId);let transferred=false;
    const release=()=>{this.#jobActive--;this.#uploads.delete(prepared.status.session.uploadId);};
    await this.#acquireMaterializer();
    try{
      this.database.assertExecutionJobMember(prepared,proof);
      if(prepared.status.result)return {completion:Promise.resolve(prepared)};
      if(!['transport','verified'].includes(prepared.status.session.phase)||!await this.supportsReplayableChunks()||!await this.database.supportsSmallCompletion())throw new CatalogUploadError('transfer_unresolved');
      let transfer:CatalogUploadTransfer|undefined,mime:string;
      if(prepared.status.session.transferPending){
        transfer=this.database.takeExecutionJobTransfer(prepared,proof);
        const offset=Number(transfer.offset),remaining=bytes.subarray(offset);
        this.database.assertExecutionJobMember(prepared,proof);
        mime=await this.#writeAndVerifySmall(prepared,transfer.token,String(offset),remaining);
      }else{
        if(prepared.status.session.receivedSizeBytes!==prepared.input.intent.sizeBytes)throw new CatalogUploadError('transfer_unresolved');
        mime=await this.#verifiedMime(prepared);
      }
      this.database.assertExecutionJobMember(prepared,proof);
      const publication=this.admission&&prepared.execution.before===null&&await this.database.supportsPublicationGroups()
        ?this.#enqueuePublication(prepared,proof,mime,transfer,await this.database.jobPublicationWidth(prepared)):this.#admit(prepared,()=>this.#publish(prepared,proof,mime,transfer));
      const completion=publication.catch((error:unknown)=>{this.database.blockExecutionJob(prepared);throw error;}).finally(release);
      // The HTTP/coordinator caller still receives the rejected promise and
      // must join it. Observe it here while the parser is buffering later parts.
      void completion.catch(()=>undefined);transferred=true;
      return Object.freeze({completion});
    }catch(error){this.database.blockExecutionJob(prepared);throw error;}
    finally{this.#releaseMaterializer();if(!transferred)release();}
  }
  append(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,offset:string,bytes:Buffer):Promise<PreparedCatalogUpload>{
    if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>8*1024*1024)throw new CatalogUploadError("invalid_input");
    return this.#bounded(prepared,async()=>{
      // The atomic reservation validates the offset, authority and phase itself.
      // Its terminal replay must never cause another physical write.
      const replayable=bytes.length<=4194304&&await this.supportsReplayableChunks();
      const {current,transfer}=await this.#admitPrivateSql(prepared,()=>replayable?this.database.startReplayableChunk(prepared,proof,offset,String(bytes.length)):this.database.startChunk(prepared,proof,offset,String(bytes.length)));
      if(current.status.result||current.status.session.phase!=="transport"||!current.status.session.transferPending||current.status.session.receivedSizeBytes!==offset)throw new CatalogUploadError("transfer_unresolved");
      const options={offset:Number(offset),create:offset==='0',exclusive:offset==='0',truncate:false};
      const written=replayable?await this.#writeOnce(transfer.token,current.execution.tempPath,bytes,options)
        :await this.storage.write(current.execution.tempPath,Readable.from(bytes),options);
      if(written!==bytes.length)throw new CatalogUploadError("transfer_unresolved");
      // The same transfer token may replay a committed SQL progress ACK, without writing bytes again.
      let completed:PreparedCatalogUpload;
      try{completed=await this.#admitPrivateSql(current,()=>this.database.recordChunk(current,proof,transfer));}catch(error){
        try{completed=await this.#admitPrivateSql(current,()=>this.database.recordChunk(current,proof,transfer));}catch{throw new CatalogUploadError("transfer_unresolved",{cause:error});}
      }
      if(completed.status.session.receivedSizeBytes===completed.status.session.expectedSizeBytes)this.#freshProgress.add(completed);
      return completed;
    });
  }
  async complete(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority):Promise<PreparedCatalogUpload>{
    // Current authority still applies, but a historical published result has no
    // new physical effect and must remain readable after a configured limit shrinks.
    // Admit even receipt lookup before touching the command budget. A retry
    // storm must not starve a writer's post-effect catalog commit.
    return this.#bounded(prepared,async()=>{
      // Reuse only our own just-acknowledged immutable progress handle, once.
      // Claim still rechecks current authority, topology, preimage and root fence.
      const current=this.#freshProgress.delete(prepared)?prepared:await this.database.status(prepared,proof);
      if(current.status.result)return current;
      if(BigInt(current.input.intent.sizeBytes)>BigInt(this.maximumBytes))throw new CatalogUploadError("upload_too_large");
      if(!["transport","verified"].includes(current.status.session.phase)||current.status.session.transferPending)throw new CatalogUploadError("reconciliation_required");
      if(current.status.session.receivedSizeBytes!==current.input.intent.sizeBytes)throw new CatalogUploadError("verification_failed");
      if(current.input.intent.sizeBytes==="0"&&!await this.storage.exists(current.execution.tempPath)){
        await this.storage.write(current.execution.tempPath,Readable.from(Buffer.alloc(0)),{offset:0,create:true,exclusive:true,truncate:false});
      }
      const mime=await this.#verifiedMime(current);
      // Ordinary HTTP completion has its own authority object per request;
      // unlike a parsed small batch, CAS siblings cannot share a group here.
      // Avoid imposing the group tail timer on every independent overwrite.
      if(this.admission&&current.execution.before===null&&await this.database.supportsPublicationGroups())return this.#enqueuePublication(current,proof,mime);
      return this.#admit(current,()=>this.#publish(current,proof,mime));
    },false);
  }
  async #writeAndVerifySmall(current:PreparedCatalogUpload,token:string,offset:string,bytes:Buffer):Promise<string>{
    // This operation writes the original's private temporary path, including
    // for CAS replacements. Existing target verification and archival still
    // happen only after the durable publication claim.
    if(offset==='0'&&this.storage.writeVerifiedOnce&&await this.storage.supportsWriteVerifiedOnce?.()){
      const verified=await this.storage.writeVerifiedOnce(token,current.execution.tempPath,bytes);
      if(verified.sizeBytes!==current.input.intent.sizeBytes||verified.sha256!==current.input.intent.sha256
        ||!Buffer.isBuffer(verified.prefix)||verified.prefix.length!==Math.min(512,bytes.length))throw new CatalogUploadError('verification_failed');
      return detectContentType(current.input.intent.name,verified.prefix);
    }
    if(await this.#writeOnce(token,current.execution.tempPath,bytes,{offset:Number(offset),create:offset==='0',exclusive:offset==='0',truncate:false})!==bytes.length)throw new CatalogUploadError('transfer_unresolved');
    return this.#verifiedMime(current);
  }
  async #verifiedMime(current:PreparedCatalogUpload):Promise<string>{
    const stat=await this.storage.stat(current.execution.tempPath);
    if(stat.type!=='file'||!Number.isSafeInteger(stat.size)||BigInt(stat.size)!==BigInt(current.input.intent.sizeBytes))throw new CatalogUploadError('verification_failed');
    let prefix=await this.#verify(current,current.execution.tempPath,current.input.intent.sizeBytes,current.input.intent.sha256,current.execution.versionId);
    // An external verifier proves the content but does not return MIME bytes.
    if(prefix===undefined){
      const probe:Buffer[]=[];let probeBytes=0;
      for await(const chunk of await this.storage.openRead(current.execution.tempPath,{offset:0,length:512})){
        const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array);probeBytes+=b.length;if(probeBytes>512)throw new CatalogUploadError('verification_failed');probe.push(b);
      }
      prefix=Buffer.concat(probe);
    }
    return detectContentType(current.input.intent.name,prefix);
  }
  /** A complete parser-validated small body. A write ACK alone is insufficient:
   * full independent readback precedes the combined progress/publication claim. */
  async completeSmall(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,bytes:Buffer):Promise<PreparedCatalogUpload>{
    if(!Buffer.isBuffer(bytes)||bytes.length>262144||String(bytes.length)!==prepared.input.intent.sizeBytes)throw new CatalogUploadError('invalid_input');
    if(prepared.status.result||!prepared.status.session.transferPending&&prepared.status.session.receivedSizeBytes===prepared.input.intent.sizeBytes)return this.complete(prepared,proof);
    if(!await this.supportsReplayableChunks()||!await this.database.supportsSmallCompletion()){
      if(prepared.status.session.transferPending&&!await this.supportsReplayableChunks())throw new CatalogUploadError('transfer_unresolved');
      const received=Number(prepared.status.session.receivedSizeBytes);
      const current=received<bytes.length?await this.append(prepared,proof,String(received),bytes.subarray(received)):prepared;
      return this.complete(current,proof);
    }
    return this.#bounded(prepared,async()=>{
      const offset=prepared.status.session.receivedSizeBytes,remaining=bytes.subarray(Number(offset));
      if(prepared.status.session.phase!=='transport'||remaining.length<1)throw new CatalogUploadError('transfer_unresolved');
      const {current,transfer}=await this.#admitPrivateSql(prepared,()=>this.database.startReplayableChunk(prepared,proof,offset,String(remaining.length)));
      if(current.status.result||current.status.session.phase!=='transport'||!current.status.session.transferPending||current.status.session.receivedSizeBytes!==offset)throw new CatalogUploadError('transfer_unresolved');
      const mime=await this.#writeAndVerifySmall(current,transfer.token,offset,remaining);
      if(this.admission&&await this.#canGroup(current))return this.#enqueuePublication(current,proof,mime,transfer);
      return this.#admit(current,()=>this.#publish(current,proof,mime,transfer));
    });
  }
  #enqueuePublication(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,mime:string,transfer?:CatalogUploadTransfer,window=4):Promise<PreparedCatalogUpload>{
    return new Promise((resolve,reject)=>{
      const entry:ReadyPublication={prepared,proof,mime,window,...(transfer?{transfer}:{}),resolve,reject};
      const first=this.#ready.find(e=>this.#samePublicationGroup(e,entry))??entry;
      this.#ready.push(entry);
      if(this.#ready.filter(e=>this.#samePublicationGroup(first,e)).length>=window)this.#flushPublications(first);
      else {
        // A progressing immutable job has a known finite membership. Its idle
        // tail deadline starts again when another verified original arrives.
        // Completing another job must never flush this incomplete group.
        if(window>4){clearTimeout(this.#readyTimers.get(first));this.#readyTimers.delete(first);}
        if(!this.#readyTimers.has(first))this.#readyTimers.set(first,setTimeout(()=>this.#flushPublications(first),window>4?250:50));
      }
    });
  }
  #samePublicationGroup(first:ReadyPublication,next:ReadyPublication):boolean{
    return next.window===first.window&&next.proof===first.proof&&next.prepared.input.intent.rootId===first.prepared.input.intent.rootId
      &&(first.prepared.execution.before===null)===(next.prepared.execution.before===null)
      &&(first.prepared.execution.before===null||first.prepared.input.intent.parentId===next.prepared.input.intent.parentId)
      &&(first.window<=4||this.database.sameExecutionJob(first.prepared,next.prepared));
  }
  async #canGroup(prepared:PreparedCatalogUpload):Promise<boolean>{
    if(!await this.database.supportsPublicationGroups())return false;
    if(prepared.execution.before===null)return true;
    return prepared.input.intent.schema==='saturn.upload-intent.v2'&&BigInt(prepared.input.intent.sizeBytes)>0n
      &&BigInt(prepared.input.intent.sizeBytes)<=262144n&&BigInt(prepared.execution.before.size_bytes)<=262144n&&await this.database.supportsCasPublicationSets();
  }
  #flushPublications(first:ReadyPublication):void{
    clearTimeout(this.#readyTimers.get(first));this.#readyTimers.delete(first);
    const group:ReadyPublication[]=[];
    this.#ready=this.#ready.filter(entry=>{if(group.length<first.window&&this.#samePublicationGroup(first,entry)){group.push(entry);return false;}return true;});
    if(group.length){
      void this.#admit(first.prepared,async()=>{
        if(group.length===1)first.resolve(await this.#publish(first.prepared,first.proof,first.mime,first.transfer));
        else await this.#publishGroup(group);
      }).catch((error:unknown)=>{for(const entry of group)entry.reject(error);});
    }
  }
  async #publicationFailure(current:PreparedCatalogUpload,proof:CatalogFolderAuthority,error:unknown):Promise<PreparedCatalogUpload>{
    const accepted=await this.database.status(current,proof).catch(()=>undefined);
    if(accepted?.status.result?.status==='PUBLISHED')return accepted;
    await this.database.markUnknown(current).catch(()=>undefined);
    throw new CatalogUploadError('reconciliation_required',{cause:error});
  }
  async #verifyCasPreimage(p:PreparedCatalogUpload):Promise<void>{
    if(p.execution.before===null||p.execution.archivePath===null)throw new CatalogUploadError('projection_mismatch');
    const directory=p.execution.archivePath.slice(0,p.execution.archivePath.lastIndexOf('/'));
    await ensureStorageDirectory(this.storage,directory);
    if(await this.storage.exists(p.execution.archivePath))throw new CatalogUploadError('backend_preimage_mismatch');
    const before=await this.storage.stat(p.execution.targetPath);
    if(before.type!=='file'||!Number.isSafeInteger(before.size)||String(before.size)!==p.execution.before.size_bytes
      ||!p.execution.before.content_sha256||!p.execution.before.content_version_id)throw new CatalogUploadError('backend_preimage_mismatch');
    await this.#verify(p,p.execution.targetPath,p.execution.before.size_bytes,p.execution.before.content_sha256,p.execution.before.content_version_id);
  }
  async #publishGroup(group:ReadyPublication[]):Promise<void>{
    const proof=requiredValue(group[0]).proof,requests=group.map(e=>({prepared:e.prepared,mimeType:e.mime,claimToken:randomUUID(),...(e.transfer?{transfer:e.transfer}:{})}));
    let claimed:PreparedCatalogUpload[];
    try{claimed=await this.database.verifyAndClaimGroup(requests,proof);}catch(error){
      const accepted=await Promise.all(group.map(e=>this.database.status(e.prepared,proof).catch(()=>undefined)));
      // A conclusively unclaimed group (e.g. one name conflict) may fall back
      // to the ordinary per-original path. Ambiguous/accepted claims never do.
      // Preserve the existing new-file fallback. A CAS set rejected for a
      // changed member must not bypass its complete preimage validation by
      // publishing the other members individually.
      if(group.every(e=>e.prepared.execution.before===null)&&accepted.every(p=>p&&(p.status.result||['transport','verified'].includes(p.status.session.phase)))){
        for(const [n,e]of group.entries())try{e.resolve(await this.#publish(requiredValue(accepted[n]),proof,e.mime,e.transfer));}catch(singleError){e.reject(singleError);}
        return;
      }
      for(const [n,e]of group.entries()){
        const p=accepted[n];
        if(p?.status.result)e.resolve(p);
        else{
          if(p?.status.session.phase==='physical_pending'&&p.claimToken===requiredValue(requests[n]).claimToken)await this.database.markUnknown(p).catch(()=>undefined);
          e.reject(error);
        }
      }
      return;
    }
    if(claimed.some((p,n)=>p.status.session.phase!=='physical_pending'||p.claimToken!==requiredValue(requests[n]).claimToken))throw new CatalogUploadError('projection_mismatch');
    // The FIFO root slot covers the whole bounded group. The optional backend
    // task seals every original/path under a previously persisted claim token.
    // A failed capability query is also an uncertain post-claim outcome.
    const physical=await Promise.allSettled([(async()=>{
      const groupRename=this.storage.renameGroupOnce&&await this.storage.supportsRenameGroupOnce?.();
      if(claimed.every(p=>p.execution.before===null)&&groupRename){
        await this.#renameGroupOnce(requiredValue(requiredValue(claimed[0]).claimToken),claimed.map(p=>({operationId:p.status.session.operationId,source:p.execution.tempPath,destination:p.execution.targetPath})));
        return;
      }
      if(claimed.every(p=>p.execution.before!==null)&&groupRename){
        if(claimed.length<2||claimed.length>4)throw new CatalogUploadError('projection_mismatch');
        // Verify every old generation before the first archive move. Each phase
        // is one existing durable disjoint-rename task, using distinct persisted
        // member claim tokens. Never replay a partial/unknown task by a new key.
        const checks=await Promise.allSettled(claimed.map(p=>this.#verifyCasPreimage(p)));
        const failed=checks.find((r):r is PromiseRejectedResult=>r.status==='rejected');if(failed)throw failed.reason;
        await this.#renameGroupOnce(requiredValue(requiredValue(claimed[0]).claimToken),claimed.map(p=>({operationId:p.status.session.operationId,source:p.execution.targetPath,destination:requiredValue(p.execution.archivePath)})));
        await this.#renameGroupOnce(requiredValue(requiredValue(claimed[1]).claimToken),claimed.map(p=>({operationId:p.status.session.operationId,source:p.execution.tempPath,destination:p.execution.targetPath})));
        return;
      }
      const effects=await Promise.allSettled(claimed.map(async p=>{
        if(p.execution.before===null){
          if(await this.storage.exists(p.execution.targetPath))throw new CatalogUploadError('backend_preimage_mismatch');
        }else{
          // Only a four-member exact-CAS group reaches this branch. Preserve
          // every old version and verify it independently before its rename.
          if(claimed.length>4||p.execution.archivePath===null)throw new CatalogUploadError('projection_mismatch');
          await this.#verifyCasPreimage(p);
          await this.storage.rename(p.execution.targetPath,p.execution.archivePath);
        }
        await this.storage.rename(p.execution.tempPath,p.execution.targetPath);
      }));
      const failed=effects.find((r):r is PromiseRejectedResult=>r.status==='rejected');if(failed)throw failed.reason;
    })()]);
    const failed=physical.find((r):r is PromiseRejectedResult=>r.status==='rejected');
    if(failed){
      for(const [n,e]of group.entries())try{e.resolve(await this.#publicationFailure(requiredValue(claimed[n]),proof,failed.reason));}catch(error){e.reject(error);}
      return;
    }
    // Select the qualified set operation before submitting SQL. Its failure or
    // ambiguous response is resolved by original status, never by blind fallback.
    // Other parents, legacy inputs and old databases keep the existing commits.
    let committed:PromiseSettledResult<PreparedCatalogUpload>[];
    try{
      const first=requiredValue(claimed[0]);
      const eligible=claimed.every(p=>p.input.intent.parentId===first.input.intent.parentId&&p.execution.before===null
        &&p.input.intent.schema==='saturn.upload-intent.v2'&&BigInt(p.input.intent.sizeBytes)>0n&&BigInt(p.input.intent.sizeBytes)<=262144n);
      const eligibleCas=claimed.length<=4&&claimed.every(p=>p.input.intent.parentId===first.input.intent.parentId&&p.execution.before!==null
        &&BigInt(p.execution.before.size_bytes)<=262144n
        &&p.input.intent.schema==='saturn.upload-intent.v2'&&BigInt(p.input.intent.sizeBytes)>0n&&BigInt(p.input.intent.sizeBytes)<=262144n);
      if(eligible&&await this.database.supportsPublicationSets()||eligibleCas&&await this.database.supportsCasPublicationSets()){
        const values=await this.database.commitSet(claimed.map((p,n)=>({prepared:p,mimeType:requiredValue(group[n]).mime})),proof);
        committed=values.map(value=>({status:'fulfilled',value}));
      }else committed=await Promise.allSettled(claimed.map((p,n)=>this.database.commit(p,proof,requiredValue(group[n]).mime)));
    }catch(reason){committed=claimed.map(()=>({status:'rejected',reason}));}
    for(const [n,e]of group.entries()){
      const result=requiredValue(committed[n]);
      if(result.status==='fulfilled')e.resolve(result.value);
      else try{e.resolve(await this.#publicationFailure(requiredValue(claimed[n]),proof,result.reason));}catch(error){e.reject(error);}
    }
  }
  async #publish(current:PreparedCatalogUpload,proof:CatalogFolderAuthority,mime:string,transfer?:CatalogUploadTransfer):Promise<PreparedCatalogUpload>{
      if(current.status.result)return current;
      if(current.execution.archivePath!==null){const directory=current.execution.archivePath.slice(0,current.execution.archivePath.lastIndexOf("/"));await ensureStorageDirectory(this.storage,directory);}
      const claimToken=randomUUID();
      try{current=await this.database.verifyAndClaim(current,proof,mime,claimToken,transfer);}catch(error){
        const accepted=await this.database.status(current,proof).catch(()=>undefined);
        if(accepted?.status.result)return accepted;
        if(accepted?.status.session.phase==="physical_pending"&&accepted.claimToken===claimToken)await this.database.markUnknown(accepted).catch(()=>undefined);
        throw error;
      }
      if(current.status.result)return current;
      if(current.claimToken!==claimToken||current.status.session.phase!=="physical_pending")throw new CatalogUploadError("reconciliation_required");
      // From this durable claim onward every failed response remains UNKNOWN unless original
      // committed receipt proves success. No path rollback, deletion, fresh key or current-resource guess.
      try{
        if(current.execution.before===null){
          if(await this.storage.exists(current.execution.targetPath))throw new CatalogUploadError("backend_preimage_mismatch");
        }else{
          if(current.execution.archivePath===null||await this.storage.exists(current.execution.archivePath))throw new CatalogUploadError("backend_preimage_mismatch");
          const beforeStat=await this.storage.stat(current.execution.targetPath);
          if(beforeStat.type!=="file"||!Number.isSafeInteger(beforeStat.size)||String(beforeStat.size)!==current.execution.before.size_bytes)throw new CatalogUploadError("backend_preimage_mismatch");
          if(!current.execution.before.content_sha256||!current.execution.before.content_version_id)throw new CatalogUploadError("backend_preimage_mismatch");
          await this.#verify(current,current.execution.targetPath,current.execution.before.size_bytes,current.execution.before.content_sha256,current.execution.before.content_version_id);
          await this.storage.rename(current.execution.targetPath,current.execution.archivePath);
        }
        await this.storage.rename(current.execution.tempPath,current.execution.targetPath);
        return await this.database.commit(current,proof,mime);
      }catch(error){
        const accepted=await this.database.status(current,proof).catch(()=>undefined);
        if(accepted?.status.result?.status==="PUBLISHED")return accepted;
        await this.database.markUnknown(current).catch(()=>undefined);
        throw new CatalogUploadError("reconciliation_required",{cause:error});
      }
  }
}
