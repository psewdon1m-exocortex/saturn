import { requireTestValue } from "../../contracts/src/test-support.js";
import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {BrowserTreeStreamCleanup,type BrowserTreeStreamCleanupOriginal} from "./browser-upload-tree-stream-cleanup.js";
import type {BrowserTreeSpoolChunk,BrowserTreeSpoolRemoval} from "./browser-upload-tree-stream-spool.js";
import type {BrowserTreeOriginalReference} from "./browser-upload-tree-executor.js";

function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(){
 const reference={treeId:randomUUID(),jobId:randomUUID(),itemId:randomUUID()};
 let original:BrowserTreeStreamCleanupOriginal={reference,operationId:randomUUID(),spoolId:randomUUID(),cleanupTaskId:randomUUID(),state:"retained"};
 const chunks:BrowserTreeSpoolChunk[]=[0,4194304].map((offset,index)=>({spoolId:original.spoolId,operationId:original.operationId,writeTaskId:randomUUID(),offset,length:index?17:4194304,sha256:"a".repeat(64),identity:{dev:"1",ino:String(19+index)}}));
 const receipts=new Set<number>(),removed=new Set<number>();let locked=false;
 // Coordinator protocol doubles only, not filesystem or PostgreSQL evidence.
 const journal={
  withOriginalLock:async<T>(_ref:BrowserTreeOriginalReference,action:()=>Promise<T>)=>{locked=true;try{return await action();}finally{locked=false;}},
  inspect:vi.fn(async()=>original),nextChunk:vi.fn(async()=>{expect(locked).toBe(true);return chunks.find(chunk=>!receipts.has(chunk.offset))??null;}),
  recordRemoval:vi.fn(async(_original:BrowserTreeStreamCleanupOriginal,chunk:BrowserTreeSpoolChunk,_receipt:BrowserTreeSpoolRemoval)=>{void _receipt;expect(locked).toBe(true);expect(removed.has(chunk.offset)).toBe(true);receipts.add(chunk.offset);}),
  release:vi.fn(async()=>{expect(receipts.size).toBe(chunks.length);original={...original,state:"released"};return original;}),
 };
 const spool={removeChunk:vi.fn(async(chunk:BrowserTreeSpoolChunk):Promise<BrowserTreeSpoolRemoval>=>{expect(locked).toBe(true);const was=removed.has(chunk.offset);removed.add(chunk.offset);return {disposition:was?"absent":"removed",identity:chunk.identity,removedBytes:was?0:chunk.length};})};
 return {reference,chunks,journal,spool,receipts,removed,cleanup:new BrowserTreeStreamCleanup(journal,spool),get original(){return original;},get locked(){return locked;}};
}
describe("terminal stream cleanup coordinator",()=>{
 it("retains its original lock and quota until physical close and every removal receipt have settled",async()=>{
  const f=fixture(),physical=deferred<BrowserTreeSpoolRemoval>(),receipt=deferred(),remove=requireTestValue(f.spool.removeChunk.getMockImplementation()),record=requireTestValue(f.journal.recordRemoval.getMockImplementation());
  f.spool.removeChunk.mockImplementationOnce(async chunk=>{await physical.promise;return remove(chunk);});
  f.journal.recordRemoval.mockImplementationOnce(async(...args)=>{await receipt.promise;return record(...args);});
  const operation=f.cleanup.run(f.reference);await vi.waitFor(()=>expect(f.spool.removeChunk).toHaveBeenCalledOnce());expect(f.journal.recordRemoval).not.toHaveBeenCalled();expect(f.locked).toBe(true);
  physical.resolve({disposition:"absent",identity:null,removedBytes:0});await vi.waitFor(()=>expect(f.journal.recordRemoval).toHaveBeenCalledOnce());expect(f.journal.release).not.toHaveBeenCalled();expect(f.spool.removeChunk).toHaveBeenCalledOnce();
  receipt.resolve();expect((await operation).state).toBe("released");expect(f.receipts.size).toBe(2);expect(f.locked).toBe(false);
 });
 it("does not touch the spool for a nonterminal or differently bound original",async()=>{
  const f=fixture();f.journal.inspect.mockRejectedValueOnce(Error("not terminal"));await expect(f.cleanup.run(f.reference)).rejects.toThrow("not terminal");expect(f.spool.removeChunk).not.toHaveBeenCalled();
  f.journal.nextChunk.mockResolvedValueOnce({...requireTestValue(f.chunks[0]),operationId:randomUUID()});await expect(f.cleanup.run(f.reference)).rejects.toThrow("original_changed");expect(f.spool.removeChunk).not.toHaveBeenCalled();expect(f.journal.release).not.toHaveBeenCalled();
 });
 it("retains quota after physical failure and resumes the exact pending chunk",async()=>{
  const f=fixture();f.spool.removeChunk.mockRejectedValueOnce(Error("inode changed"));await expect(f.cleanup.run(f.reference)).rejects.toThrow("inode changed");expect(f.original.state).toBe("retained");expect(f.journal.release).not.toHaveBeenCalled();
  expect((await f.cleanup.run(f.reference)).state).toBe("released");expect(f.spool.removeChunk.mock.calls.slice(0,2).map(call=>call[0])).toEqual([f.chunks[0],f.chunks[0]]);
 });
 it("replays absence after deletion succeeds but its database receipt fails",async()=>{
  const f=fixture();f.journal.recordRemoval.mockRejectedValueOnce(Error("DB connection lost before receipt"));await expect(f.cleanup.run(f.reference)).rejects.toThrow("connection lost");expect(f.removed.has(0)).toBe(true);expect(f.receipts.size).toBe(0);expect(f.original.state).toBe("retained");
  expect((await f.cleanup.run(f.reference)).state).toBe("released");expect(requireTestValue(f.journal.recordRemoval.mock.calls[1])[2]).toMatchObject({disposition:"absent",removedBytes:0});
 });
 it("skips a receipt committed before its reply was lost instead of deleting another chunk identity",async()=>{
  const f=fixture(),record=requireTestValue(f.journal.recordRemoval.getMockImplementation());f.journal.recordRemoval.mockImplementationOnce(async(...args)=>{await record(...args);throw Error("committed ACK lost");});
  await expect(f.cleanup.run(f.reference)).rejects.toThrow("ACK lost");expect(f.receipts.has(0)).toBe(true);expect((await f.cleanup.run(f.reference)).state).toBe("released");expect(f.spool.removeChunk.mock.calls.map(call=>call[0].offset)).toEqual([0,4194304]);
 });
 it("recovers a committed release with no further physical calls",async()=>{
  const f=fixture(),release=requireTestValue(f.journal.release.getMockImplementation());f.journal.release.mockImplementationOnce(async()=>{await release();throw Error("release ACK lost");});
  await expect(f.cleanup.run(f.reference)).rejects.toThrow("release ACK lost");expect(f.original.state).toBe("released");expect((await f.cleanup.run(f.reference)).state).toBe("released");expect(f.journal.release).toHaveBeenCalledOnce();expect(f.spool.removeChunk).toHaveBeenCalledTimes(2);
 });
 it("joins an aborted unlink and still commits its receipt before releasing the active slot",async()=>{
  const f=fixture(),gate=deferred(),abort=new AbortController(),remove=requireTestValue(f.spool.removeChunk.getMockImplementation());
  f.spool.removeChunk.mockImplementationOnce(async chunk=>{await gate.promise;return remove(chunk);});
  const operation=f.cleanup.run(f.reference,abort.signal).catch((error: unknown)=>error);await vi.waitFor(()=>expect(f.spool.removeChunk).toHaveBeenCalledOnce());abort.abort(Error("stopped"));
  await expect(f.cleanup.run(f.reference)).rejects.toThrow("busy");expect(f.locked).toBe(true);gate.resolve();expect(await operation).toMatchObject({message:"stopped"});expect(f.receipts.has(0)).toBe(true);expect(f.journal.release).not.toHaveBeenCalled();expect(f.original.state).toBe("retained");
 });
 it("keeps at most two cleanup originals active while their database inspection is pending",async()=>{
  const f=fixture(),a=deferred<BrowserTreeStreamCleanupOriginal>(),b=deferred<BrowserTreeStreamCleanupOriginal>();f.journal.inspect.mockImplementationOnce(async()=>a.promise).mockImplementationOnce(async()=>b.promise);
  const first=f.cleanup.run(f.reference).catch((error: unknown)=>error),second=f.cleanup.run({...f.reference,itemId:randomUUID()}).catch((error: unknown)=>error);await vi.waitFor(()=>expect(f.journal.inspect).toHaveBeenCalledTimes(2));
  await expect(f.cleanup.run({...f.reference,itemId:randomUUID()})).rejects.toThrow("busy");a.reject(Error("first stopped"));b.reject(Error("second stopped"));expect(await first).toBeInstanceOf(Error);expect(await second).toBeInstanceOf(Error);
 });
});
