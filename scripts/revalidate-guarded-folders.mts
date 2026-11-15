import fs from "node:fs/promises";
import {createReadStream} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {Database} from "../packages/database/src/index.js";
import {qualifyCatalogDatabaseRoles,type CatalogDatabaseRolePolicy} from "../packages/database/src/catalog-role-qualification.js";
import {DeviceService} from "../packages/sync/src/device.service.js";
import {PostgresDeviceRepository} from "../packages/sync/src/postgres-device.repository.js";
import {FileService} from "../packages/file-core/src/file.service.js";
import {PostgresFileRepository} from "../packages/file-core/src/postgres-file.repository.js";
import {LocalStorageAdapter} from "../packages/storage/src/local-storage.adapter.js";
import {CatalogFolderAuthorityIssuer} from "../packages/file-core/src/catalog-folder-authority.js";
import {CatalogFolderRevalidationOperator,FolderRevalidationEvidenceIssuer,FolderRevalidationError,parseFolderRevalidationIntent,
  type FolderRevalidationBinding,type FolderRevalidationIntent} from "../packages/file-core/src/catalog-folder-revalidation.js";
import {WindowsFolderRevalidationVerifier} from "../packages/file-core/src/catalog-folder-revalidation-windows.js";

// Private, offline, loopback-only tool. Provision/review the protected plan and
// receipts out of band. It does not stop writers, migrate, grant privileges,
// alter an original intent, enable ACTIVE, or install a synchronization route.
interface Ref {file:string;sha256:string}
interface Plan {
  schema:string;original:Ref;
  binding:FolderRevalidationBinding;guardRevision:string;backendIdentity:string;backendRoot:string;backendNativeIdentity:string;backendGeneration:string;
  runtimeDatabaseUrlFile:string;writerDatabaseUrlFile:string;authorizationFile:string;pepperFile:string;evidenceDirectory:string;
  powershell:string;nativeHelper:string;nativeHelperSha256:string;
  roles:Pick<CatalogDatabaseRolePolicy,"runtimeRole"|"writerLogin"|"writerOwner"|"migratorRole">;
  approvedFunctions:CatalogDatabaseRolePolicy["approvedFunctions"];
  bootstrap:Ref;drain:Ref;backup:Ref;
}
const SHA=/^[a-f\d]{64}$/;
function refuse(code:string):never{throw new FolderRevalidationError(code);}
function record(v:unknown):Record<string,unknown>{if(!v||typeof v!=="object"||Array.isArray(v))refuse("invalid_operator_plan");return v as Record<string,unknown>;}
function canonical(v:unknown):string{
  if(Array.isArray(v))return "["+v.map(canonical).join(",")+"]";
  if(v&&typeof v==="object")return "{"+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+":"+canonical(x)).join(",")+"}";
  return JSON.stringify(v);
}
const sha=(v:Uint8Array|string)=>createHash("sha256").update(v).digest("hex");
async function bounded(file:string,maximum=4*1024*1024):Promise<Buffer>{
  if(typeof file!=="string"||!path.isAbsolute(file)||file.length>4096)refuse("invalid_operator_path");
  const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>maximum)refuse("operator_artifact_unqualified");
  const h=await fs.open(file,"r");try{const bytes=Buffer.alloc(maximum+1),r=await h.read(bytes,0,bytes.length,0);if(r.bytesRead<1||r.bytesRead>maximum)refuse("operator_artifact_unqualified");return bytes.subarray(0,r.bytesRead);}finally{await h.close();}
}
async function pinned(value:unknown):Promise<Buffer>{const ref=record(value);if(Object.keys(ref).length!==2||typeof ref["file"]!=="string"||typeof ref["sha256"]!=="string"||!SHA.test(ref["sha256"]))refuse("invalid_operator_plan");const bytes=await bounded(ref["file"]);if(sha(bytes)!==ref["sha256"])refuse("qualification_changed");return bytes;}
async function fileDigest(file:string,maximum:bigint):Promise<{sha256:string;size:string}>{
  const before=await fs.lstat(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.size>maximum)refuse("backup_invalid");
  const hash=createHash("sha256");let size=0n;
  for await(const raw of createReadStream(file,{highWaterMark:65536,signal:AbortSignal.timeout(15000)})){const bytes:unknown=raw;if(!Buffer.isBuffer(bytes))refuse("backup_invalid");size+=BigInt(bytes.length);if(size>maximum)refuse("backup_invalid");hash.update(bytes);}
  const after=await fs.lstat(file,{bigint:true});if(size!==before.size||after.ino!==before.ino||after.dev!==before.dev||after.mtimeNs!==before.mtimeNs||after.size!==before.size)refuse("backup_changed");
  return {sha256:hash.digest("hex"),size:size.toString()};
}
function sameContext(r:Record<string,unknown>,schema:string,p:Plan):void{
  if(r["schema"]!==schema||canonical(r["binding"])!==canonical(p.binding)||r["backendIdentity"]!==p.backendIdentity
    ||r["backendRoot"]!==p.backendRoot||r["backendGeneration"]!==p.backendGeneration)refuse("custody_invalid");
}
async function receipts(p:Plan,i:FolderRevalidationIntent){
  const bootstrap=record(JSON.parse((await pinned(p.bootstrap)).toString("utf8"))),drain=record(JSON.parse((await pinned(p.drain)).toString("utf8"))),backup=record(JSON.parse((await pinned(p.backup)).toString("utf8")));
  sameContext(bootstrap,"saturn.offline-folder-bootstrap.v1",p);sameContext(drain,"saturn.offline-folder-drain.v1",p);sameContext(backup,"saturn.offline-folder-backup.v1",p);
  if(p.bootstrap.sha256!==i.custody.bootstrapSha256||p.drain.sha256!==i.custody.drainSha256||p.backup.sha256!==i.custody.backupSha256||p.backendGeneration!==i.custody.backendGeneration
    ||drain["backendNativeIdentity"]!==p.backendNativeIdentity||backup["expectedSeq"]!==i.expectedSeq||backup["treeSha256"]!==i.custody.treeSha256)refuse("custody_invalid");
  const construction=bootstrap["acceptedConstruction"];
  if(!Array.isArray(construction)||construction.length<1||construction.length>16)refuse("bootstrap_unproved");
  for(const ref of construction)await pinned(ref);
  const rootProof:unknown=JSON.parse((await pinned(bootstrap["rootProof"])).toString("utf8"));
  if(!Array.isArray(rootProof)||rootProof.length>16||rootProof.filter(r=>{const item=record(r);return item["rootId"]===i.binding.root_id&&item["backendIdentity"]===i.backendIdentity&&item["physicalDirectoryVerified"]===true&&item["availability"]==="AVAILABLE"&&item["scope"]==="fresh empty synthetic root only";}).length!==1)refuse("bootstrap_unproved");
  const natives=drain["nativeProcesses"],containers=drain["containers"];
  if(!Array.isArray(natives)||natives.length>32||!Array.isArray(containers)||containers.length>16)refuse("drain_unproved");
  for(const raw of natives){const n=record(raw);if(!Number.isInteger(n["pid"])||Number(n["pid"])<1||Number(n["pid"])>4294967295||typeof n["creationFileTime"]!=="string"||!/^[1-9]\d{1,19}$/.test(n["creationFileTime"]))refuse("drain_unproved");}
  for(const raw of containers){
    const c=record(raw);if(typeof c["id"]!=="string"||!/^[a-f\d]{64}$/.test(c["id"])||typeof c["created"]!=="string"||typeof c["runId"]!=="string")refuse("drain_unproved");
    const all:unknown=JSON.parse((await promisify(execFile)("docker",["inspect",c["id"]],{windowsHide:true,maxBuffer:1024*1024,timeout:3000})).stdout);
    if(!Array.isArray(all)||all.length!==1)refuse("drain_unproved");const actual=record(all[0]);
    if(actual["Id"]!==c["id"]||actual["Created"]!==c["created"]||record(record(actual["Config"])["Labels"])["exocortex.sync-performance.run"]!==c["runId"]||record(actual["State"])["Running"]!==false)refuse("writers_not_drained");
  }
  return {backup,natives:natives as {pid:number;creationFileTime:string}[]};
}
async function verifyBackup(backup:Record<string,unknown>,intent:FolderRevalidationIntent):Promise<void>{
  const dump=record(backup["databaseDump"]);if(typeof dump["sha256"]!=="string"||!SHA.test(dump["sha256"])||typeof dump["file"]!=="string"||!path.isAbsolute(dump["file"])||(await fileDigest(dump["file"],134217728n)).sha256!==dump["sha256"])refuse("backup_invalid");
  const root=backup["physicalRoot"];if(typeof root!=="string"||!path.isAbsolute(root))refuse("backup_invalid");
  const resolved=path.resolve(root);if(resolved===path.resolve(String(backup["backendRoot"])))refuse("backup_invalid");
  const s=await fs.lstat(resolved);if(!s.isDirectory()||s.isSymbolicLink())refuse("backup_invalid");
  let total=0n;
  for(const e of intent.tree){
    const target=path.resolve(resolved,e.storagePath);if(!target.startsWith(resolved+path.sep))refuse("backup_invalid");
    let parent=path.dirname(target);while(parent!==resolved){const info=await fs.lstat(parent);if(!info.isDirectory()||info.isSymbolicLink())refuse("backup_invalid");parent=path.dirname(parent);}
    const info=await fs.lstat(target);if(info.isSymbolicLink())refuse("backup_invalid");
    if(e.description.type==="file"){
      const digest=await fileDigest(target,134217728n-total);total+=BigInt(digest.size);
      if(digest.sha256!==e.description.content_sha256||digest.size!==e.description.size_bytes)refuse("backup_invalid");
    }else{
      if(!info.isDirectory())refuse("backup_invalid");const actual=(await fs.readdir(target)).sort(),expected=intent.tree.filter(x=>x.description.parent_id===e.description.node_id).map(x=>x.description.name).sort();if(canonical(actual)!==canonical(expected))refuse("backup_invalid");
    }
  }
}

