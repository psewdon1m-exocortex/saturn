import {createHash,randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {lstat,mkdir,open,unlink,type FileHandle} from "node:fs/promises";
import path from "node:path";
// Node declarations expose a number, but Windows omits this POSIX flag.
const optionalNoFollow: unknown = Reflect.get(constants, "O_NOFOLLOW");
const noFollowFlag = typeof optionalNoFollow === "number" ? optionalNoFollow : 0;
import {BROWSER_TREE_STREAM_LIMITS} from "./browser-upload-tree-stream-contract.js";
import {withBrowserTreeSpoolCustody,type BrowserTreeSpoolHandleCustody} from "./browser-upload-tree-stream-custody.js";

export interface BrowserTreeSpoolIdentity {readonly dev:string;readonly ino:string}
export interface BrowserTreeSpoolChunk {
 readonly spoolId:string;readonly operationId:string;readonly writeTaskId:string;
 readonly offset:number;readonly length:number;readonly sha256:string;
 readonly identity:BrowserTreeSpoolIdentity|null;
}
export interface BrowserTreeSpoolRemoval {readonly disposition:"removed"|"absent";readonly identity:BrowserTreeSpoolIdentity|null;readonly removedBytes:number}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const equal=(a:BrowserTreeSpoolIdentity,b:BrowserTreeSpoolIdentity)=>a.dev===b.dev&&a.ino===b.ino;
const identity=(s:{dev:bigint;ino:bigint}):BrowserTreeSpoolIdentity=>Object.freeze({dev:String(s.dev),ino:String(s.ino)});

/** A private, exclusively managed service directory is REQUIRED. These checks
 * reject links/changed originals; they do not establish Windows ancestor custody
 * against another process allowed to rename the service's directory tree.
 * The fixed receiver must hold the cross-process original lock for each call.
 * A separate persistent per-chunk marker prevents physical cleanup after that
 * PG session is lost while an old file descriptor is still active. */
export class BrowserTreeStreamSpool {
 readonly #root:string;#rootIdentity:BrowserTreeSpoolIdentity|undefined;
 constructor(root:string,readonly spoolId:string){
  if(!path.isAbsolute(root)||!uuid.test(spoolId))throw Error("browser_tree_spool_configuration_invalid");this.#root=path.resolve(root);
 }
 async initialize():Promise<void>{
  await mkdir(this.#root,{recursive:true,mode:0o700});const root=await lstat(this.#root,{bigint:true});
  if(!root.isDirectory()||root.isSymbolicLink())throw Error("browser_tree_spool_root_invalid");
  const expected=identity(root);if(this.#rootIdentity&&!equal(this.#rootIdentity,expected))throw Error("browser_tree_spool_root_changed");
  this.#rootIdentity=expected;
  const marker=path.join(this.#root,"spool.identity"),content=Buffer.from("saturn.browser-tree-spool.v1\n"+this.spoolId+"\n");
  let file:FileHandle;
  try{file=await open(marker,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|noFollowFlag,0o600);}
  catch(error){if(!(error instanceof Error)||!("code"in error)||error.code!=="EEXIST")throw error;file=await this.#openPrivate(marker,constants.O_RDWR);}
  try{
   const stats=await file.stat();if(stats.size===0){await file.writeFile(content);await file.sync();}
   else if(stats.size!==content.length||!(await file.readFile()).equals(content))throw Error("browser_tree_spool_binding_changed");
  }finally{await file.close();}
  await this.#syncDirectory();await this.#checkRoot();
 }
 async #checkRoot():Promise<void>{
  const value=await lstat(this.#root,{bigint:true});
  if(!this.#rootIdentity||!value.isDirectory()||value.isSymbolicLink()||!equal(identity(value),this.#rootIdentity))throw Error("browser_tree_spool_root_changed");
 }
 #path(chunk:BrowserTreeSpoolChunk):string{
  if(chunk.spoolId!==this.spoolId||![chunk.operationId,chunk.writeTaskId].every(v=>uuid.test(v))||!Number.isSafeInteger(chunk.offset)||chunk.offset<0
   ||chunk.offset%BROWSER_TREE_STREAM_LIMITS.chunkBytes!==0||!Number.isSafeInteger(chunk.length)||chunk.length<1||chunk.length>BROWSER_TREE_STREAM_LIMITS.chunkBytes
   ||!/^[a-f0-9]{64}$/.test(chunk.sha256)||chunk.identity!==null&&(!/^\d+$/.test(chunk.identity.dev)||!/^\d+$/.test(chunk.identity.ino)))throw Error("browser_tree_spool_chunk_invalid");
  return path.join(this.#root,chunk.operationId+"-"+chunk.writeTaskId+".chunk");
 }
 async #openPrivate(filename:string,flags:number,expected?:BrowserTreeSpoolIdentity,custody?:BrowserTreeSpoolHandleCustody):Promise<FileHandle>{
  const before=await lstat(filename,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||expected&&!equal(identity(before),expected))throw Error("browser_tree_spool_identity_changed");
  const start=()=>open(filename,flags|noFollowFlag),file=custody?await custody.open(start):await start();
  try{
   const opened=await file.stat({bigint:true}),current=await lstat(filename,{bigint:true});
   if(!opened.isFile()||opened.nlink!==1n||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n
    ||!equal(identity(opened),identity(before))||!equal(identity(opened),identity(current)))throw Error("browser_tree_spool_identity_changed");
   return file;
  }catch(error){await this.#close(file,custody);throw error;}
 }
 async #close(file:FileHandle,custody?:BrowserTreeSpoolHandleCustody):Promise<void>{
  if(custody)await custody.close(file);else await file.close();
 }
 async #checkFile(filename:string,file:FileHandle,expected:BrowserTreeSpoolIdentity,size?:number):Promise<void>{
  const actual=await file.stat({bigint:true}),current=await lstat(filename,{bigint:true});
  if(!actual.isFile()||actual.nlink!==1n||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n||!equal(identity(actual),expected)
   ||!equal(identity(current),expected)||size!==undefined&&actual.size!==BigInt(size))throw Error("browser_tree_spool_identity_changed");
  await this.#checkRoot();
 }
 async #syncDirectory():Promise<void>{
  // Node/Windows has no directory fsync. Do not claim host power-loss durability.
  if(process.platform==="win32")return;const directory=await open(this.#root,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
 }
 async #assertAbsent(filename:string):Promise<void>{
  try{await lstat(filename);throw Error("browser_tree_spool_cleanup_reappeared");}
  catch(error){if(!(error instanceof Error)||!("code"in error)||error.code!=="ENOENT")throw error;}
 }
 async #acquireCustody(filename:string,chunk:BrowserTreeSpoolChunk):Promise<{release():Promise<void>}>{
  await this.#checkRoot();
  const marker=filename+".custody",bytes=Buffer.from(JSON.stringify({schema:"saturn.browser-tree-spool-custody.v1",spoolId:this.spoolId,
   operationId:chunk.operationId,writeTaskId:chunk.writeTaskId,nonce:randomUUID(),root:this.#rootIdentity}));
  let file:FileHandle;
  try{file=await open(marker,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|noFollowFlag,0o600);}
  catch(error){if(error instanceof Error&&"code"in error&&error.code==="EEXIST")throw Error("browser_tree_spool_custody_retained");throw error;}
  let bound:BrowserTreeSpoolIdentity;
  // Failed acquisition deliberately leaves the marker. No data handle opens
  // before its identity has been synced and its own CLOSE has succeeded.
  try{
   bound=identity(await file.stat({bigint:true}));await this.#checkFile(marker,file,bound,0);
   await file.writeFile(bytes);await file.sync();await this.#checkFile(marker,file,bound,bytes.length);
  }finally{await file.close();}
  await this.#syncDirectory();await this.#checkRoot();
  return {release:async()=>{
   const held=await this.#openPrivate(marker,constants.O_RDONLY,bound);
   try{
    await this.#checkFile(marker,held,bound,bytes.length);const actual=Buffer.alloc(bytes.length);
    const read=await held.read(actual,0,actual.length,0);
    if(read.bytesRead!==actual.length||!actual.equals(bytes))throw Error("browser_tree_spool_custody_changed");
    await this.#checkFile(marker,held,bound,bytes.length);
   }finally{await held.close();}
   await this.#checkRoot();
   const current=await lstat(marker,{bigint:true});
   if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1n||!equal(identity(current),bound))throw Error("browser_tree_spool_custody_changed");
   await unlink(marker);await this.#syncDirectory();await this.#checkRoot();await this.#assertAbsent(marker);
  }};
 }
 /** Persist the inode binding before any nonempty write. A lost binding reply
  * leaves an empty original; a lost receipt leaves the same completed bytes.
  * Matching partial prefixes resume by appending ONLY their missing suffix. */
 async writeChunk(input:BrowserTreeSpoolChunk,content:Uint8Array,bind:(value:BrowserTreeSpoolIdentity)=>Promise<void>,signal?:AbortSignal):Promise<{readonly identity:BrowserTreeSpoolIdentity;readonly bytes:number;readonly sha256:string}>{
  const chunk=Object.freeze({...input,identity:input.identity===null?null:Object.freeze({...input.identity})}),filename=this.#path(chunk);
  signal?.throwIfAborted();if(content.byteLength!==chunk.length)throw Error("browser_tree_stream_chunk_mismatch");
  const bytes=Buffer.from(content);if(createHash("sha256").update(bytes).digest("hex")!==chunk.sha256)throw Error("browser_tree_stream_chunk_mismatch");
  return withBrowserTreeSpoolCustody(()=>this.#acquireCustody(filename,chunk),async custody=>{
  signal?.throwIfAborted();
  await this.#checkRoot();let file:FileHandle;
  if(chunk.identity===null){
   try{file=await custody.open(()=>open(filename,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|noFollowFlag,0o600));}
   catch(error){if(!(error instanceof Error)||!("code"in error)||error.code!=="EEXIST")throw error;file=await this.#openPrivate(filename,constants.O_RDWR,undefined,custody);}
  }else file=await this.#openPrivate(filename,constants.O_RDWR,chunk.identity,custody);
  let bound:BrowserTreeSpoolIdentity;
  try{
   const initial=await file.stat({bigint:true});bound=identity(initial);
   await this.#checkFile(filename,file,bound);
   if(initial.size>BigInt(chunk.length)||chunk.identity===null&&initial.size!==0n)throw Error("browser_tree_spool_untracked_tail");
   if(chunk.identity===null){await file.sync();await this.#syncDirectory();}
   // Recheck current DB authority inside physical exclusion, INCLUDING a bound
   // prefix: a descriptor reserved before cancellation must not write later.
   await bind(bound);signal?.throwIfAborted();await this.#checkFile(filename,file,bound,Number(initial.size));
   const scratch=Buffer.allocUnsafe(Math.min(chunk.length,65536));let cursor=0;
   while(cursor<Number(initial.size)){
    signal?.throwIfAborted();const length=Math.min(scratch.length,Number(initial.size)-cursor),read=await file.read(scratch,0,length,cursor);
    if(read.bytesRead!==length||!scratch.subarray(0,length).equals(bytes.subarray(cursor,cursor+length)))throw Error("browser_tree_spool_prefix_mismatch");cursor+=length;
   }
   while(cursor<bytes.length){signal?.throwIfAborted();const written=await file.write(bytes,cursor,Math.min(65536,bytes.length-cursor),cursor);if(written.bytesWritten<1)throw Error("browser_tree_spool_no_progress");cursor+=written.bytesWritten;}
   await file.sync();await this.#checkFile(filename,file,bound,chunk.length);
   const sha=createHash("sha256");cursor=0;
   while(cursor<chunk.length){signal?.throwIfAborted();const length=Math.min(scratch.length,chunk.length-cursor),read=await file.read(scratch,0,length,cursor);if(read.bytesRead!==length)throw Error("browser_tree_spool_incomplete");sha.update(scratch.subarray(0,length));cursor+=length;}
   if(sha.digest("hex")!==chunk.sha256)throw Error("browser_tree_spool_checksum_mismatch");
  }finally{await custody.close(file);}
  await this.#checkRoot();return Object.freeze({identity:bound,bytes:chunk.length,sha256:chunk.sha256});
  });
 }
 async readChunk(input:BrowserTreeSpoolChunk,signal?:AbortSignal):Promise<Buffer>{
  const chunk=Object.freeze({...input,identity:input.identity===null?null:Object.freeze({...input.identity})});
  const filename=this.#path(chunk);if(!chunk.identity)throw Error("browser_tree_spool_identity_missing");signal?.throwIfAborted();await this.#checkRoot();
  const bound=chunk.identity;
  return withBrowserTreeSpoolCustody(()=>this.#acquireCustody(filename,chunk),async custody=>{
  signal?.throwIfAborted();
  const bytes=Buffer.allocUnsafe(chunk.length),file=await this.#openPrivate(filename,constants.O_RDONLY,bound,custody);
  try{
   await this.#checkFile(filename,file,bound,chunk.length);let cursor=0;
   while(cursor<bytes.length){signal?.throwIfAborted();const read=await file.read(bytes,cursor,Math.min(65536,bytes.length-cursor),cursor);if(read.bytesRead<1)throw Error("browser_tree_spool_incomplete");cursor+=read.bytesRead;}
   await this.#checkFile(filename,file,bound,chunk.length);if(createHash("sha256").update(bytes).digest("hex")!==chunk.sha256)throw Error("browser_tree_spool_checksum_mismatch");
  }finally{await custody.close(file);}
  await this.#checkRoot();return bytes;
  });
 }
 /** Only a fixed cleanup worker may call this, after its durable original is
  * terminal and while holding the SAME cross-process lock as the receiver.
  * Exclusive service-directory custody is required through unlink and close.
  * An unbound nonempty file or a different inode is never removed. */
 async removeChunk(input:BrowserTreeSpoolChunk,signal?:AbortSignal):Promise<BrowserTreeSpoolRemoval>{
  const chunk=Object.freeze({...input,identity:input.identity===null?null:Object.freeze({...input.identity})}),filename=this.#path(chunk);
  signal?.throwIfAborted();await this.#checkRoot();
  return withBrowserTreeSpoolCustody(()=>this.#acquireCustody(filename,chunk),async custody=>{
  signal?.throwIfAborted();
  try{await lstat(filename);}
  catch(error){
   if(!(error instanceof Error)||!("code"in error)||error.code!=="ENOENT")throw error;
   await this.#syncDirectory();await this.#checkRoot();await this.#assertAbsent(filename);return Object.freeze({disposition:"absent",identity:chunk.identity,removedBytes:0});
  }
  const file=await this.#openPrivate(filename,constants.O_RDONLY,chunk.identity??undefined,custody);
  let removed:BrowserTreeSpoolRemoval;
  try{
   const stats=await file.stat({bigint:true}),bound=identity(stats);
   if(stats.size>BigInt(chunk.length)||chunk.identity===null&&stats.size!==0n)throw Error("browser_tree_spool_untracked_tail");
   signal?.throwIfAborted();await this.#checkFile(filename,file,bound,Number(stats.size));
   await unlink(filename);await this.#syncDirectory();
   removed=Object.freeze({disposition:"removed",identity:bound,removedBytes:Number(stats.size)});
  }finally{await custody.close(file);}
  await this.#checkRoot();
  await this.#assertAbsent(filename);
  return removed;
  });
 }
}
