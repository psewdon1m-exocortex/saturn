import { requireTestValue } from "../../contracts/src/test-support.js";
import {createHash,randomUUID} from "node:crypto";
import {mkdir,mkdtemp,readFile,readdir,lstat,open,rm,link,symlink} from "node:fs/promises";
import path from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {BrowserTreeStreamSpool,type BrowserTreeSpoolChunk,type BrowserTreeSpoolIdentity} from "./browser-upload-tree-stream-spool.js";
const parent=path.resolve(process.cwd(),".tmp/browser-tree-spool-tests"),roots:string[]=[];
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
afterEach(async()=>{for(const root of roots.splice(0)){if(path.dirname(root)!==parent||!path.basename(root).startsWith("owned-")||(await lstat(root)).isSymbolicLink())throw Error("Test cleanup ownership mismatch");await rm(root,{recursive:true});}});
async function fixture(){
 await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,"owned-"));roots.push(root);
 const spoolId=randomUUID(),spool=new BrowserTreeStreamSpool(root,spoolId);await spool.initialize();
 const bytes=Buffer.from("an immutable bounded chunk"),chunk:BrowserTreeSpoolChunk={spoolId,operationId:randomUUID(),writeTaskId:randomUUID(),offset:0,length:bytes.length,sha256:sha(bytes),identity:null};
 const filename=path.join(root,chunk.operationId+"-"+chunk.writeTaskId+".chunk");return {root,spoolId,spool,bytes,chunk,filename};
}
describe("browser tree private stream spool",()=>{
 it("binds an empty original before bytes, fsyncs/closes, and reopens the same identity",async()=>{
  const f=await fixture();let bound:BrowserTreeSpoolIdentity|undefined;
  const receipt=await f.spool.writeChunk(f.chunk,f.bytes,async value=>{expect((await lstat(f.filename)).size).toBe(0);bound=value;});
  expect(receipt.identity).toEqual(bound);expect(receipt.sha256).toBe(sha(f.bytes));
  const restarted=new BrowserTreeStreamSpool(f.root,f.spoolId);await restarted.initialize();
  await expect(restarted.readChunk({...f.chunk,identity:requireTestValue(bound)})).resolves.toEqual(f.bytes);
  await expect(restarted.writeChunk({...f.chunk,identity:requireTestValue(bound)},f.bytes,async()=>undefined)).resolves.toEqual(receipt);
 });
 it("retains the empty file after lost binding reply and does not create a replacement",async()=>{
  const f=await fixture();let bound:BrowserTreeSpoolIdentity|undefined;
  await expect(f.spool.writeChunk(f.chunk,f.bytes,async value=>{bound=value;throw Error("binding reply lost");})).rejects.toThrow("lost");
  expect((await readFile(f.filename)).length).toBe(0);expect((await readdir(f.root)).length).toBe(2);
  await f.spool.writeChunk({...f.chunk,identity:requireTestValue(bound)},f.bytes,async()=>undefined);expect(await readFile(f.filename)).toEqual(f.bytes);
 });
 it("recovers only a matching prefix and retains mismatched or unexpected tails",async()=>{
  const f=await fixture();let bound:BrowserTreeSpoolIdentity|undefined;
  await expect(f.spool.writeChunk(f.chunk,f.bytes,async value=>{bound=value;throw Error("stop");})).rejects.toThrow("stop");
  const partial=await open(f.filename,"r+");try{await partial.write(f.bytes.subarray(0,7));await partial.sync();}finally{await partial.close();}
  const descriptor={...f.chunk,identity:requireTestValue(bound)};await f.spool.writeChunk(descriptor,f.bytes,async()=>undefined);expect(await readFile(f.filename)).toEqual(f.bytes);
  const changed=await open(f.filename,"r+");try{await changed.write(Buffer.from("X"),0,1,0);await changed.sync();}finally{await changed.close();}
  const before=await readFile(f.filename);await expect(f.spool.writeChunk(descriptor,f.bytes,async()=>undefined)).rejects.toThrow("prefix_mismatch");expect(await readFile(f.filename)).toEqual(before);
  const tail=await open(f.filename,"a");try{await tail.write(Buffer.from("extra"));await tail.sync();}finally{await tail.close();}
  const withTail=await readFile(f.filename);await expect(f.spool.writeChunk(descriptor,f.bytes,async()=>undefined)).rejects.toThrow("untracked_tail");expect(await readFile(f.filename)).toEqual(withTail);
 });
 it("refuses nonempty unbound data, changed inode and missing bound original",async()=>{
  const f=await fixture(),first=await f.spool.writeChunk(f.chunk,f.bytes,async()=>undefined);
  await expect(f.spool.writeChunk(f.chunk,f.bytes,async()=>undefined)).rejects.toThrow("untracked_tail");
  await expect(f.spool.readChunk({...f.chunk,identity:{...first.identity,ino:String(BigInt(first.identity.ino)+1n)}})).rejects.toThrow("identity_changed");
  const before=await readFile(f.filename);expect(before).toEqual(f.bytes);
  await expect(f.spool.writeChunk({...f.chunk,writeTaskId:randomUUID(),identity:first.identity},f.bytes,async()=>undefined)).rejects.toMatchObject({code:"ENOENT"});
  expect((await readdir(f.root)).length).toBe(2);
 });
 it("refuses hardlinks without touching linked bytes",async()=>{
  const f=await fixture(),first=await f.spool.writeChunk(f.chunk,f.bytes,async()=>undefined),alias=path.join(f.root,"linked.copy");await link(f.filename,alias);
  await expect(f.spool.readChunk({...f.chunk,identity:first.identity})).rejects.toThrow("identity_changed");expect(await readFile(alias)).toEqual(f.bytes);
 });
 it("refuses symlinks without touching linked bytes",async context=>{
  const f=await fixture();await f.spool.writeChunk(f.chunk,f.bytes,async()=>undefined);
  const target={...f.chunk,writeTaskId:randomUUID()},linked=path.join(f.root,target.operationId+"-"+target.writeTaskId+".chunk");
  try{await symlink(f.filename,linked,"file");}catch(error){if(process.platform!=="win32"||!(error instanceof Error)||!("code"in error)||error.code!=="EPERM")throw error;context.skip(true,"Windows did not permit creating the symlink fixture");return;}
  await expect(f.spool.writeChunk(target,f.bytes,async()=>undefined)).rejects.toThrow("identity_changed");expect(await readFile(f.filename)).toEqual(f.bytes);
  await expect(f.spool.removeChunk(target)).rejects.toThrow("identity_changed");expect(await readFile(f.filename)).toEqual(f.bytes);
 });
 it("refuses bad bytes/paths and abort before creating a chunk",async()=>{
  const f=await fixture(),bind=vi.fn();await expect(f.spool.writeChunk({...f.chunk,operationId:"../escape"},f.bytes,bind)).rejects.toThrow("invalid");
  await expect(f.spool.writeChunk({...f.chunk,sha256:"0".repeat(64)},f.bytes,bind)).rejects.toThrow("mismatch");
  const abort=new AbortController();abort.abort(Error("cancelled"));await expect(f.spool.writeChunk(f.chunk,f.bytes,bind,abort.signal)).rejects.toThrow("cancelled");
  expect(bind).not.toHaveBeenCalled();expect(await readdir(f.root)).toEqual(["spool.identity"]);
 });
 it("keeps an empty bound original after cancellation while binding settles",async()=>{
  const f=await fixture(),abort=new AbortController();let bound:BrowserTreeSpoolIdentity|undefined;
  await expect(f.spool.writeChunk(f.chunk,f.bytes,async value=>{bound=value;abort.abort(Error("cancelled"));},abort.signal)).rejects.toThrow("cancelled");
  expect((await lstat(f.filename)).size).toBe(0);await f.spool.writeChunk({...f.chunk,identity:requireTestValue(bound)},f.bytes,async()=>undefined);expect(await readFile(f.filename)).toEqual(f.bytes);
 });
 it("checks the spool binding again after a new service instance starts",async()=>{
  const f=await fixture();await expect(new BrowserTreeStreamSpool(f.root,randomUUID()).initialize()).rejects.toThrow("binding_changed");expect((await readdir(f.root)).length).toBe(1);
 });
 it("removes only the exact closed chunk and replays its absence without replacing it",async()=>{
  const f=await fixture(),written=await f.spool.writeChunk(f.chunk,f.bytes,async()=>undefined),chunk={...f.chunk,identity:written.identity};
  expect(await f.spool.removeChunk(chunk)).toEqual({disposition:"removed",identity:written.identity,removedBytes:f.bytes.length});await expect(lstat(f.filename)).rejects.toMatchObject({code:"ENOENT"});
  expect(await f.spool.removeChunk(chunk)).toEqual({disposition:"absent",identity:written.identity,removedBytes:0});expect(await readdir(f.root)).toEqual(["spool.identity"]);
 });
 it("retains changed inodes, hardlinks and unbound nonempty originals during cleanup",async()=>{
  const f=await fixture(),written=await f.spool.writeChunk(f.chunk,f.bytes,async()=>undefined);
  await expect(f.spool.removeChunk({...f.chunk,identity:{dev:written.identity.dev,ino:String(BigInt(written.identity.ino)+1n)}})).rejects.toThrow("identity_changed");
  await expect(f.spool.removeChunk(f.chunk)).rejects.toThrow("untracked_tail");expect(await readFile(f.filename)).toEqual(f.bytes);
  const alias=path.join(f.root,"retained-copy");await link(f.filename,alias);await expect(f.spool.removeChunk({...f.chunk,identity:written.identity})).rejects.toThrow("identity_changed");expect(await readFile(alias)).toEqual(f.bytes);
 });
 it("cleans an unbound empty original but preserves a bound file with an untracked tail",async()=>{
  const f=await fixture();await expect(f.spool.writeChunk(f.chunk,f.bytes,async()=>{throw Error("before binding");})).rejects.toThrow("before binding");
  expect(await f.spool.removeChunk(f.chunk)).toMatchObject({disposition:"removed",removedBytes:0});
  const written=await f.spool.writeChunk(f.chunk,f.bytes,async()=>undefined),tail=await open(f.filename,"a");try{await tail.write(Buffer.from("untracked"));await tail.sync();}finally{await tail.close();}
  await expect(f.spool.removeChunk({...f.chunk,identity:written.identity})).rejects.toThrow("untracked_tail");expect(await readFile(f.filename)).toEqual(Buffer.concat([f.bytes,Buffer.from("untracked")]));
 });
 it("refuses a different spool and an already cancelled cleanup before deleting bytes",async()=>{
  const f=await fixture(),written=await f.spool.writeChunk(f.chunk,f.bytes,async()=>undefined),chunk={...f.chunk,identity:written.identity};
  await expect(f.spool.removeChunk({...chunk,spoolId:randomUUID()})).rejects.toThrow("chunk_invalid");const abort=new AbortController();abort.abort(Error("stopped"));await expect(f.spool.removeChunk(chunk,abort.signal)).rejects.toThrow("stopped");expect(await readFile(f.filename)).toEqual(f.bytes);
 });
 it("excludes cleanup and a second writer while the first physical descriptor remains open",async()=>{
  const f=await fixture(),other=new BrowserTreeStreamSpool(f.root,f.spoolId);await other.initialize();
  let release!:()=>void,entered!:()=>void,bound!:BrowserTreeSpoolIdentity;
  const wait=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  const writing=f.spool.writeChunk(f.chunk,f.bytes,async value=>{bound=value;entered();await wait;});
  // Observe rejection immediately as well as in finally, so a failed assertion
  // cannot leave an unhandled writer or let test cleanup race its open FD.
  void writing.catch(()=>undefined);
  try{
   await Promise.race([ready,writing.then(()=>{throw Error("writer finished before binding barrier");})]);
   const descriptor={...f.chunk,identity:bound};
   await expect(other.removeChunk(descriptor)).rejects.toThrow("custody_retained");
   await expect(other.writeChunk(descriptor,f.bytes,async()=>undefined)).rejects.toThrow("custody_retained");
   await expect(other.readChunk(descriptor)).rejects.toThrow("custody_retained");
   expect((await lstat(f.filename)).size).toBe(0);
  }finally{release();await writing;}
  expect(await other.removeChunk({...f.chunk,identity:bound})).toMatchObject({disposition:"removed",removedBytes:f.bytes.length});
 });
 it("retains a crash marker across service restart even when the data path is absent",async()=>{
  const f=await fixture(),marker=f.filename+".custody",file=await open(marker,"wx");await file.close();
  const other=new BrowserTreeStreamSpool(f.root,f.spoolId);await other.initialize();
  const bind=vi.fn();
  await expect(other.writeChunk(f.chunk,f.bytes,bind)).rejects.toThrow("custody_retained");
  await expect(other.removeChunk(f.chunk)).rejects.toThrow("custody_retained");
  expect(bind).not.toHaveBeenCalled();await expect(lstat(f.filename)).rejects.toMatchObject({code:"ENOENT"});
  expect((await lstat(marker)).size).toBe(0);
 });
 it("revalidates an already bound prefix inside physical exclusion before writing bytes",async()=>{
  const f=await fixture();let bound!:BrowserTreeSpoolIdentity;
  await expect(f.spool.writeChunk(f.chunk,f.bytes,async value=>{bound=value;throw Error("reply lost");})).rejects.toThrow("reply lost");
  const partial=await open(f.filename,"r+");try{await partial.write(f.bytes.subarray(0,7));await partial.sync();}finally{await partial.close();}
  const bind=vi.fn(async()=>{
   expect((await lstat(f.filename+".custody")).isFile()).toBe(true);
   throw Error("original cancelled");
  });
  await expect(f.spool.writeChunk({...f.chunk,identity:bound},f.bytes,bind)).rejects.toThrow("original cancelled");
  expect(bind).toHaveBeenCalledTimes(1);expect(await readFile(f.filename)).toEqual(f.bytes.subarray(0,7));
  await expect(lstat(f.filename+".custody")).rejects.toMatchObject({code:"ENOENT"});
 });
});
