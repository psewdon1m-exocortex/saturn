import { type Resource } from "@saturn/file-core";
import { DeviceServiceError, resourceEtag } from "./device.service.js";

export function logicalResourcePath(path: string): readonly string[] {
  for(let index=0;index<path.length;index++)if(path.charCodeAt(index)<32||path.charCodeAt(index)===127)throw new DeviceServiceError("invalid_path");
  if (Buffer.byteLength(path)>4096 || (path!=="root"&&!path.startsWith("root/")) || /[\\:]/.test(path)
      || /%[0-9a-f]{2}/i.test(path)) throw new DeviceServiceError("invalid_path");
  const parts=path.split("/");
  if(parts.length>64||parts.some(part=>!part||part==="."||part===".."||part.length>255))throw new DeviceServiceError("invalid_path");
  return parts;
}

export function readerMetadata(resource:Resource,path:string){
  return {path,type:resource.type,name:resource.name,mime_type:resource.mimeType??"application/octet-stream",
    size_bytes:resource.sizeBytes,etag:resourceEtag(resource),modified_at:resource.updatedAt.toISOString()};
}

export class ReaderRangeError extends Error {constructor(readonly size:number){super("range_not_satisfiable");}}

export function readerRange(resource:Resource,header:string|undefined,ifRange?:string):{offset:number;length:number}|undefined{
  if(header===undefined)return undefined;
  if(ifRange!==undefined&&ifRange!==resourceEtag(resource)){
    const date=Date.parse(ifRange);
    if(!Number.isFinite(date)||Math.floor(resource.updatedAt.getTime()/1000)>Math.floor(date/1000))return undefined;
  }
  const match=/^bytes=(\d*)-(\d*)$/.exec(header),size=resource.sizeBytes;
  if(!match||match[0]!==header||header.length>100||(!match[1]&&!match[2])||size===0)throw new ReaderRangeError(size);
  if(!match[1]){
    const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)throw new ReaderRangeError(size);
    const length=Math.min(suffix,size);return{offset:size-length,length};
  }
  const offset=Number(match[1]),end=match[2]?Number(match[2]):size-1;
  if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(end)||offset>=size||end<offset)throw new ReaderRangeError(size);
  return {offset,length:Math.min(end,size-1)-offset+1};
}
