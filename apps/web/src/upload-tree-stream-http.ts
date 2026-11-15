import {ApiError,request,dropRequest} from "./api.js";
import type {UploadTreeScope} from "./upload-tree-durable.js";
import {UPLOAD_TREE_STREAM_CHUNK_BYTES} from "./upload-tree-stream.js";
import type {UploadTreeStreamChunkIntent} from "./upload-tree-stream-progress.js";
import {errorValue} from "./error-value.js";

export interface UploadTreeStreamHttp {
 capability(scope:UploadTreeScope,signal?:AbortSignal):Promise<unknown>;
 admit(scope:UploadTreeScope,treeId:string,encoded:string,signal?:AbortSignal):Promise<unknown>;
 inspect(scope:UploadTreeScope,treeId:string,jobId:string,signal?:AbortSignal):Promise<unknown>;
 append(scope:UploadTreeScope,treeId:string,jobId:string,chunk:UploadTreeStreamChunkIntent&{readonly bytes:Uint8Array<ArrayBuffer>},signal?:AbortSignal):Promise<unknown>;
 seal(scope:UploadTreeScope,treeId:string,jobId:string,sealId:string,signal?:AbortSignal):Promise<unknown>;
 execute(scope:UploadTreeScope,treeId:string,jobId:string,signal?:AbortSignal):Promise<unknown>;
 cancel(scope:UploadTreeScope,treeId:string,jobId:string,signal?:AbortSignal):Promise<unknown>;
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function route(scope:UploadTreeScope,treeId?:string,jobId?:string):string{
 if(scope.kind==="owner"?!uuid.test(scope.rootId):(scope.kind as unknown)!=="drop"||!uuid.test(scope.channelId))throw Error("Invalid original streaming scope");
 if(treeId===undefined)return "/upload-trees/stream-capabilities";
 if(!uuid.test(treeId)||jobId!==undefined&&!uuid.test(jobId))throw Error("Invalid original stream identity");
 return "/upload-trees/"+(scope.kind==="owner"?scope.rootId+"/":"")+treeId+"/stream-jobs"+(jobId===undefined?"":"/"+jobId);
}
async function metadata(scope:UploadTreeScope,path:string,method:string,body:string|undefined,signal?:AbortSignal):Promise<unknown>{
 if(body!==undefined&&new TextEncoder().encode(body).length>65536)throw Error("Streaming metadata exceeds its bound");
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason),timer=setTimeout(()=>controller.abort(Error("Stream metadata timeout; inspect the same original before retrying")),30000);
 signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
 try{const options:RequestInit={method,signal:controller.signal,...(body===undefined?{}:{headers:{"Content-Type":"application/json"},body})};return await(scope.kind==="owner"?request(path,options):dropRequest(path,options,true,scope.channelId));}
 finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
}
function csrf(scope:UploadTreeScope):string|undefined{
 const names=scope.kind==="owner"?["vault_csrf_dev","__Host-vault_csrf"]:["vault_drop_csrf_dev","__Host-vault_drop_csrf"];
 const value=document.cookie.split(";").map(v=>v.trim()).find(v=>names.some(name=>v.startsWith(name+"=")));return value===undefined?undefined:decodeURIComponent(value.slice(value.indexOf("=")+1));
}
/** XHR provides upload progress in browsers without request streaming. Only a
 * bounded4MiB original chunk is held; no total content deadline is imposed.
 * Abort rejection waits for the XHR abort event, so the caller retains its slot
 * until the active request has settled. Server outcome may still be unknown. */
