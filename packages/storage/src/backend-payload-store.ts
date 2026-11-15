import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface BackendPayloadReference { readonly id:string; readonly size:string; readonly sha256:string }
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Durable, generation-scoped payloads. SQL receives only this sealed reference.
 * Orphans are retained after ambiguous submission. Removal requires a terminal
 * queue ACK, or an invocation-bound first-submit SQL rollback proving this fresh
 * candidate was never admitted. This directory persists across replacement. */
export class BackendPayloadStore {
  readonly directory:string;
  #ready:Promise<void>|undefined;
  constructor(root:string,backendIdentity:string,generation:string){
    if(!path.isAbsolute(root)||!uuid.test(generation))throw Error("invalid_payload_store");
    this.directory=path.join(root,createHash("sha256").update(backendIdentity).digest("hex"),generation);
  }
  initialize():Promise<void>{return this.#ready??=this.#initialize();}
  async #initialize(){
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    // Refuse symlink/junction ancestors, including an already existing root.
    for(let current=this.directory;;current=path.dirname(current)){
      const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error("invalid_payload_store");
      if(path.dirname(current)===current)break;
    }
  }
  #path(ref:BackendPayloadReference|null|undefined):string{
    if(!ref||!uuid.test(ref.id)||!/^([1-9][0-9]{0,6}|0)$/.test(ref.size)||BigInt(ref.size)>4194304n||!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error("invalid_payload_reference");
    return path.join(this.directory,ref.id+".payload");
  }
  async put(bytes:Buffer):Promise<BackendPayloadReference>{
    await this.initialize();
    if(bytes.length>4194304)throw Error('invalid_payload_reference');
    const capacity=await fs.statfs(this.directory,{bigint:true});
    if(capacity.bavail*capacity.bsize<BigInt(bytes.length)+268435456n)throw Error('capacity');
    const ref={id:randomUUID(),size:String(bytes.length),sha256:createHash("sha256").update(bytes).digest("hex")};
    const file=await fs.open(this.#path(ref),"wx",0o600);
    try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    // A POSIX directory fsync seals the new name before SQL can reference it.
    // Windows does not expose directory fsync through Node; file sync/close
    // precedes admission and a missing name fails closed before any raw effect.
    if(process.platform!=="win32"){const dir=await fs.open(this.directory,"r");try{await dir.sync();}finally{await dir.close();}}
    return Object.freeze(ref);
  }
  async read(ref:BackendPayloadReference):Promise<Buffer>{
    await this.initialize();const name=this.#path(ref),before=await fs.lstat(name);
    if(!before.isFile()||before.isSymbolicLink()||String(before.size)!==ref.size)throw Error("payload_integrity_failed");
    const file=await fs.open(name,"r");
    try{
      const stat=await file.stat();if(stat.ino!==before.ino||stat.dev!==before.dev||String(stat.size)!==ref.size)throw Error("payload_integrity_failed");
      const bytes=Buffer.alloc(Number(ref.size));let offset=0;
      while(offset<bytes.length){const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw Error("payload_integrity_failed");offset+=bytesRead;}
      if((await file.stat()).size!==bytes.length||createHash("sha256").update(bytes).digest("hex")!==ref.sha256)throw Error("payload_integrity_failed");
      return bytes;
    }finally{await file.close();}
  }
  async remove(ref:BackendPayloadReference):Promise<void>{await fs.rm(this.#path(ref),{force:true});}
}
