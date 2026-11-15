import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {FolderRevalidationError,type FolderRevalidationIntent,type FolderRevalidationCustody,
  type FolderRevalidationBackendLease,type FolderRevalidationBackendVerifier} from "./catalog-folder-revalidation.js";

/** Supplied by the private operator's qualified offline custody composition.
 * The directory identity is a new held preimage, never inferred historical mkdir
 * authority. Bootstrap/drain/backup proof must have independent provenance. */
export interface WindowsFolderRevalidationCustodyLease {
  readonly backendRoot:string;readonly backendNativeIdentity:string;readonly custody:FolderRevalidationCustody;
  readonly drainedProcesses?:readonly {readonly pid:number;readonly creationFileTime:string}[];
  assertCurrent(signal?:AbortSignal):Promise<void>;
  close():Promise<void>;
}
export interface WindowsFolderRevalidationOptions {
  readonly powershell:string;readonly handleScript:string;readonly handleScriptSha256:string;
  /** Existing protected operator directory; never a request-supplied path. */
  readonly evidenceDirectory:string;
  acquireCustody(intent:FolderRevalidationIntent,signal?:AbortSignal):Promise<WindowsFolderRevalidationCustodyLease>;
}
function refused(code:string):never{throw new FolderRevalidationError(code);}

/** Windows-only held-handle verifier, <=1024 nodes/128MiB, single stream.
 * The native child has a 90s hard lifetime, exits on EOF and owns a backend-wide
 * mutex. Every file denies write/delete sharing for the entire SQL interval. */
export class WindowsFolderRevalidationVerifier implements FolderRevalidationBackendVerifier {
  constructor(private readonly options:WindowsFolderRevalidationOptions){}
  async acquire(intent:FolderRevalidationIntent,signal?:AbortSignal):Promise<FolderRevalidationBackendLease>{
    if(process.platform!=="win32")refused("native_backend_unavailable");if(signal?.aborted)refused("cancelled");
    const o=this.options;
    for(const file of [o.powershell,o.handleScript,o.evidenceDirectory])if(!path.isAbsolute(file))refused("custody_invalid");
    const info=await fs.lstat(o.handleScript),directory=await fs.lstat(o.evidenceDirectory);
    if(!info.isFile()||info.isSymbolicLink()||info.size>65536||!directory.isDirectory()||directory.isSymbolicLink())refused("custody_invalid");
    if(createHash("sha256").update(await fs.readFile(o.handleScript)).digest("hex")!==o.handleScriptSha256)refused("qualification_changed");
    const custody=await o.acquireCustody(intent,signal);
    let closeNative:(()=>Promise<void>)|undefined;
    try{
      await custody.assertCurrent(signal);
      if(!path.isAbsolute(custody.backendRoot)||!/^[a-f\d]{8}:[a-f\d]{16}$/.test(custody.backendNativeIdentity))refused("custody_invalid");
      const planFile=path.join(o.evidenceDirectory,"held-tree-"+randomUUID()+".json");
      const plan=JSON.stringify({schema:"saturn.folder-revalidation-native-plan.v1",backendRoot:custody.backendRoot,intent,...(custody.drainedProcesses?{drainedProcesses:custody.drainedProcesses}:{})});
      if(Buffer.byteLength(plan)>4259840)refused("invalid_input");
      const handle=await fs.open(planFile,"wx",0o600);try{await handle.writeFile(plan);await handle.sync();}finally{await handle.close();}
      const child=spawn(o.powershell,["-NoProfile","-NonInteractive","-File",o.handleScript,"-PlanFile",planFile],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
      const queue:unknown[]=[];let waiting:{resolve:(v:unknown)=>void;reject:(e:Error)=>void}|undefined,ended=false,closed=false;
      let stderrBytes=0;
      child.stderr.on("data",(bytes:Buffer)=>{stderrBytes+=bytes.length;if(stderrBytes>16384)child.stdin.end();});
      child.stdin.on("error",()=>{});
      const lines=createInterface({input:child.stdout});
      const stop=(error:Error)=>{ended=true;waiting?.reject(error);waiting=undefined;child.stdin.end();};
      lines.on("line",line=>{
        try{if(line.length>4096)refused("native_projection_mismatch");const value:unknown=JSON.parse(line);if(waiting){waiting.resolve(value);waiting=undefined;}else if(queue.length<4)queue.push(value);else stop(new FolderRevalidationError("native_projection_mismatch"));}
        catch{stop(new FolderRevalidationError("native_projection_mismatch"));}
      });
      const exit=new Promise<number|null>(resolve=>{child.once("error",()=>{stop(new FolderRevalidationError("native_backend_unavailable"));resolve(null);});child.once("exit",code=>{stop(new FolderRevalidationError("native_backend_refused"));resolve(code);});});
      const next=async():Promise<Record<string,unknown>>=>{
        let value:unknown;
        if(queue.length)value=queue.shift();else{
          if(ended)refused("native_backend_refused");
          value=await new Promise<unknown>((resolve,reject)=>{
            const timer=setTimeout(()=>{waiting=undefined;child.stdin.end();reject(new FolderRevalidationError("native_verification_timeout"));},15000);
            waiting={resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}};
          });
        }
        if(!value||typeof value!=="object"||Array.isArray(value))refused("native_projection_mismatch");return value as Record<string,unknown>;
      };
      closeNative=async()=>{
        if(closed)return;closed=true;
        // EOF is enough even after a partial startup. No PID-only kill path.
        child.stdin.end();await exit;lines.close();
      };
      const ready=await next();
      if(ready["type"]!=="ready"||ready["backendNativeIdentity"]!==custody.backendNativeIdentity
        ||ready["files"]!==intent.tree.filter(e=>e.description.type==="file").length||ready["folders"]!==intent.tree.filter(e=>e.description.type==="folder").length
        ||ready["bytes"]!==intent.tree.filter(e=>e.description.type==="file").reduce((sum,e)=>sum+BigInt(e.description.size_bytes),0n).toString())refused("custody_changed");
      const close=closeNative;
      const assertCurrent=async(currentSignal?:AbortSignal)=>{
        if(currentSignal?.aborted)refused("cancelled");if(ended||closed)refused("custody_changed");
        await custody.assertCurrent(currentSignal);const id=randomUUID();child.stdin.write(JSON.stringify({action:"check",id})+"\n");const checked=await next();
        if(checked["type"]!=="checked"||checked["id"]!==id)refused("native_projection_mismatch");
        await custody.assertCurrent(currentSignal);if(currentSignal?.aborted)refused("cancelled");
      };
      await assertCurrent(signal);
      await fs.writeFile(planFile+".lease.json",JSON.stringify({schema:"saturn.folder-revalidation-native-lease.v1",at:new Date().toISOString(),pid:child.pid,ready,scriptSha256:o.handleScriptSha256})+"\n",{flag:"wx",mode:0o600});
      return {custody:custody.custody,assertCurrent,close:async()=>{try{await close();}finally{await custody.close();}}};
    }catch(error){try{await closeNative?.();}finally{await custody.close();}throw error;}
  }
}
