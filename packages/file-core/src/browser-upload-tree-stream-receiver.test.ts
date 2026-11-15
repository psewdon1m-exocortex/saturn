import { requireTestValue } from "../../contracts/src/test-support.js";
import {createHash,randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import type {BrowserTreeAuthority} from "./browser-upload-tree-authority.js";
import type {BrowserTreeOriginalReference} from "./browser-upload-tree-executor.js";
import type {BrowserTreeStreamOriginal,BrowserTreeStreamChunkReceipt} from "./browser-upload-tree-stream-journal.js";
import {BrowserTreeStreamReceiver} from "./browser-upload-tree-stream-receiver.js";
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const proof:BrowserTreeAuthority={proof:"saturn.browser-tree-authority.v1"};
const reference=():BrowserTreeOriginalReference=>({treeId:randomUUID(),jobId:randomUUID(),itemId:randomUUID()});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function fixture(size=262145){
 const bytes=Buffer.alloc(size,19),ref=reference(),identity={dev:"1",ino:"2"};
 let original:BrowserTreeStreamOriginal={reference:ref,operationId:randomUUID(),intentSha256:hash(Buffer.from("intent")),sizeBytes:size,sha256:hash(bytes),receivedBytes:0,state:"receiving",spoolId:randomUUID(),sealId:randomUUID(),sealSha256:null,firstWriteTaskId:randomUUID()};
 const chunks=new Map<number,BrowserTreeStreamChunkReceipt>(),physical=new Map<string,Buffer>();
 const lockGate=vi.fn(async()=>undefined);
 const journal={
  async withOriginalLock<T>(_proof:BrowserTreeAuthority,_ref:BrowserTreeOriginalReference,action:()=>Promise<T>):Promise<T>{await lockGate();return action();},
  inspect:vi.fn(async()=>original),
  reserveChunk:vi.fn(async(_proof:BrowserTreeAuthority,_ref:BrowserTreeOriginalReference,intent:{offset:number;length:number;sha256:string})=>{
   const previous=chunks.get(intent.offset);if(previous){if(previous.sha256!==intent.sha256||previous.length!==intent.length)throw Error("reused");return previous;}
   if(intent.offset!==original.receivedBytes)throw Error("offset");
   const chunk:BrowserTreeStreamChunkReceipt={...intent,spoolId:original.spoolId,operationId:original.operationId,writeTaskId:intent.offset===0?original.firstWriteTaskId:randomUUID(),identity:null,state:"reserved",confirmedOffset:original.receivedBytes};chunks.set(intent.offset,chunk);return chunk;
  }),
  bindChunk:vi.fn(async(_proof:BrowserTreeAuthority,_ref:BrowserTreeOriginalReference,taskId:string,bound:{dev:string;ino:string})=>{const c=requireTestValue([...chunks.values()].find(c=>c.writeTaskId===taskId));chunks.set(c.offset,{...c,identity:bound});}),
  recordChunk:vi.fn(async(_proof:BrowserTreeAuthority,_ref:BrowserTreeOriginalReference,taskId:string,_receipt:unknown)=>{void _receipt;const c=requireTestValue([...chunks.values()].find(c=>c.writeTaskId===taskId));chunks.set(c.offset,{...c,state:"spooled"});original={...original,receivedBytes:c.offset+c.length};return original;}),
  inspectChunk:vi.fn(async(_proof:BrowserTreeAuthority,_ref:BrowserTreeOriginalReference,offset:number)=>requireTestValue(chunks.get(offset))),
  recordSeal:vi.fn(async(_proof:BrowserTreeAuthority,_ref:BrowserTreeOriginalReference,receipt:{sealId:string;bytes:number;sha256:string})=>{if(receipt.sealId!==original.sealId||receipt.bytes!==original.sizeBytes||receipt.sha256!==original.sha256)throw Error("seal_invalid");original={...original,state:"sealed",sealSha256:receipt.sha256};return original;})
 };
 const spool={
  writeChunk:vi.fn(async(chunk:BrowserTreeStreamChunkReceipt,content:Uint8Array,bind:(value:{dev:string;ino:string})=>Promise<void>,signal?:AbortSignal)=>{await bind(identity);signal?.throwIfAborted();physical.set(chunk.writeTaskId,Buffer.from(content));return {identity,bytes:content.byteLength,sha256:hash(content)};}),
  readChunk:vi.fn(async(chunk:BrowserTreeStreamChunkReceipt)=>requireTestValue(physical.get(chunk.writeTaskId)))
 };
 const receiver=new BrowserTreeStreamReceiver(journal,spool);
 return {bytes,ref,identity,journal,spool,receiver,chunks,physical,lockGate,original:()=>original};
}
describe("browser tree bounded stream receiver",()=>{
 it("recovers a lost receipt on the same task and retained bytes",async()=>{
  const f=fixture(),record=requireTestValue(f.journal.recordChunk.getMockImplementation());f.journal.recordChunk.mockRejectedValueOnce(Error("receipt lost before commit"));
  await expect(f.receiver.append(proof,f.ref,0,hash(f.bytes),f.bytes)).rejects.toThrow("receipt lost");
  const task=requireTestValue(f.chunks.get(0)).writeTaskId;expect(f.original().receivedBytes).toBe(0);expect(f.physical.get(task)).toEqual(f.bytes);
  f.journal.recordChunk.mockImplementation(record);await expect(f.receiver.append(proof,f.ref,0,hash(f.bytes),f.bytes)).resolves.toMatchObject({receivedBytes:f.bytes.length});
  expect([...f.physical.keys()]).toEqual([task]);expect(requireTestValue(f.spool.writeChunk.mock.calls[1])[0]).toMatchObject({writeTaskId:task,identity:f.identity});
 });
 it("does not write again after a committed receipt loses its reply",async()=>{
  const f=fixture(),record=requireTestValue(f.journal.recordChunk.getMockImplementation());f.journal.recordChunk.mockImplementationOnce(async(...args)=>{await record(...args);throw Error("commit reply lost");});
  await expect(f.receiver.append(proof,f.ref,0,hash(f.bytes),f.bytes)).rejects.toThrow("lost");
  await expect(f.receiver.append(proof,f.ref,0,hash(f.bytes),f.bytes)).resolves.toMatchObject({receivedBytes:f.bytes.length});expect(f.spool.writeChunk).toHaveBeenCalledTimes(1);
  const changed=Buffer.from(f.bytes);changed[0]=1;await expect(f.receiver.append(proof,f.ref,0,hash(changed),changed)).rejects.toThrow("reused");expect(f.spool.writeChunk).toHaveBeenCalledTimes(1);
 });
 it("joins started physical work before releasing its busy slot on cancellation",async()=>{
  const f=fixture(),entered=deferred(),release=deferred(),abort=new AbortController(),write=requireTestValue(f.spool.writeChunk.getMockImplementation());
  f.spool.writeChunk.mockImplementationOnce(async(...args)=>{entered.resolve();await release.promise;return write(...args);});
  const pending=f.receiver.append(proof,f.ref,0,hash(f.bytes),f.bytes,abort.signal);const rejected=expect(pending).rejects.toThrow("cancelled");await entered.promise;abort.abort(Error("cancelled"));
  await expect(f.receiver.append(proof,f.ref,0,hash(f.bytes),f.bytes)).rejects.toThrow("busy");expect(f.journal.recordChunk).not.toHaveBeenCalled();release.resolve();await rejected;
  await expect(f.receiver.append(proof,f.ref,0,hash(f.bytes),f.bytes)).resolves.toMatchObject({receivedBytes:f.bytes.length});
 });
 it("bounds active originals to two even while waiting for cross-process locks",async()=>{
  const f=fixture(),release=deferred();let active=0;f.lockGate.mockImplementation(async()=>{active++;await release.promise;});
  const a=f.receiver.append(proof,f.ref,0,hash(f.bytes),f.bytes),b=f.receiver.append(proof,reference(),0,hash(f.bytes),f.bytes);expect(active).toBe(2);
  await expect(f.receiver.append(proof,reference(),0,hash(f.bytes),f.bytes)).rejects.toThrow("busy");release.resolve();await Promise.all([a,b]);
 });
 it("retains a private byte snapshot while awaiting the original lock",async()=>{
  const f=fixture(),release=deferred(),original=Buffer.from(f.bytes);f.lockGate.mockImplementation(async()=>{await release.promise;});
  const pending=f.receiver.append(proof,f.ref,0,hash(f.bytes),f.bytes);f.bytes.fill(7);release.resolve();await pending;
  expect([...f.physical.values()][0]).toEqual(original);
 });
 it("seals the full ordered stream and returns the fixed seal after lost commit reply",async()=>{
  const f=fixture(4194304+17);for(let offset=0;offset<f.bytes.length;offset+=4194304){const part=f.bytes.subarray(offset,offset+4194304);await f.receiver.append(proof,f.ref,offset,hash(part),part);}
  const seal=requireTestValue(f.journal.recordSeal.getMockImplementation());f.journal.recordSeal.mockImplementationOnce(async(...args)=>{await seal(...args);throw Error("seal reply lost");});
  await expect(f.receiver.seal(proof,f.ref)).rejects.toThrow("seal reply lost");await expect(f.receiver.seal(proof,f.ref)).resolves.toMatchObject({state:"sealed",sealSha256:hash(f.bytes)});
  expect(f.journal.inspectChunk.mock.calls.map(c=>c[2])).toEqual([0,4194304]);expect(f.spool.readChunk).toHaveBeenCalledTimes(2);expect(f.journal.recordSeal).toHaveBeenCalledTimes(1);
 });
 it("never seals an incomplete stream or corrupted bytes",async()=>{
  const f=fixture();await expect(f.receiver.seal(proof,f.ref)).rejects.toThrow("incomplete");expect(f.spool.readChunk).not.toHaveBeenCalled();
  await f.receiver.append(proof,f.ref,0,hash(f.bytes),f.bytes);f.spool.readChunk.mockResolvedValueOnce(Buffer.alloc(f.bytes.length,33));await expect(f.receiver.seal(proof,f.ref)).rejects.toThrow("seal_invalid");expect(f.original().state).toBe("receiving");
 });
 it("refuses invalid bytes before admission and retains data on authority refusal",async()=>{
  const f=fixture();await expect(f.receiver.append(proof,f.ref,0,"0".repeat(64),f.bytes)).rejects.toThrow("mismatch");expect(f.journal.reserveChunk).not.toHaveBeenCalled();
  f.journal.recordChunk.mockRejectedValueOnce(Error("authority changed"));await expect(f.receiver.append(proof,f.ref,0,hash(f.bytes),f.bytes)).rejects.toThrow("authority changed");expect(f.physical.size).toBe(1);expect(f.original().receivedBytes).toBe(0);
 });
});
