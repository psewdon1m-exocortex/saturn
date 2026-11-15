// @vitest-environment node
import {randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {applyUploadTreeStreamStatus,beginUploadTreeStreamChunk,beginUploadTreeStreamSeal,validateUploadTreeStreamProgress,type UploadTreeStreamIdentity,type UploadTreeStreamStatus,type UploadTreeStreamProgress,type UploadTreeStreamChunkIntent} from "./upload-tree-stream-progress.js";
const chunkBytes=4194304;
function fixture(sizeBytes=chunkBytes+17){
 const original:UploadTreeStreamIdentity={treeId:randomUUID(),jobId:randomUUID(),itemId:randomUUID(),intentSha256:"a".repeat(64),sizeBytes,sha256:"b".repeat(64)};
 const status:UploadTreeStreamStatus={...original,schema:"saturn.browser-tree-stream-status.v1",sealId:randomUUID(),confirmedOffset:0,state:"receiving",sealSha256:null,lastChunk:null};
 const progress=applyUploadTreeStreamStatus(original,undefined,status),first={offset:0,length:Math.min(sizeBytes,chunkBytes),sha256:"c".repeat(64)};
 return {original,status,progress,first};
}
function ack(status:UploadTreeStreamStatus,chunk:UploadTreeStreamChunkIntent):UploadTreeStreamStatus{return {...status,confirmedOffset:chunk.offset+chunk.length,lastChunk:chunk};}
describe("bounded durable streaming chunk progress",()=>{
 it("retains an unconfirmed intent after an old status and accepts its exact closed receipt",()=>{
  const f=fixture(),pending=beginUploadTreeStreamChunk(f.original,f.progress,f.first);
  expect(pending.pending).toEqual(f.first);expect(pending.confirmedOffset).toBe(0);
  const unchanged=applyUploadTreeStreamStatus(f.original,pending,f.status);expect(unchanged).toEqual(pending);
  expect(beginUploadTreeStreamChunk(f.original,unchanged,f.first)).toEqual(pending);
  const confirmed=applyUploadTreeStreamStatus(f.original,pending,ack(f.status,f.first));expect(confirmed.confirmedOffset).toBe(chunkBytes);expect(confirmed.pending).toBeNull();expect(confirmed.lastChunk).toEqual(f.first);
  expect(applyUploadTreeStreamStatus(f.original,confirmed,ack(f.status,f.first))).toEqual(confirmed);
 });
 it("never accepts advanced bytes without the exact prior durable intent",()=>{
  const f=fixture();expect(()=>applyUploadTreeStreamStatus(f.original,f.progress,ack(f.status,f.first))).toThrow("durable chunk intent");
  expect(()=>applyUploadTreeStreamStatus(f.original,undefined,ack(f.status,f.first))).toThrow("durable chunk intent");
  const pending=beginUploadTreeStreamChunk(f.original,f.progress,f.first);
  expect(()=>applyUploadTreeStreamStatus(f.original,pending,ack(f.status,{...f.first,sha256:"d".repeat(64)}))).toThrow("durable chunk intent");
  const final={offset:chunkBytes,length:17,sha256:"d".repeat(64)};expect(()=>applyUploadTreeStreamStatus(f.original,pending,ack(f.status,final))).toThrow("durable chunk intent");
 });
 it("refuses changed pending bytes and reordered or arbitrarily tiny chunks",()=>{
  const f=fixture(),pending=beginUploadTreeStreamChunk(f.original,f.progress,f.first);
  expect(()=>beginUploadTreeStreamChunk(f.original,pending,{...f.first,sha256:"d".repeat(64)})).toThrow("cannot change");
  for(const chunk of [{...f.first,offset:1},{...f.first,length:1},{offset:chunkBytes,length:17,sha256:f.first.sha256}])expect(()=>beginUploadTreeStreamChunk(f.original,pending,chunk)).toThrow();
 });
 it("rejects a changed original full SHA intent scope or fixed seal",()=>{
  const f=fixture();for(const field of ["treeId","jobId","itemId","sealId"] as const)expect(()=>applyUploadTreeStreamStatus(f.original,f.progress,{...f.status,[field]:randomUUID()})).toThrow();
  for(const field of ["intentSha256","sha256"] as const)expect(()=>applyUploadTreeStreamStatus(f.original,f.progress,{...f.status,[field]:"d".repeat(64)})).toThrow("original");
  expect(()=>applyUploadTreeStreamStatus(f.original,f.progress,{...f.status,sizeBytes:f.original.sizeBytes+1})).toThrow("original");
 });
 it("preserves confirmed receipts and refuses regressed offset or rewritten hash",()=>{
  const f=fixture(),p=beginUploadTreeStreamChunk(f.original,f.progress,f.first),confirmed=applyUploadTreeStreamStatus(f.original,p,ack(f.status,f.first));
  expect(()=>applyUploadTreeStreamStatus(f.original,confirmed,f.status)).toThrow("regress");
  expect(()=>applyUploadTreeStreamStatus(f.original,confirmed,ack(f.status,{...f.first,sha256:"d".repeat(64)}))).toThrow("receipt cannot change");
 });
 it("persists seal intent only after every byte is confirmed and retains it on lost reply",()=>{
  const f=fixture(262145),p=beginUploadTreeStreamChunk(f.original,f.progress,f.first);expect(()=>beginUploadTreeStreamSeal(f.original,p)).toThrow("not fully confirmed");
  const status=ack(f.status,f.first),confirmed=applyUploadTreeStreamStatus(f.original,p,status),sealing=beginUploadTreeStreamSeal(f.original,confirmed);expect(sealing.sealPending).toBe(true);
  expect(applyUploadTreeStreamStatus(f.original,sealing,status)).toEqual(sealing);expect(beginUploadTreeStreamSeal(f.original,sealing)).toEqual(sealing);
  const sealedStatus={...status,state:"sealed" as const,sealSha256:f.original.sha256},sealed=applyUploadTreeStreamStatus(f.original,sealing,sealedStatus);expect(sealed.state).toBe("sealed");expect(sealed.sealPending).toBe(false);
  expect(beginUploadTreeStreamSeal(f.original,sealed)).toEqual(sealed);expect(()=>applyUploadTreeStreamStatus(f.original,sealed,status)).toThrow("regress");expect(()=>beginUploadTreeStreamChunk(f.original,sealed,f.first)).toThrow();
 });
 it("requires the full expected seal hash and refuses premature or null seals",()=>{
  const f=fixture(262145),pending=beginUploadTreeStreamChunk(f.original,f.progress,f.first),status=ack(f.status,f.first);
  expect(()=>applyUploadTreeStreamStatus(f.original,pending,{...f.status,state:"sealed",sealSha256:f.original.sha256})).toThrow("seal");
  for(const sealSha256 of [null,"d".repeat(64)])expect(()=>applyUploadTreeStreamStatus(f.original,pending,{...status,state:"sealed",sealSha256})).toThrow("seal");
  expect(()=>applyUploadTreeStreamStatus(f.original,pending,{...status,sealSha256:f.original.sha256})).toThrow("seal");
 });
 it("rejects missing extra or inconsistent status fields",()=>{
  const f=fixture(),{sealSha256,...missing}=f.status;void sealSha256;expect(()=>applyUploadTreeStreamStatus(f.original,f.progress,missing)).toThrow("metadata");
  expect(()=>applyUploadTreeStreamStatus(f.original,f.progress,{...f.status,backendPath:"private"})).toThrow("metadata");
  for(const offset of [-1,1,Number.MAX_SAFE_INTEGER+1,f.original.sizeBytes+1])expect(()=>applyUploadTreeStreamStatus(f.original,f.progress,{...f.status,confirmedOffset:offset})).toThrow("offset");
  expect(()=>applyUploadTreeStreamStatus(f.original,f.progress,{...f.status,confirmedOffset:chunkBytes})).toThrow("Missing");
 });
 it("validates restored bounded state and rejects corrupt pending or seal transitions",()=>{
  const f=fixture(),pending=beginUploadTreeStreamChunk(f.original,f.progress,f.first),saved=structuredClone(pending);validateUploadTreeStreamProgress(f.original,saved);
  for(const bad of [{...saved,sealPending:true},{...saved,confirmedOffset:chunkBytes},{...saved,state:"sealed"},{...saved,pending:{...f.first,sha256:"bad"}}])expect(()=>validateUploadTreeStreamProgress(f.original,bad as UploadTreeStreamProgress)).toThrow();
 });
 it("retains constant metadata across many chunks without keeping earlier bodies or hashes",()=>{
  const f=fixture(32*chunkBytes+17);let progress=f.progress;
  for(let offset=0;offset<f.original.sizeBytes;offset+=chunkBytes){const next={offset,length:Math.min(chunkBytes,f.original.sizeBytes-offset),sha256:"c".repeat(64)};progress=applyUploadTreeStreamStatus(f.original,beginUploadTreeStreamChunk(f.original,progress,next),ack(f.status,next));expect(JSON.stringify(progress).length).toBeLessThan(512);}
  expect(progress.confirmedOffset).toBe(f.original.sizeBytes);expect(progress.lastChunk?.length).toBe(17);expect(progress.pending).toBeNull();
 });
 it("copies pending receipts rather than retaining a caller-owned mutable descriptor",()=>{
  const f=fixture(),intent={...f.first},pending=beginUploadTreeStreamChunk(f.original,f.progress,intent);intent.sha256="d".repeat(64);expect(pending.pending?.sha256).toBe(f.first.sha256);expect(Object.isFrozen(pending.pending)).toBe(true);
  const status=ack(f.status,{...f.first}),confirmed=applyUploadTreeStreamStatus(f.original,pending,status);(status.lastChunk as {sha256:string}).sha256="d".repeat(64);expect(confirmed.lastChunk?.sha256).toBe(f.first.sha256);
 });
});
