import type { StorageAdapter } from "@saturn/storage";
import type { BrowserTreeAuthority, BrowserTreeAuthorityIssuer } from "./browser-upload-tree-authority.js";
import type {PostgresBrowserTreeDatabase} from "./browser-upload-tree-database.js";
import type {PostgresBrowserNamespaceCoordinator} from "./browser-upload-namespace-context.js";
import {createHash} from "node:crypto";

/** Required shared-runtime dependency. There is deliberately no default/no-op
 * implementation and no browser-tree production capability yet.
 * NAMESPACE_COORDINATOR_PENDING: legacy writers must join this SAME domain. */
export interface BrowserTreeNamespaceScope {
  readonly operationId: string;
  readonly backendIdentity: string;
  readonly backendGeneration: string;
  readonly rootId: string;
  readonly parentId: string;
  readonly parentPath: string;
  readonly ancestorIds: readonly string[];
  readonly name: string;
}
declare const heldNamespace: unique symbol;
export interface BrowserTreeNamespacePermit { readonly [heldNamespace]: true }
export interface BrowserTreeNamespaceCoordinator {
  /** Covers resource:<parent/ancestors>, case-normalized upload-target and
   * overlapping legacy subtree mutations/root adoption/reconfiguration.
   * Hold through ALL physical promises and final SQL/evidence recording.
   * Expiry/cancellation cannot release it while an old writer can still run. */
  run<T>(scope: BrowserTreeNamespaceScope, action: (permit: BrowserTreeNamespacePermit) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Proves the permit is still owned in the same runtime domain. A timer or
   * check-before-await is insufficient: fenced backend ownership must persist
   * through awaited IO. A process restart needs old-writer death/checkpoint. */
  assertHeld(permit: BrowserTreeNamespacePermit, scope: BrowserTreeNamespaceScope): Promise<void>;
}
export interface BrowserTreeOriginalReference { readonly treeId: string; readonly jobId: string; readonly itemId: string }
export interface BrowserTreeOriginal {
  readonly reference: BrowserTreeOriginalReference;
  readonly scope: BrowserTreeNamespaceScope;
  readonly nodeId: string;
  readonly versionId: string | null;
  readonly kind: "directory" | "file";
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly stagingPath: string;
  readonly destinationPath: string;
  readonly state: "reserved" | "materializing" | "verified" | "publishing" | "unknown" | "published";
  readonly receipt?: BrowserTreeReceipt;
}
export interface BrowserTreeReceipt {
  readonly resourceId: string;
  readonly versionId: string | null;
  readonly kind: "directory" | "file";
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly relativePath: string;
}
export interface BrowserTreeExecutionDatabase {
  /** Authenticity/current scope checked BEFORE returning original metadata. */
  inspect(original: BrowserTreeOriginalReference, proof: BrowserTreeAuthority): Promise<BrowserTreeOriginal>;
  /** Fixed adapter locks/checks current authority, exact parent and backend.
   * Stable staging/node/version IDs were reserved before this first effect. */
  beginPhysical(original: BrowserTreeOriginal, proof: BrowserTreeAuthority, permit: BrowserTreeNamespacePermit): Promise<BrowserTreeOriginal>;
  recordVerified(original: BrowserTreeOriginal, evidence: { readonly sizeBytes: number; readonly sha256: string | null }, proof: BrowserTreeAuthority, permit: BrowserTreeNamespacePermit): Promise<BrowserTreeOriginal>;
  beginPublication(original: BrowserTreeOriginal, proof: BrowserTreeAuthority, permit: BrowserTreeNamespacePermit): Promise<BrowserTreeOriginal>;
  publish(original: BrowserTreeOriginal, proof: BrowserTreeAuthority, permit: BrowserTreeNamespacePermit): Promise<BrowserTreeReceipt>;
  markUnknown(original: BrowserTreeOriginal, cause: "physical_outcome_unknown" | "publication_outcome_unknown"): Promise<void>;
}
export interface BrowserTreeExecutorDependencies {
  /** Runtime LEGACY FENCED adapter only, never a raw backend from a route. */
  readonly storage: StorageAdapter;
  readonly database: BrowserTreeExecutionDatabase;
  readonly authority: BrowserTreeAuthorityIssuer;
  readonly namespace: BrowserTreeNamespaceCoordinator;
}

/** Narrow pending shared-runtime seam. Ordinary mkdir cannot substitute for an
 * immutable task already reserved by admission. No production capability is
 * enabled until the qualified runtime supplies and proves these methods. */
interface DurableDirectoryStorage extends StorageAdapter {
 supportsMkdirOnce?():Promise<boolean>;
 mkdirOnce?(taskId:string,path:string):Promise<void>;
}
export class BrowserTreeDirectoryExecutor {
 readonly #running=new Set<string>();
 constructor(private readonly dependencies:{readonly storage:DurableDirectoryStorage;readonly database:PostgresBrowserTreeDatabase;readonly namespace:PostgresBrowserNamespaceCoordinator}){}
 async execute(input:BrowserTreeOriginalReference,proof:BrowserTreeAuthority,signal?:AbortSignal):Promise<BrowserTreeReceipt>{
  const reference=Object.freeze({...input}),key=[reference.treeId,reference.jobId,reference.itemId].join(":");
  if(this.#running.has(key))throw Error("browser_tree_original_already_running");
  this.#running.add(key);
  const {storage,database,namespace}=this.dependencies;
  let operationId:string|undefined;const execution={entered:false};
  try{
   signal?.throwIfAborted();
   const original=await database.inspectDirectory(proof,reference);operationId=original.operationId;
   if(original.state==="published"&&original.receipt)return original.receipt;
   if(original.state!=="reserved")throw Error("browser_tree_reconciliation_required");
   const mkdirOnce=storage.mkdirOnce?.bind(storage);
   if(!mkdirOnce||!await storage.supportsMkdirOnce?.())throw Error("browser_tree_directory_runtime_unsupported");
   return await namespace.run({operationId,kind:"create-folder",parentId:original.parentId,name:original.name},async()=>{
    execution.entered=true;signal?.throwIfAborted();
    const current=await database.beginDirectory(proof,reference,original.operationId);
    signal?.throwIfAborted();
    await mkdirOnce(current.publishTaskId,current.destinationPath);
    // A physical mkdir may already have succeeded. Cancellation does not skip
    // recording its authorized result or invent a compensating deletion.
    try{return await database.publishDirectory(proof,reference,original.operationId);}
    catch(error){
     const observed=await database.inspectDirectory(proof,reference).catch(()=>undefined);
     if(observed?.state==="published"&&observed.operationId===original.operationId&&observed.resourceId===original.resourceId&&observed.receipt)return observed.receipt;
     throw error;
    }
   },signal);
  }catch(error){
   if(execution.entered&&operationId)await database.markExecutionUnknown(reference,operationId).catch(()=>undefined);
   throw error;
  }finally{this.#running.delete(key);}
 }
}

/** Full small-file creation under the fixed namespace/authority boundary. A
 * directory/file job runner must keep this bounded; large streaming uploads
 * use their own durable protocol rather than materializing large buffers. */
export class BrowserTreeFileExecutor {
 readonly #running=new Set<string>();
 constructor(private readonly dependencies:{readonly storage:StorageAdapter;readonly database:PostgresBrowserTreeDatabase;readonly namespace:PostgresBrowserNamespaceCoordinator}){}
 async #readback(path:string,sizeBytes:number,sha256:string,signal?:AbortSignal):Promise<{sizeBytes:number;sha256:string}>{
  const {storage}=this.dependencies,info=await storage.stat(path);
  if(info.type!=="file"||info.size!==sizeBytes)throw Error("browser_tree_verification_failed");
  const stream=await storage.openRead(path,signal===undefined?{}:{signal}),hash=createHash("sha256");let count=0;
  try{
   if(!stream.storageClosed)throw Error("browser_tree_read_closure_unavailable");
   for await(const part of stream){signal?.throwIfAborted();const bytes=Buffer.isBuffer(part)?part:Buffer.from(part as Uint8Array);count+=bytes.length;if(count>sizeBytes)throw Error("browser_tree_verification_failed");hash.update(bytes);}
  }finally{stream.destroy();if(stream.storageClosed)await stream.storageClosed;}
  const actual=hash.digest("hex");if(count!==sizeBytes||actual!==sha256)throw Error("browser_tree_verification_failed");
  return {sizeBytes:count,sha256:actual};
 }
 async execute(input:BrowserTreeOriginalReference,proof:BrowserTreeAuthority,signal?:AbortSignal):Promise<BrowserTreeReceipt>{
  const reference=Object.freeze({...input}),key=[reference.treeId,reference.jobId,reference.itemId].join(":");
  if(this.#running.has(key))throw Error("browser_tree_original_already_running");this.#running.add(key);
  const {storage,database,namespace}=this.dependencies;const execution={entered:false};let operationId:string|undefined;
  try{
   signal?.throwIfAborted();const original=await database.inspectFile(proof,reference);operationId=original.operationId;
   if(original.state==="published"&&original.receipt)return original.receipt;
   if(original.state!=="reserved")throw Error("browser_tree_reconciliation_required");
   const renameGroupOnce=storage.renameGroupOnce?.bind(storage),writeOnce=storage.writeOnce?.bind(storage),writeVerifiedOnce=storage.writeVerifiedOnce?.bind(storage);
   if(!renameGroupOnce||!await storage.supportsRenameGroupOnce?.())throw Error("browser_tree_file_runtime_unsupported");
   const verifiedWrite=original.sizeBytes>0&&writeVerifiedOnce!==undefined&&await storage.supportsWriteVerifiedOnce?.()===true?writeVerifiedOnce:undefined;
   if(!verifiedWrite&&(!writeOnce||!await storage.supportsWriteOnce?.()))throw Error("browser_tree_file_runtime_unsupported");
   return await namespace.run({operationId,kind:"file-publication",parentId:original.parentId,name:original.name},async()=>{
    execution.entered=true;signal?.throwIfAborted();const current=await database.beginFile(proof,reference,original.operationId);
    // The held namespace excludes catalog/backend peers. Refuse any untracked
    // existing destination instead of overwriting a physical orphan.
    if(await storage.exists(current.destinationPath))throw Error("browser_tree_physical_target_exists");
    if(!current.content||current.content.length!==current.sizeBytes)throw Error("browser_tree_original_invalid");
    signal?.throwIfAborted();let evidence:{sizeBytes:number;sha256:string};
    if(verifiedWrite){
     const receipt=await verifiedWrite(current.writeTaskId,current.stagingPath,current.content);
     if(receipt.sizeBytes!==String(current.sizeBytes)||receipt.sha256!==current.sha256)throw Error("browser_tree_verification_failed");
     evidence={sizeBytes:current.sizeBytes,sha256:receipt.sha256};
    }else{
     if(!writeOnce)throw Error("browser_tree_file_runtime_unsupported");
     if(await writeOnce(current.writeTaskId,current.stagingPath,current.content,{offset:0,create:true,exclusive:true,truncate:false})!==current.sizeBytes)throw Error("browser_tree_verification_failed");
     evidence=await this.#readback(current.stagingPath,current.sizeBytes,current.sha256,signal);
    }
    signal?.throwIfAborted();await database.recordFileVerified(proof,reference,original.operationId,evidence);
    const publishing=await database.beginFilePublication(proof,reference,original.operationId);signal?.throwIfAborted();
    await renameGroupOnce(publishing.publishTaskId,[{operationId:publishing.operationId,source:publishing.stagingPath,destination:publishing.destinationPath}]);
    try{return await database.publishFile(proof,reference,original.operationId);}
    catch(error){const observed=await database.inspectFile(proof,reference).catch(()=>undefined);if(observed?.state==="published"&&observed.operationId===original.operationId&&observed.resourceId===original.resourceId&&observed.versionId===original.versionId&&observed.receipt)return observed.receipt;throw error;}
   },signal);
  }catch(error){if(execution.entered&&operationId)await database.markExecutionUnknown(reference,operationId).catch(()=>undefined);throw error;}
  finally{this.#running.delete(key);}
 }
}