const args=process.argv.slice(2);
const planFile=args[0],planSha256=args[1];
if(args.length!==2||!planFile||!planSha256||!SHA.test(planSha256)){console.error("Usage: revalidate-guarded-folders.mts <protected-plan.json> <reviewed-plan-sha256>");process.exitCode=2;}
else{
  let runtime:Database|undefined,writer:Database|undefined,output:string|undefined;
  const startedAt=new Date().toISOString();
  try{
    const bytes=await bounded(planFile,65536);if(sha(bytes)!==planSha256)refuse("qualification_changed");const p=JSON.parse(bytes.toString("utf8")) as Plan;
    if(p.schema!=="saturn.offline-folder-revalidation-plan.v1"||process.platform!=="win32")refuse("invalid_operator_plan");
    const intent=parseFolderRevalidationIntent(JSON.parse((await pinned(p.original)).toString("utf8")));
    if(canonical(intent.binding)!==canonical(p.binding)||intent.backendIdentity!==p.backendIdentity||intent.guardRevision!==p.guardRevision)refuse("binding_invalid");
    const dir=await fs.lstat(p.evidenceDirectory);if(!path.isAbsolute(p.evidenceDirectory)||!dir.isDirectory()||dir.isSymbolicLink())refuse("invalid_operator_path");
    output=path.join(p.evidenceDirectory,"revalidation-attempt-"+randomUUID()+".json");
    const ru=new URL((await bounded(p.runtimeDatabaseUrlFile,8192)).toString("utf8").trim()),wu=new URL((await bounded(p.writerDatabaseUrlFile,8192)).toString("utf8").trim());
    if(ru.hostname!=="127.0.0.1"||wu.hostname!==ru.hostname||wu.port!==ru.port||wu.pathname!==ru.pathname||ru.username!==p.roles.runtimeRole||wu.username!==p.roles.writerLogin)refuse("database_identity_invalid");
    const evidence=await receipts(p,intent);await verifyBackup(evidence.backup,intent);
    runtime=new Database(ru.toString(),{max:1});writer=new Database(wu.toString(),{max:1});
    await qualifyCatalogDatabaseRoles(runtime,{...p.roles,approvedFunctions:p.approvedFunctions,connection:"runtime"});
    await qualifyCatalogDatabaseRoles(writer,{...p.roles,approvedFunctions:p.approvedFunctions,connection:"writer"});
    const devices=new DeviceService({repository:new PostgresDeviceRepository(runtime),files:new FileService(new PostgresFileRepository(runtime),new LocalStorageAdapter(p.backendRoot)),pepper:(await bounded(p.pepperFile,8192)).toString("utf8").trim(),
      options:{enabled:true,publicOrigin:"https://offline.invalid",uploadChunkMaxBytes:8388608,propfindMaxItems:100,deleteMaxItems:10,deleteWindowMs:10000}});
    const authority=new CatalogFolderAuthorityIssuer(runtime,{authenticateDevice:a=>devices.authenticateSyncMetadata(a)}),proof=await authority.device((await bounded(p.authorizationFile,8192)).toString("utf8").trim(),intent.binding.root_id);
    const verifier=new WindowsFolderRevalidationVerifier({powershell:p.powershell,handleScript:p.nativeHelper,handleScriptSha256:p.nativeHelperSha256,evidenceDirectory:p.evidenceDirectory,
      acquireCustody:async()=>{
        const current=await receipts(p,intent);
        return {backendRoot:p.backendRoot,backendNativeIdentity:p.backendNativeIdentity,custody:intent.custody,drainedProcesses:current.natives,
          assertCurrent:async()=>{if(sha(await bounded(planFile,65536))!==planSha256)refuse("qualification_changed");await pinned(p.original);await receipts(p,intent);},close:async()=>{}};
      }});
    const operator=new CatalogFolderRevalidationOperator(writer,authority,new FolderRevalidationEvidenceIssuer(verifier),p.binding,p.guardRevision,p.backendIdentity);
    const result=await operator.reconcile(intent,proof,AbortSignal.timeout(20000));
    await fs.writeFile(output,JSON.stringify({schema:"saturn.offline-folder-revalidation-attempt.v1",startedAt,endedAt:new Date().toISOString(),planSha256:args[1],originalSha256:p.original.sha256,status:"accepted",result},null,2)+"\n",{flag:"wx",mode:0o600});
    console.log(JSON.stringify({status:"accepted",operationId:intent.operationId,replayed:result.replayed,firstSeq:result.result.firstSeq,lastSeq:result.result.lastSeq,evidenceFile:output}));
  }catch(error){
    const e=error as Error&{code?:string},report={schema:"saturn.offline-folder-revalidation-attempt.v1",startedAt,endedAt:new Date().toISOString(),status:"refused-or-ack-unknown",code:e.code??e.name,instruction:"Preserve the original intent and inspect it on retry; never infer rollback from this exit."};
    if(output)await fs.writeFile(output,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});console.error(JSON.stringify(report));process.exitCode=1;
  }finally{await writer?.close();await runtime?.close();}
}
