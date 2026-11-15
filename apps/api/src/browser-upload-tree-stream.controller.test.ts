import { fixtureValue } from './test-values.fixture.js';
import "reflect-metadata";
import {EventEmitter} from "node:events";
import {randomUUID} from "node:crypto";
import {Readable} from "node:stream";
import {describe,it,expect,vi} from "vitest";
import fastify from "fastify";
import type {FastifyReply} from "fastify";
import {OwnerBrowserTreeStreamController,DropBrowserTreeStreamController} from "./browser-upload-tree-stream.controller.js";
import type {BrowserTreeStreamHttpService} from "./browser-upload-tree-stream.service.js";
import {registerBrowserTreeStreamLimits} from "./browser-upload-tree-stream-limits.js";
import {registerRawBodyParsers} from "./raw-body-parsers.js";
import {readBrowserTreeStreamChunk} from "./browser-upload-tree-stream-body.js";
import {browserTreeHttpError} from "./browser-upload-tree.controller.js";
import {OWNER_SESSION,type AuthenticatedOwnerRequest} from "./owner-token.guard.js";
import {DROP_SESSION,type AuthenticatedDropRequest} from "./drop-session.guard.js";

describe("stream HTTP routes",()=>{
 it("uncomposed routes advertise unavailable only to guarded sessions and refuse admission",async()=>{
  const owner=new OwnerBrowserTreeStreamController(null),drop=new DropBrowserTreeStreamController(null);
  expect(()=>owner.capability({} as AuthenticatedOwnerRequest)).toThrow();expect(()=>drop.capability({} as AuthenticatedDropRequest)).toThrow();
  expect(owner.capability({[OWNER_SESSION]:{}} as AuthenticatedOwnerRequest)).toEqual({schema:"saturn.browser-tree-stream-capability.v1",available:false});
  expect(drop.capability({[DROP_SESSION]:{}} as AuthenticatedDropRequest).available).toBe(false);
  await expect(owner.admit(randomUUID(),randomUUID(),{},{} as AuthenticatedOwnerRequest)).rejects.toMatchObject({status:503});
  await expect(drop.admit(randomUUID(),{},{} as AuthenticatedDropRequest)).rejects.toMatchObject({status:503});
 });
 it("forwards only original route/header fields and joins append after disconnect",async()=>{
  const proof={},tree=randomUUID(),job=randomUUID(),root=randomUUID(),body=Readable.from([Buffer.alloc(1)],{objectMode:false});
  let release!:()=>void,signal!:AbortSignal;const gate=new Promise<void>(resolve=>{release=resolve;});
  const service={owner:vi.fn(async()=>proof),append:vi.fn(async(...args:unknown[])=>{signal=args.at(-1) as AbortSignal;await gate;return {confirmedOffset:1};})};
  const owner=new OwnerBrowserTreeStreamController(service as unknown as BrowserTreeStreamHttpService);
  const raw=Object.assign(new EventEmitter(),{aborted:false}),socket=Object.assign(new EventEmitter(),{destroyed:false,writableFinished:false});
  const request={raw,headers:{"content-type":"application/offset+octet-stream","content-length":"1","upload-offset":"0","x-saturn-chunk-sha256":"a".repeat(64),"x-private-path":"ignored"}} as unknown as AuthenticatedOwnerRequest;
  let settled=false;const result=owner.append(root,tree,job,body,request,{raw:socket} as unknown as FastifyReply).finally(()=>{settled=true;});
  await vi.waitFor(()=>expect(service.append).toHaveBeenCalledOnce());socket.emit("close");expect(signal.aborted).toBe(true);await Promise.resolve();expect(settled).toBe(false);
  release();expect(await result).toEqual({confirmedOffset:1});expect(service.owner).toHaveBeenCalledExactlyOnceWith(request,root);
  expect(fixtureValue(service.append.mock.calls[0]).slice(0,5)).toEqual([proof,tree,job,{contentType:"application/offset+octet-stream",contentEncoding:undefined,contentLength:"1",offset:"0",sha256:"a".repeat(64)},body]);body.destroy();
 });
 it("Drop execution uses the current normal proof and never a caller root or private task",async()=>{
  const proof={},request={} as AuthenticatedDropRequest,tree=randomUUID(),job=randomUUID(),service={drop:vi.fn(async()=>proof),execute:vi.fn(async()=>({status:{state:"running"}}))};
  const drop=new DropBrowserTreeStreamController(service as unknown as BrowserTreeStreamHttpService);expect(await drop.execute(tree,job,{},request)).toEqual({status:{state:"running"}});
  expect(service.drop).toHaveBeenCalledExactlyOnceWith(request);expect(service.execute).toHaveBeenCalledExactlyOnceWith(proof,tree,job,{});
 });
 it("maps only named stream conflicts and quota lock refusals, never arbitrary SQL details",()=>{
  expect(browserTreeHttpError(Object.assign(Error("browser_spool_quota_busy"),{code:"55P03"}))).toEqual({status:429,code:"browser_spool_quota_busy"});
  expect(browserTreeHttpError(Object.assign(Error("private lock path"),{code:"55P03"}))).toEqual({status:500,code:"browser_tree_internal_error"});
  expect(browserTreeHttpError(Error("browser_tree_stream_busy")).status).toBe(429);expect(browserTreeHttpError(Error("browser_tree_stream_seal_reused")).status).toBe(409);
  expect(browserTreeHttpError(Error("browser_tree_stream_chunk_mismatch")).status).toBe(400);expect(browserTreeHttpError(Error("browser_tree_stream_not_found"))).toEqual({status:404,code:"browser_tree_not_found"});
 });
});
describe("real Fastify parser bounds (in-process, no DB/storage qualification)",()=>{
 it("rejects metadata above64KiB before handler and preserves existing route hooks",async()=>{
  const app=fastify({logger:false,bodyLimit:8388608}),handler=vi.fn(async()=>({ok:true})),hook=vi.fn(async()=>undefined);registerBrowserTreeStreamLimits(app);
  app.post('/metadata',{config:{browserTreeStream:"metadata"},onRequest:hook},handler);
  try{
   const small=await app.inject({method:"POST",url:"/metadata",payload:{n:"ok"}});expect(small.statusCode).toBe(200);expect(hook).toHaveBeenCalledOnce();
   const large=await app.inject({method:"POST",url:"/metadata",payload:{n:"x".repeat(65536)}});expect(large.statusCode).toBe(413);expect(handler).toHaveBeenCalledOnce();
   expect(small.headers["cache-control"]).toBe("no-store");
  }finally{await app.close();}
 });
 it("rejects compressed or unexpected content types before either raw reader or JSON handler",async()=>{
  const app=fastify({logger:false}),handler=vi.fn(async()=>({ok:true}));registerRawBodyParsers(app);registerBrowserTreeStreamLimits(app);
  app.post('/metadata',{config:{browserTreeStream:"metadata"}},handler);app.patch('/chunk',{config:{browserTreeStream:"chunk"}},handler);
  try{
   for(const input of [{method:"POST" as const,url:"/metadata",headers:{"content-type":"application/json","content-encoding":"gzip"}},{method:"POST" as const,url:"/metadata",headers:{"content-type":"text/plain"}},{method:"PATCH" as const,url:"/chunk",headers:{"content-type":"application/json"}}])expect((await app.inject({...input,payload:"{}"})).statusCode).toBe(415);
   expect(handler).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it("the production raw parser supplies an unread binary stream to a bounded reader",async()=>{
  const app=fastify({logger:false});registerRawBodyParsers(app);registerBrowserTreeStreamLimits(app);
  app.patch('/chunk',{config:{browserTreeStream:"chunk"}},async request=>{
   expect(request.body).toBeInstanceOf(Readable);expect((request.body as Readable).readableFlowing).toBe(null);
   const bytes=await readBrowserTreeStreamChunk(request.body,3);return {hex:bytes.toString("hex")};
  });
  try{const reply=await app.inject({method:"PATCH",url:"/chunk",headers:{"content-type":"application/offset+octet-stream"},payload:Buffer.from([1,2,255])});expect(reply.statusCode).toBe(200);expect(reply.json()).toEqual({hex:"0102ff"});}finally{await app.close();}
 });
});
