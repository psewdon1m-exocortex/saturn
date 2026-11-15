import {Readable,PassThrough} from "node:stream";
import {describe,it,expect} from "vitest";
import {parseBrowserTreeStreamChunkHeaders as parse,readBrowserTreeStreamChunk as read} from "./browser-upload-tree-stream-body.js";

const headers={contentType:"application/offset+octet-stream",contentEncoding:undefined,contentLength:undefined,offset:"0",sha256:"a".repeat(64)};
const stream=(...parts:Uint8Array[])=>Readable.from(parts,{objectMode:false});
describe("raw stream body bound",()=>{
 it("accepts canonical offset/hash, optional length and identity encoding",()=>{
  expect(parse(headers)).toEqual({offset:0,sha256:headers.sha256,length:undefined});
  expect(parse({...headers,contentEncoding:"identity",contentLength:"4194304",offset:"4194304"})).toEqual({offset:4194304,sha256:headers.sha256,length:4194304});
 });
 it.each(["-1","+1","01"," 0","1.0","9007199254740992",["0"]])("rejects ambiguous or unsafe offset %s",offset=>{expect(()=>parse({...headers,offset})).toThrow();});
 it("refuses compressed, other media, duplicate hashes and oversized/empty declared bodies",()=>{
  for(const fields of [{contentEncoding:"gzip"},{contentType:"application/json"},{sha256:[headers.sha256]},{sha256:"A".repeat(64)},{contentLength:"0"},{contentLength:"4194305"},{contentLength:"01"}])expect(()=>parse({...headers,...fields})).toThrow();
 });
 it("joins multiple raw pieces into exactly the expected bytes",async()=>{
  expect(await read(stream(Buffer.from([1,2]),Buffer.from([3])),3)).toEqual(Buffer.from([1,2,3]));
  expect(await read(stream(Buffer.from([9])),undefined)).toEqual(Buffer.from([9]));
 });
 it("does not trust declared length and closes rejected bodies",async()=>{
  for(const [body,length] of [[stream(Buffer.alloc(4)),3],[stream(Buffer.alloc(2)),3],[stream(),undefined]] as const){await expect(read(body,length)).rejects.toThrow();expect(body.destroyed).toBe(true);}
 });
 it("rejects the first byte beyond the fixed4MiB bound without consuming the remaining source",async()=>{
  let produced=0;async function* source(){for(let n=0;n<100;n++){produced++;yield Buffer.alloc(1024*1024);}}
  const body=Readable.from(source(),{objectMode:false,highWaterMark:1});await expect(read(body,undefined)).rejects.toThrow();expect(produced).toBeLessThanOrEqual(6);expect(body.destroyed).toBe(true);
 });
 it("refuses decoded/object inputs instead of accepting a different byte representation",async()=>{
  await expect(read(Buffer.alloc(1),1)).rejects.toThrow();await expect(read(Readable.from([Buffer.alloc(1)]),1)).rejects.toThrow();
  const body=stream(Buffer.alloc(1));body.setEncoding("utf8");await expect(read(body,1)).rejects.toThrow();body.destroy();
 });
 it("abort interrupts a stalled stream and is joined before returning",async()=>{
  const body=new PassThrough(),controller=new AbortController(),result=read(body,2,controller.signal);body.write(Buffer.from([1]));controller.abort(Error("cancelled"));
  await expect(result).rejects.toThrow("cancelled");expect(body.destroyed).toBe(true);
 });
 it("an already aborted request consumes no body",async()=>{
  let consumed=false;const body=new Readable({read(){consumed=true;this.push(null);}}),controller=new AbortController();controller.abort(Error("cancelled"));
  await expect(read(body,2,controller.signal)).rejects.toThrow("cancelled");expect(consumed).toBe(false);expect(body.destroyed).toBe(true);
 });
});
