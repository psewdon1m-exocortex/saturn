import {UPLOAD_TREE_STREAM_CHUNK_BYTES} from "./upload-tree-stream.js";

export interface UploadTreeStreamIdentity {
 readonly treeId:string;readonly jobId:string;readonly itemId:string;readonly intentSha256:string;readonly sizeBytes:number;readonly sha256:string;
}
export interface UploadTreeStreamChunkIntent {readonly offset:number;readonly length:number;readonly sha256:string}
export interface UploadTreeStreamProgress {
 readonly sealId:string;readonly confirmedOffset:number;readonly state:"receiving"|"sealed";readonly sealPending:boolean;
 readonly pending:UploadTreeStreamChunkIntent|null;readonly lastChunk:UploadTreeStreamChunkIntent|null;
}
export interface UploadTreeStreamStatus extends UploadTreeStreamIdentity {
 readonly schema:"saturn.browser-tree-stream-status.v1";readonly sealId:string;readonly confirmedOffset:number;
 readonly state:"receiving"|"sealed";readonly sealSha256:string|null;readonly lastChunk:UploadTreeStreamChunkIntent|null;
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,sha=/^[a-f0-9]{64}$/;
function fail(message:string):never{throw Error(message);}
function closed(value:unknown,keys:readonly string[]):void{
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail("Invalid streaming progress metadata");
}
function identity(value:UploadTreeStreamIdentity):void{
 if(![value.treeId,value.jobId,value.itemId].every(x=>uuid.test(x))||!sha.test(value.intentSha256)||!sha.test(value.sha256)||!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<=262144)fail("Invalid original stream identity");
}
function chunk(sizeBytes:number,value:UploadTreeStreamChunkIntent):void{
 closed(value,["offset","length","sha256"]);
 if(!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>=sizeBytes||value.offset%UPLOAD_TREE_STREAM_CHUNK_BYTES!==0
  ||value.length!==Math.min(UPLOAD_TREE_STREAM_CHUNK_BYTES,sizeBytes-value.offset)||!sha.test(value.sha256))fail("Invalid fixed streaming chunk intent");
}
function same(a:UploadTreeStreamChunkIntent|null,b:UploadTreeStreamChunkIntent|null):boolean{
 return a===null?b===null:b!==null&&a.offset===b.offset&&a.length===b.length&&a.sha256===b.sha256;
}
function confirmed(sizeBytes:number,offset:number,last:UploadTreeStreamChunkIntent|null):void{
 if(!Number.isSafeInteger(offset)||offset<0||offset>sizeBytes||offset!==sizeBytes&&offset%UPLOAD_TREE_STREAM_CHUNK_BYTES!==0)fail("Invalid confirmed streaming offset");
 if(offset===0){if(last!==null)fail("Unexpected streaming chunk receipt");}
 else{if(last===null)fail("Missing last streaming chunk receipt");chunk(sizeBytes,last);if(last.offset+last.length!==offset)fail("Streaming receipt offset mismatch");}
}
function freeze(value:UploadTreeStreamProgress):UploadTreeStreamProgress{
 return Object.freeze({...value,pending:value.pending===null?null:Object.freeze({...value.pending}),lastChunk:value.lastChunk===null?null:Object.freeze({...value.lastChunk})});
}
export function validateUploadTreeStreamProgress(original:UploadTreeStreamIdentity,progress:UploadTreeStreamProgress):void{
 identity(original);closed(progress,["sealId","confirmedOffset","state","sealPending","pending","lastChunk"]);
 if(!uuid.test(progress.sealId)||!["receiving","sealed"].includes(progress.state)||typeof progress.sealPending!=="boolean")fail("Invalid streaming progress state");
 confirmed(original.sizeBytes,progress.confirmedOffset,progress.lastChunk);
 if(progress.pending!==null){chunk(original.sizeBytes,progress.pending);if(progress.pending.offset!==progress.confirmedOffset||progress.state!=="receiving"||progress.sealPending)fail("Streaming pending original changed");}
 if((progress.sealPending||progress.state==="sealed")&&(progress.confirmedOffset!==original.sizeBytes||progress.pending!==null))fail("Streaming seal precedes confirmed bytes");
 if(progress.state==="sealed"&&progress.sealPending)fail("Confirmed stream seal cannot remain pending");
}
/** One exact pending descriptor, committed strictly BEFORE append. Replayed
 * bytes must hash to that descriptor; uncertainty never allocates another one. */
export function beginUploadTreeStreamChunk(original:UploadTreeStreamIdentity,progress:UploadTreeStreamProgress,intent:UploadTreeStreamChunkIntent):UploadTreeStreamProgress{
 validateUploadTreeStreamProgress(original,progress);chunk(original.sizeBytes,intent);
 if(progress.state!=="receiving"||progress.sealPending||intent.offset!==progress.confirmedOffset)fail("Streaming chunk is not the next original offset");
 if(progress.pending!==null&&!same(progress.pending,intent))fail("Pending stream chunk cannot change");
 return freeze({...progress,pending:intent});
}
/** The server reports only the same original and the last closed/committed
 * chunk. A larger offset needs the exact already-persisted pending descriptor.
 * This receipt validates local spool progress, never final publication. */
export function applyUploadTreeStreamStatus(original:UploadTreeStreamIdentity,previous:UploadTreeStreamProgress|undefined,value:unknown):UploadTreeStreamProgress{
 identity(original);if(previous)validateUploadTreeStreamProgress(original,previous);
 closed(value,["schema","treeId","jobId","itemId","intentSha256","sizeBytes","sha256","sealId","confirmedOffset","state","sealSha256","lastChunk"]);
 const status=value as UploadTreeStreamStatus;
 if((status.schema as unknown)!=="saturn.browser-tree-stream-status.v1"||status.treeId!==original.treeId||status.jobId!==original.jobId||status.itemId!==original.itemId
  ||status.intentSha256!==original.intentSha256||status.sizeBytes!==original.sizeBytes||status.sha256!==original.sha256||!uuid.test(status.sealId)
  ||!["receiving","sealed"].includes(status.state))fail("Streaming status differs from its original");
 confirmed(original.sizeBytes,status.confirmedOffset,status.lastChunk);
 if(status.state==="sealed"?(status.confirmedOffset!==original.sizeBytes||status.sealSha256!==original.sha256):status.sealSha256!==null)fail("Invalid full streaming seal");
 if(previous&&(status.sealId!==previous.sealId||status.confirmedOffset<previous.confirmedOffset||previous.state==="sealed"&&status.state!=="sealed"))fail("Confirmed streaming original cannot regress or change");
 const before=previous?.confirmedOffset??0,pending=previous?.pending??null;
 if(status.confirmedOffset===before){if(!same(status.lastChunk,previous?.lastChunk??null))fail("Confirmed streaming chunk receipt cannot change");}
 else if(!pending||status.confirmedOffset!==pending.offset+pending.length||!same(status.lastChunk,pending))fail("Streaming progress lacks its exact durable chunk intent");
 const next=freeze({sealId:status.sealId,confirmedOffset:status.confirmedOffset,state:status.state,sealPending:status.state!=="sealed"&&(previous?.sealPending??false),pending:status.confirmedOffset===before?pending:null,lastChunk:status.lastChunk});
 validateUploadTreeStreamProgress(original,next);return next;
}
export function beginUploadTreeStreamSeal(original:UploadTreeStreamIdentity,progress:UploadTreeStreamProgress):UploadTreeStreamProgress{
 validateUploadTreeStreamProgress(original,progress);if(progress.confirmedOffset!==original.sizeBytes||progress.pending!==null)fail("Streaming source is not fully confirmed");
 return freeze({...progress,sealPending:progress.state!=="sealed"});
}