export function createUploadTreeStreamHttp(createXhr:()=>XMLHttpRequest=()=>new XMLHttpRequest()):UploadTreeStreamHttp{
 return {
  capability:(scope,signal)=>metadata(scope,route(scope),"GET",undefined,signal),
  admit:(scope,tree,encoded,signal)=>metadata(scope,route(scope,tree),"POST",encoded,signal),
  inspect:(scope,tree,job,signal)=>metadata(scope,route(scope,tree,job),"GET",undefined,signal),
  seal:(scope,tree,job,sealId,signal)=>{if(!uuid.test(sealId))return Promise.reject(Error("Invalid original stream seal"));return metadata(scope,route(scope,tree,job)+"/seal","POST",JSON.stringify({sealId}),signal);},
  execute:(scope,tree,job,signal)=>metadata(scope,route(scope,tree,job)+"/execute","POST","{}",signal),
  cancel:(scope,tree,job,signal)=>metadata(scope,route(scope,tree,job),"DELETE",undefined,signal),
  append(scope,tree,job,chunk,signal){
   signal?.throwIfAborted();const path=route(scope,tree,job)+"/chunks";
   if(!Number.isSafeInteger(chunk.offset)||chunk.offset<0||chunk.offset%UPLOAD_TREE_STREAM_CHUNK_BYTES!==0||chunk.length<1||chunk.length>UPLOAD_TREE_STREAM_CHUNK_BYTES
    ||chunk.bytes.byteLength!==chunk.length||!/^[a-f0-9]{64}$/.test(chunk.sha256))throw Error("Invalid bounded stream HTTP chunk");
   const token=csrf(scope);return new Promise<unknown>((resolve,reject)=>{
    const xhr=createXhr();let finished=false,started=false,connected=false,timer:ReturnType<typeof setTimeout>|undefined,reason:unknown,uploaded=0,downloaded=0;
    const finish=(error:unknown,value?:unknown)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);xhr.onload=xhr.onerror=xhr.onabort=xhr.ontimeout=xhr.onreadystatechange=xhr.onprogress=null;xhr.upload.onprogress=xhr.upload.onload=null;if(error!==undefined)reject(errorValue(error));else resolve(value);};
    const stop=(error:unknown)=>{if(finished)return;reason=error;clearTimeout(timer);if(started)xhr.abort();else finish(error);};
    const arm=(milliseconds:number,message:string)=>{clearTimeout(timer);timer=setTimeout(()=>stop(Error(message)),milliseconds);};
    const activity=()=>{connected=true;arm(120000,"Stream data idle timeout; inspect the same original before retrying");};
    const abort=()=>stop(signal?.reason??Error("Stream request cancelled"));
    xhr.onabort=()=>finish(reason??Error("Stream request aborted; original retained"));xhr.onerror=()=>finish(Error("Stream network error; original retained"));xhr.ontimeout=()=>finish(Error("Stream request timeout; original retained"));
    xhr.upload.onprogress=event=>{if(event.loaded>uploaded){uploaded=event.loaded;activity();}};
    xhr.upload.onload=()=>activity();xhr.onreadystatechange=()=>{if(xhr.readyState>=2&&!connected)activity();};
    xhr.onprogress=event=>{if(event.loaded>65536){stop(Error("Stream response exceeds metadata bound"));return;}if(event.loaded>downloaded){downloaded=event.loaded;activity();}};
    xhr.onload=()=>{try{
     if(new TextEncoder().encode(xhr.responseText).length>65536)throw Error("Stream response exceeds metadata bound");
     let body:unknown;try{body=JSON.parse(xhr.responseText);}catch{if(xhr.status>=200&&xhr.status<300)throw Error("Invalid streaming receipt response");}
     if(xhr.status<200||xhr.status>=300)throw new ApiError(xhr.status,body);finish(undefined,body);
    }catch(error){finish(error);}};
    try{
     xhr.open("PATCH","/api/v1"+(scope.kind==="drop"?"/drop":"")+path,true);xhr.responseType="text";xhr.timeout=0;
     xhr.setRequestHeader("Content-Type","application/offset+octet-stream");xhr.setRequestHeader("Upload-Offset",String(chunk.offset));xhr.setRequestHeader("X-Saturn-Chunk-Sha256",chunk.sha256);
     if(token!==undefined)xhr.setRequestHeader("X-Vault-CSRF",token);if(scope.kind==="drop")xhr.setRequestHeader("X-Saturn-Drop-Channel",scope.channelId);
     signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted){abort();return;}
     arm(15000,"Stream connection timeout; inspect the same original before retrying");started=true;xhr.send(chunk.bytes);
    }catch(error){finish(error);}
   });
  }
 };
}
export const uploadTreeStreamHttp=createUploadTreeStreamHttp();
