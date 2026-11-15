import { requiredValue } from "./required-value.js";
import {createHash,randomUUID} from "node:crypto";
import {CatalogCommandBatcher} from './catalog-command-batcher.js';
import type {Database} from "@saturn/database";
import {parseSyncJson,type SyncRootBinding} from '../../contracts/src/sync-protocol.js';
import {readSmallBatchPlan,type SmallBatchPlan} from './small-batch-plan.js';
import {normalizeStoragePath,validateExactStoragePath} from "@saturn/storage";
import type {CatalogFolderAuthority,CatalogFolderAuthorityIssuer} from "./catalog-folder-authority.js";
import {validateNamespaceDescriptor,type NamespaceDescriptor} from "./current-namespace.js";
import {uploadPublicationReceiptSchema} from "./upload-publication.js";
import {catalogUploadPublicationIntentHash,parseCatalogUploadPrepareInput,type CatalogUploadPrepareInput,type CatalogUploadResult,type CatalogUploadStatus} from "./catalog-upload-intent.js";

export class CatalogUploadError extends Error {
  constructor(readonly code:string,options?:ErrorOptions){super(code,options);}
}
export interface CatalogUploadExecution {
  readonly schema:"saturn.catalog-upload-execution.v1";
  readonly epoch:string;readonly bindingVersion:string;readonly guardRevision:string;readonly backendIdentity:string;
  readonly nodeId:string;readonly versionId:string;readonly tempPath:string;readonly targetPath:string;
  readonly archivePath:string|null;readonly before:NamespaceDescriptor|null;
  readonly pathTopology:readonly Readonly<{nodeId:string;storagePath:string}>[];
}
/** Private process-local execution handle. Never serialize execution paths to a protocol response. */
export interface PreparedCatalogUpload {
  readonly input:CatalogUploadPrepareInput;readonly execution:CatalogUploadExecution;readonly status:CatalogUploadStatus;
  /** Private final-slot ownership; never serialize with the public status. */
  readonly claimToken:string|null;
}
export interface CatalogUploadTransfer {readonly token:string;readonly offset:string;readonly length:string;readonly originalUploadId:string}
export interface PreparedCatalogExecutionJob {
  readonly plan:SmallBatchPlan;readonly manifestSha256:string;readonly replayed:boolean;readonly executionAdmitted:boolean;
  readonly members:readonly PreparedCatalogUpload[];
}
type Credential=Readonly<{deviceId:string;tokenHash:string;deviceKind:string}>;
interface Stored {execution:CatalogUploadExecution;claimToken:string|null;session:CatalogUploadStatus["session"];result?:CatalogUploadResult|null;replayed:boolean}
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const decimal=/^(0|[1-9]\d{0,18})$/;
const max=9223372036854775807n;
function untrustedText(value:unknown):string {if(typeof value!=="string")throw new CatalogUploadError("projection_mismatch");return value;}
function fields(value:unknown,keys:readonly string[]):void {
  if(typeof value!=="object"||value===null||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new CatalogUploadError("projection_mismatch");
}
function exactDecimal(value:unknown):asserts value is string {
  if(typeof value!=="string"||!decimal.test(value)||BigInt(value)>max)throw new CatalogUploadError("projection_mismatch");
}
/** Fixed SQL lifecycle only. Bounded four commands, no callback SQL or physical I/O under a root lock.
 * Trusted offline composition must qualify every granted fixed function before constructing this adapter. */
export class CatalogUploadDatabaseCoordinator {
  readonly #prepared=new WeakMap<object,Credential>();#active=0;
  readonly #batcher:CatalogCommandBatcher|undefined;
  #compoundAvailable:Promise<boolean>|undefined;
  #groupAvailable:Promise<boolean>|undefined;
  #replayableChunkAvailable:Promise<boolean>|undefined;
  #smallReservationAvailable:Promise<boolean>|undefined;
  #smallCompletionAvailable:Promise<boolean>|undefined;
  #publicationSetAvailable:Promise<boolean>|undefined;
  #claimSetAvailable:Promise<boolean>|undefined;
  #casPublicationAvailable:Promise<boolean>|undefined;
  #jobPublicationAvailable:Promise<boolean>|undefined;
  #jobPipelineAvailable:Promise<boolean>|undefined;
  readonly #initialTransfers=new WeakMap<PreparedCatalogUpload,CatalogUploadTransfer>();
  readonly #executionJobs=new WeakMap<PreparedCatalogUpload,{blocked:boolean;width:number}>();
  constructor(private readonly writer:Database,private readonly authority:CatalogFolderAuthorityIssuer,private readonly maximumFileBytes?:string,private readonly exactPaths=false,databaseBatches=false){
    this.#batcher=databaseBatches?new CatalogCommandBatcher(writer):undefined;
    if(maximumFileBytes!==undefined&&(!/^[1-9]\d{0,15}$/.test(maximumFileBytes)||BigInt(maximumFileBytes)>9007199254740991n))throw new CatalogUploadError("invalid_input");
  }
  async #run(command:string,input:CatalogUploadPrepareInput,credential:Credential,payload:Readonly<Record<string,unknown>>,signal?:AbortSignal):Promise<Stored> {
    if(signal?.aborted)throw new CatalogUploadError("cancelled");
    if(this.#active>=(this.#batcher?8:4))throw new CatalogUploadError("admission_full");this.#active++;
    try{
      if(this.#batcher){const value=await this.#batcher.run(command,input,credential,payload) as Stored|null|undefined;if(signal?.aborted)throw new CatalogUploadError('cancelled');if(!value||Buffer.byteLength(JSON.stringify(value))>128*1024)throw new CatalogUploadError('projection_mismatch');return value;}
      return await this.writer.transaction(async sql=>{
      await sql`SELECT set_config('statement_timeout','2s',true),set_config('lock_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)`;
      const value=(await sql<{value:Stored}[]>`SELECT public.catalog_upload_command(${command},${JSON.stringify(input)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`)[0]?.value;
      if(signal?.aborted)throw new CatalogUploadError("cancelled");if(!value||Buffer.byteLength(JSON.stringify(value))>128*1024)throw new CatalogUploadError("projection_mismatch");return value;
    });}catch(error){
      if(error instanceof CatalogUploadError)throw error;
      if(error instanceof Error&&["invalid_input","binding_invalid","authorization_changed","operation_reused","membership_changed","precondition_failed","reconciliation_required","admission_full","transfer_unresolved","verification_failed","projection_mismatch","counter_exhausted","upload_too_large","invalid_name","backend_draining","capacity"].includes(error.message))throw new CatalogUploadError(error.message,{cause:error});
      throw error;
    }finally{this.#active--;}
  }
  #seal(input:CatalogUploadPrepareInput,untrusted:unknown,credential:Credential):PreparedCatalogUpload {
    if(untrusted===null||typeof untrusted!=="object"||Array.isArray(untrusted))throw new CatalogUploadError("projection_mismatch");
    const value=untrusted as Stored;
    const e=value.execution,s=value.session,i=input.intent,h=catalogUploadPublicationIntentHash(i);
    fields(e,["schema","epoch","bindingVersion","guardRevision","backendIdentity","nodeId","versionId","tempPath","targetPath","archivePath","before","pathTopology"]);
    fields(s,["uploadId","operationId","rootId","intentHash","expectedSizeBytes","receivedSizeBytes","phase","transferPending"]);
    if(untrustedText(e.schema)!=="saturn.catalog-upload-execution.v1"||e.epoch!==input.epoch||e.bindingVersion!==input.bindingVersion||e.backendIdentity!==input.backendIdentity
      ||[e.guardRevision,e.nodeId,e.versionId,s.uploadId].some(v=>typeof v!=="string"||!uuid.test(v))||s.operationId!==s.uploadId||s.rootId!==i.rootId||s.intentHash!==h||s.expectedSizeBytes!==i.sizeBytes
      ||typeof value.replayed!=="boolean"||typeof s.transferPending!=="boolean"||!["transport","verified","physical_pending","reconciliation_required","published","not_published"].includes(s.phase))throw new CatalogUploadError("projection_mismatch");
    exactDecimal(s.expectedSizeBytes);exactDecimal(s.receivedSizeBytes);if(BigInt(s.receivedSizeBytes)>BigInt(s.expectedSizeBytes))throw new CatalogUploadError("projection_mismatch");
    if(value.claimToken!==null&&(typeof value.claimToken!=="string"||!uuid.test(value.claimToken)))throw new CatalogUploadError("projection_mismatch");
    if(["physical_pending","reconciliation_required","published"].includes(s.phase)!==(value.claimToken!==null))throw new CatalogUploadError("projection_mismatch");
    const pathCheck=this.exactPaths?validateExactStoragePath:normalizeStoragePath;
    for(const p of [e.tempPath,e.targetPath,...(e.archivePath===null?[]:[e.archivePath])])if(typeof p!=="string"||Buffer.byteLength(p)>32768||pathCheck(p)!==p)throw new CatalogUploadError("projection_mismatch");
    if(e.tempPath!==`_system/incoming/${s.uploadId}.part`)throw new CatalogUploadError("projection_mismatch");
    const untrustedTopology:unknown=e.pathTopology;
    if(!Array.isArray(untrustedTopology)||e.pathTopology.length<1||e.pathTopology.length>129)throw new CatalogUploadError("projection_mismatch");
    const pathIds=new Set<string>();for(const [n,entry]of e.pathTopology.entries()){
      fields(entry,["nodeId","storagePath"]);
      if(!uuid.test(entry.nodeId)||pathIds.has(entry.nodeId)||typeof entry.storagePath!=="string"||pathCheck(entry.storagePath)!==entry.storagePath
        ||(i.schema==="saturn.upload-intent.v2"&&entry.nodeId!==i.parentTopology[n]?.nodeId))throw new CatalogUploadError("projection_mismatch");pathIds.add(entry.nodeId);
    }
    if(e.pathTopology[0]?.nodeId!==i.parentId||e.pathTopology.at(-1)?.nodeId!==i.rootId||(i.schema==="saturn.upload-intent.v2"&&e.pathTopology.length!==i.parentTopology.length))throw new CatalogUploadError("projection_mismatch");
    if(e.before!==null){validateNamespaceDescriptor(e.before);if(e.before.node_id!==e.nodeId||e.before.type!=="file"||e.before.content_version_id!==i.expectedVersionId)throw new CatalogUploadError("projection_mismatch");}
    const result=value.result??undefined;
    if(result){
      if(untrustedText(result.schema)!=="saturn.catalog-upload-result.v2"||result.uploadId!==s.uploadId||result.operationId!==s.uploadId||result.rootId!==i.rootId||result.intentHash!==h)throw new CatalogUploadError("projection_mismatch");
      if(result.status==="PUBLISHED"){
        fields(result,["schema","status","uploadId","operationId","rootId","intentHash","publicationReceipt","publishedDescription","firstSeq","lastSeq"]);
        const receipt=uploadPublicationReceiptSchema.parse(result.publicationReceipt);validateNamespaceDescriptor(result.publishedDescription);exactDecimal(result.firstSeq);exactDecimal(result.lastSeq);
        if(s.phase!=="published"||BigInt(result.firstSeq)<1n||BigInt(result.lastSeq)<BigInt(result.firstSeq)||receipt.uploadId!==s.uploadId||receipt.intentHash!==h||receipt.rootId!==i.rootId||receipt.resourceId!==e.nodeId||receipt.versionId!==e.versionId
          ||receipt.sizeBytes!==i.sizeBytes||receipt.sha256!==i.sha256||receipt.parentId!==i.parentId||receipt.name!==i.name||result.publishedDescription.node_id!==receipt.resourceId
          ||result.publishedDescription.content_version_id!==receipt.versionId||result.publishedDescription.content_sha256!==i.sha256||result.publishedDescription.availability!=="AVAILABLE")throw new CatalogUploadError("projection_mismatch");
      }else{
        fields(result,["schema","status","uploadId","operationId","rootId","intentHash","reason"]);
        if(untrustedText(result.status)!=="NOT_PUBLISHED"||s.phase!=="not_published"||untrustedText(result.reason)!=="cancelled_before_publication")throw new CatalogUploadError("projection_mismatch");
      }
    }else if(["published","not_published"].includes(s.phase))throw new CatalogUploadError("projection_mismatch");
    const prepared=Object.freeze({input,claimToken:value.claimToken,execution:Object.freeze({...e,pathTopology:Object.freeze(e.pathTopology.map(entry=>Object.freeze({...entry}))),before:e.before===null?null:Object.freeze({...e.before})}),status:Object.freeze({session:Object.freeze({...s}),replayed:value.replayed,...(result?{result:Object.freeze(result)}:{})})});
    this.#prepared.set(prepared,credential);return prepared;
  }
  #credential(prepared:PreparedCatalogUpload,proof?:CatalogFolderAuthority):Credential {
    const credential=this.#prepared.get(prepared);if(!credential)throw new CatalogUploadError("authority_invalid");
    if(proof&&JSON.stringify(this.authority.deviceCredential(proof,prepared.input.intent.rootId))!==JSON.stringify(credential))throw new CatalogUploadError("authority_invalid");return credential;
  }
  async prepare(value:CatalogUploadPrepareInput,proof:CatalogFolderAuthority,originalUploadId?:string,signal?:AbortSignal):Promise<PreparedCatalogUpload> {
    const input=parseCatalogUploadPrepareInput(value),credential=this.authority.deviceCredential(proof,input.intent.rootId);
    if(originalUploadId!==undefined&&!uuid.test(originalUploadId))throw new CatalogUploadError("invalid_input");
    const payload={uploadId:randomUUID(),nodeId:randomUUID(),versionId:randomUUID(),...(originalUploadId===undefined?{}:{originalUploadId}),...(this.maximumFileBytes===undefined?{}:{maximumFileBytes:this.maximumFileBytes})};
    return this.#seal(input,await this.#run("reserve",input,credential,payload,signal),credential);
  }
  /** Immutable exact plan bytes are retained by the caller. Only start-job can
   * issue private one-use transfer permits; acceptance/status cannot. */
  async prepareExecutionJob(bytes:Uint8Array,binding:SyncRootBinding,proof:CatalogFolderAuthority,execute=false,readOnly=false,backendIdentity?:string,singleRequest=false):Promise<PreparedCatalogExecutionJob>{
    if(singleRequest&&(!execute||readOnly))throw new CatalogUploadError('invalid_input');
    if(!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>1048576)throw new CatalogUploadError('invalid_input');
    const snapshot=Buffer.from(bytes),plan=readSmallBatchPlan(parseSyncJson(snapshot,1048576),binding);
    if(plan.inputs.length>16)throw new CatalogUploadError('invalid_input');
    if(backendIdentity!==undefined&&plan.inputs.some(input=>input.backendIdentity!==backendIdentity))throw new CatalogUploadError('binding_invalid');
    const credential=this.authority.deviceCredential(proof,binding.root_id),manifestSha256=createHash('sha256').update(snapshot).digest('hex');
    if(this.#active>=4)throw new CatalogUploadError('admission_full');this.#active++;
    try{
      const raw=await this.writer.catalogUploadBatch(singleRequest?'execute-job':execute?'start-job':readOnly?'status-job':'accept-job',credential,{planBytes:snapshot.toString('utf8')});
      fields(raw,['schema','manifestSha256','items','replayed','executionAdmitted']);
      const value=raw as {schema:string;manifestSha256:string;items:unknown[];replayed:boolean;executionAdmitted:boolean};
      if(value.schema!=='saturn.small-execution-job.v1'||value.manifestSha256!==manifestSha256||typeof value.replayed!=='boolean'
        ||value.executionAdmitted!==execute||!Array.isArray(value.items)||value.items.length!==plan.inputs.length||Buffer.byteLength(JSON.stringify(value))>2097152)throw new CatalogUploadError('projection_mismatch');
      const context={blocked:false,width:0},ids=new Set<string>();
      const members=value.items.map((entry,n)=>{
        fields(entry,['operationId','originalUploadId','current','transfer']);
        const row=entry as {operationId:string;originalUploadId:string;current:Stored;transfer:CatalogUploadTransfer|null},input=requiredValue(plan.inputs[n]);
        const prepared=this.#seal(input,row.current,credential);
        if(row.operationId!==input.intent.idempotencyKey||row.originalUploadId!==prepared.status.session.uploadId||ids.has(row.originalUploadId))throw new CatalogUploadError('projection_mismatch');
        ids.add(row.originalUploadId);
        if(execute){
          this.#executionJobs.set(prepared,context);
          if(row.transfer!==null){
            fields(row.transfer,['token','offset','length','originalUploadId']);const t=row.transfer,s=prepared.status.session;
            exactDecimal(t.offset);exactDecimal(t.length);
            if(!uuid.test(t.token)||t.originalUploadId!==s.uploadId||s.phase!=='transport'||!s.transferPending||s.receivedSizeBytes!==t.offset
              ||BigInt(t.length)<1n||BigInt(t.offset)+BigInt(t.length)!==BigInt(s.expectedSizeBytes))throw new CatalogUploadError('projection_mismatch');
            this.#initialTransfers.set(prepared,Object.freeze({...t}));
          }else if(prepared.status.session.transferPending)throw new CatalogUploadError('projection_mismatch');
        }
        return prepared;
      });
      context.width=members.filter(p=>!p.status.result).length;
      return Object.freeze({plan,manifestSha256,replayed:value.replayed,executionAdmitted:execute,members:Object.freeze(members)});
    }catch(error){
      if(error instanceof CatalogUploadError)throw error;
      if(error instanceof Error&&['invalid_input','binding_invalid','authorization_changed','operation_reused','membership_changed','precondition_failed','reconciliation_required','admission_full','transfer_unresolved','verification_failed','projection_mismatch','upload_too_large','backend_draining','capacity','batch_missing'].includes(error.message))throw new CatalogUploadError(error.message,{cause:error});
      throw error;
    }finally{this.#active--;}
  }
  assertExecutionJobMember(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority):void{
    this.#credential(prepared,proof);const context=this.#executionJobs.get(prepared);
    if(!context)throw new CatalogUploadError('authority_invalid');if(context.blocked)throw new CatalogUploadError('reconciliation_required');
  }
  blockExecutionJob(prepared:PreparedCatalogUpload):void{const context=this.#executionJobs.get(prepared);if(context)context.blocked=true;}
  sameExecutionJob(a:PreparedCatalogUpload,b:PreparedCatalogUpload):boolean{const job=this.#executionJobs.get(a);return job!==undefined&&job===this.#executionJobs.get(b);}
  async jobPublicationWidth(prepared:PreparedCatalogUpload):Promise<number>{
    const job=this.#executionJobs.get(prepared);return job&&await this.supportsJobPublication()?Math.max(1,job.width):4;
  }
  async jobMaterializationLimit():Promise<number>{
    this.#jobPipelineAvailable??=this.writer.withSql(async sql=>(await sql<{available:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_job_pipeline_v1()') IS NOT NULL AS available`)[0]?.available===true)
      .catch((error:unknown)=>{this.#jobPipelineAvailable=undefined;throw error;});
    return await this.#jobPipelineAvailable?32:16;
  }
  supportsJobPublication():Promise<boolean>{
    return this.#jobPublicationAvailable??=this.writer.withSql(async sql=>(await sql<{available:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_job_publication_v1()') IS NOT NULL AS available`)[0]?.available===true)
      .catch((error:unknown)=>{this.#jobPublicationAvailable=undefined;throw error;});
  }
  takeExecutionJobTransfer(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority):CatalogUploadTransfer{
    this.assertExecutionJobMember(prepared,proof);const transfer=this.#initialTransfers.get(prepared);
    if(!transfer)throw new CatalogUploadError('transfer_unresolved');this.#initialTransfers.delete(prepared);return transfer;
  }
  async #command(command:string,prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority|undefined,payload:Readonly<Record<string,unknown>>={},signal?:AbortSignal):Promise<PreparedCatalogUpload> {
    const credential=this.#credential(prepared,proof),value=await this.#run(command,prepared.input,credential,{...payload,originalUploadId:prepared.status.session.uploadId},signal);return this.#seal(prepared.input,value,credential);
  }
  async prepareSmall(value:CatalogUploadPrepareInput,proof:CatalogFolderAuthority,originalUploadId?:string):Promise<PreparedCatalogUpload>{
    const input=parseCatalogUploadPrepareInput(value),credential=this.authority.deviceCredential(proof,input.intent.rootId);
    if(originalUploadId!==undefined&&!uuid.test(originalUploadId))throw new CatalogUploadError('invalid_input');
    if(BigInt(input.intent.sizeBytes)<1n||BigInt(input.intent.sizeBytes)>262144n)return this.prepare(input,proof,originalUploadId);
    this.#smallReservationAvailable??=this.writer.withSql(async sql=>(await sql<{available:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_small_reservation_v1()') IS NOT NULL AS available`)[0]?.available===true)
      .catch((error:unknown)=>{this.#smallReservationAvailable=undefined;throw error;});
    if(!await this.#smallReservationAvailable)return this.prepare(input,proof,originalUploadId);
    const payload={uploadId:randomUUID(),nodeId:randomUUID(),versionId:randomUUID(),transferToken:randomUUID(),
      ...(originalUploadId===undefined?{}:{originalUploadId}),...(this.maximumFileBytes===undefined?{}:{maximumFileBytes:this.maximumFileBytes})};
    const valueStored=await this.#run('reserve-small',input,credential,payload);
    if(Object.hasOwn(valueStored,'session'))return this.#seal(input,valueStored,credential);
    fields(valueStored,['current','transfer']);
    const {current,transfer}=valueStored as unknown as {current:Stored;transfer:CatalogUploadTransfer};
    fields(transfer,['token','offset','length','originalUploadId']);
    if(transfer.token!==payload.transferToken||transfer.originalUploadId!==payload.uploadId||transfer.offset!=='0'||transfer.length!==input.intent.sizeBytes
      ||current.session.uploadId!==payload.uploadId||current.session.phase!=='transport'||!current.session.transferPending||current.session.receivedSizeBytes!=='0')throw new CatalogUploadError('projection_mismatch');
    const prepared=this.#seal(input,current,credential);
    // Only this process's newly acknowledged reservation can skip another SQL
    // reservation once. Reconstructed/replayed handles always consult the DB.
    this.#initialTransfers.set(prepared,Object.freeze({...transfer}));return prepared;
  }
  status(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority):Promise<PreparedCatalogUpload>{return this.#command("status",prepared,proof);}
  async beginChunk(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,offset:string,length:string):Promise<CatalogUploadTransfer> {
    return (await this.startChunk(prepared,proof,offset,length)).transfer;
  }
  async startChunk(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,offset:string,length:string):Promise<{current:PreparedCatalogUpload;transfer:CatalogUploadTransfer}> {
    exactDecimal(offset);exactDecimal(length);if(BigInt(length)<1n||BigInt(length)>8388608n)throw new CatalogUploadError("invalid_input");
    const transfer=Object.freeze({token:randomUUID(),offset,length,originalUploadId:prepared.status.session.uploadId});
    const current=await this.#command("chunk",prepared,proof,transfer);return {current,transfer};
  }
  supportsReplayableChunks():Promise<boolean>{
    return this.#replayableChunkAvailable??=this.writer.withSql(async sql=>(await sql<{available:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_replayable_chunk_v1()') IS NOT NULL AS available`)[0]?.available===true)
      .catch((error:unknown)=>{this.#replayableChunkAvailable=undefined;throw error;});
  }
  async startReplayableChunk(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,offset:string,length:string):Promise<{current:PreparedCatalogUpload;transfer:CatalogUploadTransfer}>{
    exactDecimal(offset);exactDecimal(length);if(BigInt(length)<1n||BigInt(length)>4194304n)throw new CatalogUploadError('invalid_input');
    const credential=this.#credential(prepared,proof),request={token:randomUUID(),offset,length,originalUploadId:prepared.status.session.uploadId};
    const initial=this.#initialTransfers.get(prepared);
    if(initial&&initial.offset===offset&&initial.length===length){this.#initialTransfers.delete(prepared);return {current:prepared,transfer:initial};}
    const value=await this.#run('chunk-once',prepared.input,credential,request);
    // Historical terminal replay remains the ordinary sealed projection and
    // cannot authorize a write, even if the caller had an obsolete handle.
    if(Object.hasOwn(value,'session'))return {current:this.#seal(prepared.input,value,credential),transfer:request};
    fields(value,['current','transfer']);
    const envelope=value as unknown as {current:Stored;transfer:CatalogUploadTransfer};
    fields(envelope.transfer,['token','offset','length','originalUploadId']);
    const transfer=envelope.transfer;
    if(!uuid.test(transfer.token)||transfer.offset!==offset||transfer.length!==length||transfer.originalUploadId!==prepared.status.session.uploadId)throw new CatalogUploadError('projection_mismatch');
    return {current:this.#seal(prepared.input,envelope.current,credential),transfer:Object.freeze({...transfer})};
  }
  recordChunk(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,transfer:CatalogUploadTransfer):Promise<PreparedCatalogUpload>{return this.#command("progress",prepared,proof,{...transfer});}
  verify(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,mimeType:string):Promise<PreparedCatalogUpload>{return this.#command("verify",prepared,proof,{sizeBytes:prepared.input.intent.sizeBytes,sha256:prepared.input.intent.sha256,mimeType});}
  claim(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,claimToken:string):Promise<PreparedCatalogUpload>{if(!uuid.test(claimToken))throw new CatalogUploadError("invalid_input");return this.#command("claim",prepared,proof,{claimToken});}
  supportsSmallCompletion():Promise<boolean>{
    return this.#smallCompletionAvailable??=this.writer.withSql(async sql=>(await sql<{available:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_small_completion_v1()') IS NOT NULL AS available`)[0]?.available===true)
      .catch((error:unknown)=>{this.#smallCompletionAvailable=undefined;throw error;});
  }
  async verifyAndClaim(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,mimeType:string,claimToken:string,transfer?:CatalogUploadTransfer):Promise<PreparedCatalogUpload>{
    if(!uuid.test(claimToken))throw new CatalogUploadError("invalid_input");
    if(transfer){
      if(!await this.supportsSmallCompletion())throw new CatalogUploadError('binding_invalid');
      return this.#command('progress-verify-claim',prepared,proof,{sizeBytes:prepared.input.intent.sizeBytes,sha256:prepared.input.intent.sha256,mimeType,claimToken,transfer});
    }
    this.#compoundAvailable??=this.#batcher?this.writer.withSql(async sql=>(await sql<{available:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_compound_v1()') IS NOT NULL AS available`)[0]?.available===true).catch((error:unknown)=>{this.#compoundAvailable=undefined;throw error;}):Promise.resolve(false);
    if(await this.#compoundAvailable)return this.#command("verify-claim",prepared,proof,{sizeBytes:prepared.input.intent.sizeBytes,sha256:prepared.input.intent.sha256,mimeType,claimToken});
    return this.claim(await this.verify(prepared,proof,mimeType),proof,claimToken);
  }
  supportsPublicationGroups():Promise<boolean>{
    return this.#groupAvailable??=this.#batcher?this.writer.withSql(async sql=>(await sql<{available:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_publication_group_v1()') IS NOT NULL AS available`)[0]?.available===true).catch((error:unknown)=>{this.#groupAvailable=undefined;throw error;}):Promise.resolve(false);
  }
  async verifyAndClaimGroup(requests:readonly {prepared:PreparedCatalogUpload;mimeType:string;claimToken:string;transfer?:CatalogUploadTransfer}[],proof:CatalogFolderAuthority):Promise<PreparedCatalogUpload[]>{
    if(requests.length<1||requests.length>16||requests.some(r=>!uuid.test(r.claimToken)))throw new CatalogUploadError('invalid_input');
    if(requests.length>4&&(!await this.supportsJobPublication()||requests.some(r=>!this.sameExecutionJob(requiredValue(requests[0]).prepared,r.prepared))))throw new CatalogUploadError('invalid_input');
    const credential=this.#credential(requiredValue(requests[0]).prepared,proof);
    for(const r of requests)if(JSON.stringify(this.#credential(r.prepared,proof))!==JSON.stringify(credential))throw new CatalogUploadError('authority_invalid');
    if(!await this.supportsPublicationGroups())throw new CatalogUploadError('binding_invalid');
    if(requests.some(r=>r.transfer)&&!await this.supportsSmallCompletion())throw new CatalogUploadError('binding_invalid');
    const slots=Math.min(requests.length,4);
    if(this.#active+slots>8)throw new CatalogUploadError('admission_full');this.#active+=slots;
    try{
      const payload=requests.map(r=>({input:r.prepared.input,originalUploadId:r.prepared.status.session.uploadId,mimeType:r.mimeType,claimToken:r.claimToken,...(r.transfer?{transfer:r.transfer}:{})}));
      const first=requiredValue(requests[0]).prepared;
      const eligible=requests.every(({prepared:p})=>p.input.intent.schema==='saturn.upload-intent.v2'&&p.execution.before===null
        &&p.input.intent.parentId===first.input.intent.parentId&&p.input.intent.rootId===first.input.intent.rootId
        &&BigInt(p.input.intent.sizeBytes)>0n&&BigInt(p.input.intent.sizeBytes)<=262144n);
      const useSet=eligible&&await this.supportsClaimSets();
      const useCas=requests.length<=4&&requests.every(({prepared:p})=>p.execution.before!==null&&p.input.intent.schema==='saturn.upload-intent.v2'
        &&BigInt(p.execution.before.size_bytes)<=262144n
        &&p.input.intent.parentId===first.input.intent.parentId&&p.input.intent.rootId===first.input.intent.rootId
        &&BigInt(p.input.intent.sizeBytes)>0n&&BigInt(p.input.intent.sizeBytes)<=262144n)&&await this.supportsCasPublicationSets();
      const values=await this.writer.catalogUploadBatch(useCas?'claim-cas-set':useSet?'claim-set':'verify-claim-group',credential,payload);
      if(!Array.isArray(values)||values.length!==requests.length||Buffer.byteLength(JSON.stringify(values))>512*1024)throw new CatalogUploadError('projection_mismatch');
      return values.map((value,n)=>this.#seal(requiredValue(requests[n]).prepared.input,value,credential));
    }catch(error){
      if(error instanceof CatalogUploadError)throw error;
      if(error instanceof Error&&['invalid_input','binding_invalid','authorization_changed','operation_reused','membership_changed','precondition_failed','reconciliation_required','admission_full','transfer_unresolved','verification_failed','projection_mismatch','counter_exhausted','upload_too_large'].includes(error.message))throw new CatalogUploadError(error.message,{cause:error});
      throw error;
    }finally{this.#active-=slots;}
  }
  commit(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority,mimeType:string):Promise<PreparedCatalogUpload>{return this.#command("commit",prepared,proof,{mimeType});}
  supportsClaimSets():Promise<boolean>{
    return this.#claimSetAvailable??=this.#batcher?this.writer.withSql(async sql=>(await sql<{available:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_claim_set_v1(jsonb,jsonb)') IS NOT NULL AS available`)[0]?.available===true)
      .catch((error:unknown)=>{this.#claimSetAvailable=undefined;throw error;}):Promise.resolve(false);
  }
  supportsPublicationSets():Promise<boolean>{
    return this.#publicationSetAvailable??=this.#batcher?this.writer.withSql(async sql=>(await sql<{available:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_publish_set_v1(jsonb,jsonb)') IS NOT NULL AS available`)[0]?.available===true)
      .catch((error:unknown)=>{this.#publicationSetAvailable=undefined;throw error;}):Promise.resolve(false);
  }
  supportsCasPublicationSets():Promise<boolean>{
    return this.#casPublicationAvailable??=this.#batcher?this.writer.withSql(async sql=>(await sql<{available:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_cas_publication_v1()') IS NOT NULL
      AND to_regprocedure('public.catalog_upload_claim_cas_set_v1(jsonb,jsonb)') IS NOT NULL
      AND to_regprocedure('public.catalog_upload_publish_cas_set_v1(jsonb,jsonb)') IS NOT NULL AS available`)[0]?.available===true)
      .catch((error:unknown)=>{this.#casPublicationAvailable=undefined;throw error;}):Promise.resolve(false);
  }
  async commitSet(requests:readonly {prepared:PreparedCatalogUpload;mimeType:string}[],proof:CatalogFolderAuthority):Promise<PreparedCatalogUpload[]>{
    if(requests.length<1||requests.length>16||requests.length>4&&!await this.supportsJobPublication())throw new CatalogUploadError('invalid_input');
    const first=requiredValue(requests[0]).prepared,credential=this.#credential(first,proof),cas=first.execution.before!==null;
    if(cas&&requests.length>4)throw new CatalogUploadError('invalid_input');
    for(const {prepared:p} of requests){
      if(JSON.stringify(this.#credential(p,proof))!==JSON.stringify(credential))throw new CatalogUploadError('authority_invalid');
      if(p.input.intent.parentId!==first.input.intent.parentId||p.input.intent.rootId!==first.input.intent.rootId||(p.execution.before!==null)!==cas
        ||p.execution.before!==null&&BigInt(p.execution.before.size_bytes)>262144n
        ||p.input.intent.schema!=='saturn.upload-intent.v2'||BigInt(p.input.intent.sizeBytes)<1n||BigInt(p.input.intent.sizeBytes)>262144n)throw new CatalogUploadError('invalid_input');
    }
    if(!(cas?await this.supportsCasPublicationSets():await this.supportsPublicationSets()))throw new CatalogUploadError('binding_invalid');
    const slots=Math.min(requests.length,4);
    if(this.#active+slots>8)throw new CatalogUploadError('admission_full');this.#active+=slots;
    try{
      const values=await this.writer.catalogUploadBatch(cas?'publish-cas-set':'publish-set',credential,requests.map(r=>({input:r.prepared.input,originalUploadId:r.prepared.status.session.uploadId,mimeType:r.mimeType})));
      if(!Array.isArray(values)||values.length!==requests.length||Buffer.byteLength(JSON.stringify(values))>512*1024)throw new CatalogUploadError('projection_mismatch');
      return values.map((value,n)=>this.#seal(requiredValue(requests[n]).prepared.input,value,credential));
    }catch(error){
      if(error instanceof CatalogUploadError)throw error;
      if(error instanceof Error&&['invalid_input','binding_invalid','authorization_changed','operation_reused','membership_changed','precondition_failed','reconciliation_required','admission_full','verification_failed','projection_mismatch','counter_exhausted'].includes(error.message))throw new CatalogUploadError(error.message,{cause:error});
      throw error;
    }finally{this.#active-=slots;}
  }
  cancel(prepared:PreparedCatalogUpload,proof:CatalogFolderAuthority):Promise<PreparedCatalogUpload>{return this.#command("cancel",prepared,proof);}
  markUnknown(prepared:PreparedCatalogUpload):Promise<PreparedCatalogUpload>{return this.#command("unknown",prepared,undefined);}
}
