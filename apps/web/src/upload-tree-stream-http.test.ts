// @vitest-environment node
import { requiredValue } from "./test-value.js";
import {randomUUID} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import {createUploadTreeStreamHttp} from "./upload-tree-stream-http.js";
import type {UploadTreeScope} from "./upload-tree-durable.js";

// Event-driven XHR protocol double. Real browser/proxy timing is a separate gate.
class Xhr {
 url="";method="";headers=new Map<string,string>();status=200;responseText="{}";readyState=1;responseType="";timeout=-1;
 onload:(()=>void)|null=null;onerror:(()=>void)|null=null;onabort:(()=>void)|null=null;ontimeout:(()=>void)|null=null;onreadystatechange:(()=>void)|null=null;
 onprogress:((event:{loaded:number})=>void)|null=null;
 upload:{onprogress:((event:{loaded:number})=>void)|null;onload:(()=>void)|null}={onprogress:null,onload:null};
 send=vi.fn<(bytes:Uint8Array)=>void>();abort=vi.fn(()=>this.onabort?.());
 open(method:string,url:string){this.method=method;this.url=url;}
 setRequestHeader(name:string,value:string){this.headers.set(name,value);}
 reply(value:unknown,status=200){this.status=status;this.responseText=JSON.stringify(value);this.onload?.();}
}
function fixture(){
 vi.stubGlobal("document",{cookie:"vault_csrf_dev=owner-token; vault_drop_csrf_dev=drop-token"});
 const xhr=new Xhr(),create=vi.fn(()=>xhr as unknown as XMLHttpRequest),http=createUploadTreeStreamHttp(create);
 const owner:UploadTreeScope={kind:"owner",rootId:randomUUID()},drop:UploadTreeScope={kind:"drop",channelId:randomUUID()},tree=randomUUID(),job=randomUUID();
 const chunk={offset:0,length:3,sha256:"a".repeat(64),bytes:new Uint8Array([1,2,3])};
 return {xhr,create,http,owner,drop,tree,job,chunk};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe("bounded stream HTTP and cancellation",()=>{
 it("routes binary owner/Drop originals with their CSRF and explicit retained channel",async()=>{
  const f=fixture();vi.stubGlobal("window",{history:{state:{saturnDropChannelId:randomUUID()}}});
  for(const scope of [f.owner,f.drop]){
   const operation=f.http.append(scope,f.tree,f.job,f.chunk);expect(f.xhr.method).toBe("PATCH");
   expect(f.xhr.url).toBe(scope.kind==="owner"?`/api/v1/upload-trees/${scope.rootId}/${f.tree}/stream-jobs/${f.job}/chunks`:`/api/v1/drop/upload-trees/${f.tree}/stream-jobs/${f.job}/chunks`);
   expect(f.xhr.headers.get("X-Vault-CSRF")).toBe(scope.kind==="owner"?"owner-token":"drop-token");
   if(scope.kind==="drop")expect(f.xhr.headers.get("X-Saturn-Drop-Channel")).toBe(scope.channelId);
   expect(f.xhr.headers.get("Content-Type")).toBe("application/offset+octet-stream");expect(f.xhr.headers.get("Upload-Offset")).toBe("0");
   expect(f.xhr.headers.get("X-Saturn-Chunk-Sha256")).toBe(f.chunk.sha256);expect(f.xhr.send).toHaveBeenLastCalledWith(f.chunk.bytes);expect(f.xhr.timeout).toBe(0);
   f.xhr.reply({confirmedOffset:3});await expect(operation).resolves.toEqual({confirmedOffset:3});
  }
 });
 it("allows progress over many idle intervals without imposing a total transfer deadline",async()=>{
  vi.useFakeTimers();const f=fixture(),operation=f.http.append(f.owner,f.tree,f.job,f.chunk);
  await vi.advanceTimersByTimeAsync(14000);f.xhr.upload.onprogress?.({loaded:1});
  await vi.advanceTimersByTimeAsync(119000);f.xhr.upload.onprogress?.({loaded:2});
  await vi.advanceTimersByTimeAsync(119000);f.xhr.upload.onprogress?.({loaded:3});f.xhr.upload.onload?.();
  await vi.advanceTimersByTimeAsync(119000);f.xhr.onprogress?.({loaded:1});
  expect(f.xhr.abort).not.toHaveBeenCalled();f.xhr.reply({ok:true});await expect(operation).resolves.toEqual({ok:true});
  await vi.advanceTimersByTimeAsync(120000);expect(f.xhr.abort).not.toHaveBeenCalled();
 });
 it("bounds connection stalls at15s and keeps the promise pending until abort settles",async()=>{
  vi.useFakeTimers();const f=fixture();f.xhr.abort.mockImplementation(()=>{});let settled=false;
  const operation=f.http.append(f.owner,f.tree,f.job,f.chunk).catch((error: unknown) =>{settled=true;return error;});
  await vi.advanceTimersByTimeAsync(14999);expect(f.xhr.abort).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);
  expect(f.xhr.abort).toHaveBeenCalledOnce();expect(settled).toBe(false);f.xhr.onabort?.();expect(await operation).toMatchObject({message:expect.stringContaining("connection timeout") as unknown});
 });
 it("does not extend120s idle for duplicate progress or duplicate headers",async()=>{
  vi.useFakeTimers();const f=fixture(),operation=f.http.append(f.owner,f.tree,f.job,f.chunk).catch((error: unknown) =>error);
  f.xhr.upload.onprogress?.({loaded:1});await vi.advanceTimersByTimeAsync(119000);f.xhr.upload.onprogress?.({loaded:1});f.xhr.readyState=3;f.xhr.onreadystatechange?.();
  await vi.advanceTimersByTimeAsync(1000);expect(await operation).toMatchObject({message:expect.stringContaining("data idle timeout") as unknown});expect(f.xhr.abort).toHaveBeenCalledOnce();
 });
 it("joins an explicit abort and removes all callbacks and timers after settlement",async()=>{
  vi.useFakeTimers();const f=fixture(),controller=new AbortController();f.xhr.abort.mockImplementation(()=>{});let settled=false;
  const operation=f.http.append(f.drop,f.tree,f.job,f.chunk,controller.signal).catch((error: unknown) =>{settled=true;return error;});
  controller.abort(Error("user stopped"));await Promise.resolve();expect(settled).toBe(false);expect(f.xhr.abort).toHaveBeenCalledOnce();
  f.xhr.onabort?.();expect(await operation).toMatchObject({message:"user stopped"});expect(f.xhr.onload).toBeNull();expect(f.xhr.upload.onprogress).toBeNull();
  await vi.advanceTimersByTimeAsync(180000);expect(f.xhr.abort).toHaveBeenCalledOnce();
 });
 it("rejects invalid identities/chunks and already aborted calls before opening a connection",()=>{
  const f=fixture();for(const chunk of [{...f.chunk,offset:1},{...f.chunk,length:4194305},{...f.chunk,sha256:"bad"},{...f.chunk,length:0}])expect(()=>f.http.append(f.owner,f.tree,f.job,chunk)).toThrow();
  expect(()=>f.http.append({...f.owner,rootId:"bad"},f.tree,f.job,f.chunk)).toThrow();
  const abort=new AbortController();abort.abort(Error("stopped"));expect(()=>f.http.append(f.owner,f.tree,f.job,f.chunk,abort.signal)).toThrow("stopped");expect(f.create).not.toHaveBeenCalled();
 });
 it.each(["progress","load"])("rejects an oversized receipt at %s without accepting its offset",async mode=>{
  const f=fixture(),operation=f.http.append(f.owner,f.tree,f.job,f.chunk).catch((error: unknown) =>error);
  if(mode==="progress")f.xhr.onprogress?.({loaded:65537});else{f.xhr.responseText='"'+"x".repeat(65536)+'"';f.xhr.onload?.();}
  expect(await operation).toMatchObject({message:expect.stringContaining("metadata bound") as unknown});
 });
 it("preserves server refusal codes and rejects malformed successful receipts",async()=>{
  const f=fixture(),refusal=f.http.append(f.owner,f.tree,f.job,f.chunk);f.xhr.reply({code:"browser_tree_authorization_changed"},403);
  await expect(refusal).rejects.toMatchObject({status:403,code:"browser_tree_authorization_changed"});
  const malformed=f.http.append(f.owner,f.tree,f.job,f.chunk);f.xhr.status=200;f.xhr.responseText="not JSON";f.xhr.onload?.();await expect(malformed).rejects.toThrow("Invalid streaming receipt");
 });
 it("bounds metadata and uses the normal cookie/CSRF helpers for the same original",async()=>{
  const f=fixture();const fetch=vi.fn(async()=>new Response("{}",{headers:{"content-type":"application/json"}}));vi.stubGlobal("fetch",fetch);
  await f.http.admit(f.owner,f.tree,"{}");await f.http.seal(f.drop,f.tree,f.job,randomUUID());await f.http.inspect(f.drop,f.tree,f.job);
  const calls=fetch.mock.calls as unknown as [string,RequestInit][];expect(requiredValue(calls[0])[1].credentials).toBe("same-origin");
  expect(new Headers(requiredValue(calls[0])[1].headers).get("X-Vault-CSRF")).toBe("owner-token");expect(new Headers(requiredValue(calls[1])[1].headers).get("X-Saturn-Drop-Channel")).toBe(f.drop.channelId);
  expect(requiredValue(calls[2])[1].method).toBe("GET");expect(new Headers(requiredValue(calls[2])[1].headers).has("X-Vault-CSRF")).toBe(false);
  await expect(f.http.admit(f.owner,f.tree,"x".repeat(65537))).rejects.toThrow("metadata");expect(fetch).toHaveBeenCalledTimes(3);
 });
});
