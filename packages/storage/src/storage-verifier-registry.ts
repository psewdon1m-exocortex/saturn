import { constants } from "node:fs";
import { lstat, mkdir, open, rename, link, unlink, realpath } from "node:fs/promises";
import { join, resolve, parse } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { StorageVerifyError, type StorageVerifyRequest } from "../../contracts/src/storage-verifier.js";

export type VerifierObject = Pick<StorageVerifyRequest,"contentVersionId"|"relativePath"|"sizeBytes"|"sha256">;
type Identity = Pick<StorageVerifyRequest,"backendIdentity"|"backendGeneration"|"ownerId"|"fencingToken">;
/** An explicitly mounted protected channel, independent of SFTP/HTTP. Registry
 * records grant no authority until the host also confirms its configured root.
 * No record is deleted by age and an operation record is never overwritten. */
export class StorageVerifierRegistry {
  readonly directory:string;
  constructor(directory:string){this.directory=resolve(directory);if(this.directory!==directory||directory===parse(directory).root)throw new StorageVerifyError("invalid_input");}
  async #directory(path:string):Promise<void>{
    if(await realpath(path)!==path)throw new StorageVerifyError("scope_denied");
    const st=await lstat(path);
    if(!st.isDirectory()||st.isSymbolicLink()||process.platform!=="win32"&&((st.mode&0o022)!==0||st.uid!==process.getuid?.()))throw new StorageVerifyError("scope_denied");
  }
  async initialize():Promise<void>{
    await this.#directory(this.directory);
    for(const name of ["owners","operations"]){const p=join(this.directory,name);await mkdir(p,{mode:0o700}).catch((error: unknown)=>{if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;});await this.#directory(p);}
  }
  async #read(path:string):Promise<Buffer>{
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const st=await handle.stat();if(!st.isFile()||st.nlink!==1||st.size>65536||process.platform!=="win32"&&((st.mode&0o077)!==0||st.uid!==process.getuid?.()))throw new StorageVerifyError("scope_denied");return await handle.readFile();}finally{await handle.close();}
  }
  async #write(group:"owners"|"operations",name:string,value:unknown,immutable:boolean):Promise<void>{
    const dir=join(this.directory,group);await this.#directory(dir);
    const target=join(dir,name),bytes=Buffer.from(JSON.stringify(value));
    if(immutable){try{const old=await this.#read(target);if(!old.equals(bytes))throw new StorageVerifyError("identity_mismatch");return;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
    const temporary=join(dir,"."+randomUUID()+".tmp"),handle=await open(temporary,"wx",0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    try{
      if(immutable){
        try{await link(temporary,target);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
        // Drop the staging link before the host requires nlink=1.
        await unlink(temporary);
        if(!(await this.#read(target)).equals(bytes))throw new StorageVerifyError("identity_mismatch");
      }else await rename(temporary,target);
      if(process.platform!=="win32"){const parent=await open(dir,constants.O_RDONLY|constants.O_DIRECTORY);try{await parent.sync();}finally{await parent.close();}}
      await this.#directory(dir);
    }finally{await unlink(temporary).catch((error: unknown)=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});}
  }
  owner(identity:Identity,state:"ACTIVE"|"STOPPED"):Promise<void>{
    return this.#write("owners",createHash("sha256").update(identity.backendIdentity).digest("hex")+".json",{schema:"saturn.storage-verifier-owner.v1",state,...identity},false);
  }
  operation(request:StorageVerifyRequest,objects:readonly VerifierObject[]):Promise<void>{
    const {backendIdentity,backendGeneration,ownerId,fencingToken,rootId,operationId,intentSha256}=request;
    if(!objects.length||objects.length>2)throw new StorageVerifyError("invalid_input");
    return this.#write("operations",operationId+".json",{schema:"saturn.storage-verifier-operation.v1",state:"SEALED",backendIdentity,backendGeneration,ownerId,fencingToken,rootId,operationId,intentSha256,objects},true);
  }
}
