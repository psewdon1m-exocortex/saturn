import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {createHash,randomUUID} from "node:crypto";
import {expect,it,vi} from "vitest";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {folderRevalidationTreeSha256,type FolderRevalidationIntent,type FolderRevalidationTreeEntry} from "./catalog-folder-revalidation.js";
import {WindowsFolderRevalidationVerifier} from "./catalog-folder-revalidation-windows.js";

const sha=(v:string|Uint8Array)=>createHash("sha256").update(v).digest("hex");
const helper=fileURLToPath(new URL("../../../scripts/folder-revalidation-handles.ps1",import.meta.url));
async function fixture(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"saturn-folder-revalidation-")),backend=path.join(directory,"backend"),root=path.join(backend,"root"),sub=path.join(root,"sub");
  await fs.mkdir(sub,{recursive:true});await fs.writeFile(path.join(sub,"file"),"original bytes");
  const rootId=randomUUID(),subId=randomUUID(),fileId=randomUUID(),operationId=randomUUID(),version=()=>randomUUID();
  const tree:FolderRevalidationTreeEntry[]=[
    {storagePath:"root",description:{node_id:rootId,parent_id:null,name:"root",type:"folder",size_bytes:"14",content_sha256:null,content_version_id:null,version:version(),availability:"UNKNOWN"}},
    {storagePath:"root/sub",description:{node_id:subId,parent_id:rootId,name:"sub",type:"folder",size_bytes:"14",content_sha256:null,content_version_id:null,version:version(),availability:"AVAILABLE"}},
    {storagePath:"root/sub/file",description:{node_id:fileId,parent_id:subId,name:"file",type:"file",size_bytes:"14",content_sha256:sha("original bytes"),content_version_id:version(),version:version(),availability:"AVAILABLE"}},
  ];
  const now=Date.now(),intent:FolderRevalidationIntent={schema:"saturn.catalog-folder-revalidation-intent.v1",operationId,idempotencyKey:"folder-revalidate-"+operationId,
    binding:{protocol:"neptune-sync/1",descriptor_schema:"saturn.current-namespace.v1",root_id:rootId,server_epoch:version(),binding_version:version(),server_identity:version(),policy_version:"test"},guardRevision:version(),backendIdentity:"owned-test",deviceId:version(),expectedSeq:"4",observedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),
    custody:{backendGeneration:version(),bootstrapSha256:sha("owned fresh construction"),drainSha256:sha("no test writers"),backupSha256:sha("native-only test, no SQL"),treeSha256:folderRevalidationTreeSha256(tree)},tree,folders:[rootId]};
  const stat=await fs.stat(backend,{bigint:true}),close=vi.fn(async()=>{}),assertCurrent=vi.fn(async()=>{});
  const options={powershell:path.join(process.env["SystemRoot"]??"C:/Windows","System32/WindowsPowerShell/v1.0/powershell.exe"),handleScript:helper,handleScriptSha256:sha(await fs.readFile(helper)),evidenceDirectory:directory,
    acquireCustody:vi.fn(async()=>({backendRoot:backend,backendNativeIdentity:stat.dev.toString(16).padStart(8,"0")+":"+stat.ino.toString(16).padStart(16,"0"),custody:intent.custody,assertCurrent,close}))};
  // Native/physical proof only. This test creates the tree itself and has no DB.
  const cleanup=async()=>{const absolute=path.resolve(directory),parent=path.resolve(os.tmpdir());if(path.dirname(absolute)!==parent||!path.basename(absolute).startsWith("saturn-folder-revalidation-"))throw Error("Cleanup scope");await fs.rm(absolute,{recursive:true});};
  return {directory,backend,root,sub,intent,options,close,assertCurrent,cleanup,verifier:new WindowsFolderRevalidationVerifier(options)};
}
it.skipIf(process.platform!=="win32")("holds exact native identities and denies overwrite/rename until custody is released",async()=>{
  const f=await fixture(),lease=await f.verifier.acquire(f.intent);
  try{await expect(fs.writeFile(path.join(f.sub,"file"),"changed")).rejects.toThrow();await expect(fs.rename(f.root,f.root+"-moved")).rejects.toThrow();await lease.assertCurrent();expect(await fs.readFile(path.join(f.sub,"file"),"utf8")).toBe("original bytes");}
  finally{await lease.close();}expect(f.close).toHaveBeenCalledOnce();await fs.writeFile(path.join(f.sub,"file"),"released");await f.cleanup();
},20000);
it.skipIf(process.platform!=="win32")("holds the1024node boundary and refuses1025 before exposing physical authority",async()=>{
  const f=await fixture(),tree=[...f.intent.tree];
  try{
    for(let n=tree.length;n<1024;n++){
      const name="empty-"+String(n);await fs.writeFile(path.join(f.root,name),"");
      tree.push({storagePath:"root/"+name,description:{node_id:randomUUID(),parent_id:f.intent.binding.root_id,name,type:"file",size_bytes:"0",content_sha256:sha(""),content_version_id:randomUUID(),version:randomUUID(),availability:"AVAILABLE"}});
    }
    const intent={...f.intent,tree,custody:{...f.intent.custody,treeSha256:folderRevalidationTreeSha256(tree)}};
    const options={...f.options,acquireCustody:async()=>({...await f.options.acquireCustody(),custody:intent.custody})};
    const lease=await new WindowsFolderRevalidationVerifier(options).acquire(intent);
    try{await lease.assertCurrent();}finally{await lease.close();}
    const last=tree.at(-1);if(!last)throw Error("Missing boundary fixture");
    const oversized=[...tree,{...last,storagePath:"root/extra",description:{...last.description,node_id:randomUUID(),name:"extra"}}];
    await fs.writeFile(path.join(f.root,"extra"),"");
    await expect(new WindowsFolderRevalidationVerifier(options).acquire({...intent,tree:oversized})).rejects.toThrow("native_backend_refused");
  }finally{await f.cleanup();}
},30000);
it.skipIf(process.platform!=="win32").each(["missing","sha","extra","reparse"])("refuses physical %s without providing a lease",async mode=>{
  const f=await fixture();
  if(mode==="missing")await fs.rename(path.join(f.sub,"file"),path.join(f.backend,"preserved-file"));
  if(mode==="sha")await fs.writeFile(path.join(f.sub,"file"),"different byte");
  if(mode==="extra")await fs.writeFile(path.join(f.root,"foreign"),"foreign");
  if(mode==="reparse"){const saved=path.join(f.backend,"preserved-sub");await fs.rename(f.sub,saved);await fs.symlink(saved,f.sub,"junction");}
  await expect(f.verifier.acquire(f.intent)).rejects.toThrow("native_backend_refused");expect(f.close).toHaveBeenCalledOnce();await f.cleanup();
},20000);
it.skipIf(process.platform!=="win32")("detects membership changes during the held lease",async()=>{
  const f=await fixture(),lease=await f.verifier.acquire(f.intent);let created=false;
  try{try{await fs.writeFile(path.join(f.root,"new-child"),"change");created=true;}catch{await lease.assertCurrent();}
    if(created)await expect(lease.assertCurrent()).rejects.toThrow("native_backend_refused");
  }finally{await lease.close();}await f.cleanup();
},20000);
it.skipIf(process.platform!=="win32")("admits one backend operator and releases the actual mutex on close",async()=>{
  const f=await fixture(),first=await f.verifier.acquire(f.intent);
  try{await expect(new WindowsFolderRevalidationVerifier(f.options).acquire(f.intent)).rejects.toThrow("native_backend_refused");await first.assertCurrent();}
  finally{await first.close();}
  const next=await f.verifier.acquire(f.intent);await next.close();await f.cleanup();
},20000);
it.skipIf(process.platform!=="win32")("rejects an altered native helper before custody acquisition",async()=>{
  const f=await fixture(),v=new WindowsFolderRevalidationVerifier({...f.options,handleScriptSha256:"a".repeat(64)});
  await expect(v.acquire(f.intent)).rejects.toThrow("qualification_changed");expect(f.options.acquireCustody).not.toHaveBeenCalled();await f.cleanup();
},20000);
it.skipIf(process.platform!=="win32")("refuses a declared writer whose exact native process is still alive",async()=>{
  const f=await fixture(),pid=process.pid;
  const creation=(await promisify(execFile)(f.options.powershell,["-NoProfile","-NonInteractive","-Command",`(Get-Process -Id ${String(pid)}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`],{windowsHide:true})).stdout.trim();
  const v=new WindowsFolderRevalidationVerifier({...f.options,acquireCustody:async()=>({...await f.options.acquireCustody(),drainedProcesses:[{pid,creationFileTime:creation}]})});
  await expect(v.acquire(f.intent)).rejects.toThrow("native_backend_refused");await f.cleanup();
},20000);
