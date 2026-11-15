import { requireDefined } from "../packages/contracts/src/require-defined.js";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Database } from "../packages/database/src/index.js";
import { qualifyCatalogDatabaseRoles } from "../packages/database/src/catalog-role-qualification.js";
import { LocalStorageAdapter } from "../packages/storage/src/local-storage.adapter.js";
import { LocalCustodyStorageAdapter } from "../packages/storage/src/local-custody.js";
import {validateExactStoragePath} from "../packages/storage/src/paths.js";
import { SftpStorageAdapter } from "../packages/storage/src/sftp-storage.adapter.js";
import { parseGuardedRuntimeManifest, requireGuardedRuntimeQualification } from "../packages/sync/src/guarded-runtime-manifest.js";
import { parseGuardedBackendFence } from "../packages/sync/src/guarded-backend-fence.js";
import { guardedApprovedFunctionsSha256,guardedStorageConfigSha256 } from "../packages/sync/src/guarded-runtime.js";
import { syncNameKey, type SyncNameCodec } from "../packages/contracts/src/sync-extensions.js";
import type { SaturnConfig } from "../packages/config/src/index.js";

/** Operator CLI, not run during implementation. Commands never infer approval
 * from elapsed time or a SQL lease. Config/proofs are protected local artifacts. */
interface Config {
  schema:string; rootId:string; databaseUrlFile:string; manifestFile:string;
  outputDirectory:string; codec:SyncNameCodec; policyHash:string; pgDumpExecutable?:string;
  storage:{kind:"local";root:string;custodyFile:string;configFile?:string}|{kind:"sftp";configFile:string};
}
interface Entry {id:string;parent_id:string|null;name:string;type:"folder"|"file";storage_path:string;size_bytes:string;sha256:string|null;current_version_id:string|null;metadata_version:string|null;status:string}
interface Plan {schema:string;id:string;rootId:string;codec:SyncNameCodec;policyHash:string;treeSha256:string;nodeCount:number;epoch:string|null;binding:string|null;seq:string;entriesFile:string;blockers:readonly string[];findings:readonly {nodeId:string;code:string}[];findingsTruncated:boolean}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw Error("invalid_artifact");return value as Record<string,unknown>;}
const recordJson=(text:string)=>record(JSON.parse(text) as unknown);
const sha=(s:string|Uint8Array)=>createHash("sha256").update(s).digest("hex");
async function protectedFile(file:string,maximum=4*1024*1024):Promise<Buffer>{
  if(!path.isAbsolute(file))throw new Error("protected_path_required");
  const before=await fs.lstat(file);
  if(!before.isFile()||before.isSymbolicLink()||before.size>maximum||before.nlink!==1)throw new Error("protected_file_invalid");
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await handle.stat();if(stat.ino!==before.ino||stat.dev!==before.dev||!stat.isFile()||stat.size>maximum||stat.nlink!==1)throw new Error('protected_file_invalid');
    if(process.platform!=="win32"&&(stat.mode&0o077)!==0)throw new Error("protected_file_permissions");
    const bytes=Buffer.alloc(maximum+1);let length=0;
    while(length<bytes.length){const read=await handle.read(bytes,length,bytes.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
    const after=await handle.stat(),current=await fs.lstat(file);
    if(length>maximum||length!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||current.ino!==stat.ino||current.dev!==stat.dev||current.isSymbolicLink())throw new Error('protected_file_changed');
    return bytes.subarray(0,length);
  }finally{await handle.close();}
}
async function save(file:string,value:unknown):Promise<void>{
  const handle=await fs.open(file,"wx",0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+"\n");await handle.sync();}finally{await handle.close();}
  if(process.platform!=='win32'){const directory=await fs.open(path.dirname(file),constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}}
}
async function main():Promise<unknown>{
  const [command,configPath,artifact]=process.argv.slice(2);
  if(!command||!configPath||!["inspect","pause","checkpoint","backup","migrate-plan","adopt","resume","diagnostics","rollback-plan","handoff","recovery-plan","repair-folder"].includes(command))throw new Error("Usage: sync-lifecycle.mts inspect|pause|checkpoint|backup|migrate-plan|adopt|resume|diagnostics|rollback-plan|handoff|recovery-plan|repair-folder <protected-config.json> [plan.json]");
  const config=JSON.parse((await protectedFile(path.resolve(configPath),65536)).toString("utf8")) as Config;
  if(config.schema!=="saturn.sync-lifecycle.v1"||!/^[a-f0-9-]{36}$/.test(config.rootId)||!path.isAbsolute(config.outputDirectory)||!['legacy','portable_v1'].includes(config.codec)||!/^[a-f0-9]{64}$/.test(config.policyHash))throw new Error("invalid_config");
  const manifest=parseGuardedRuntimeManifest(JSON.parse((await protectedFile(config.manifestFile,65536)).toString("utf8")),{allowEmptyRoots:true});
  if(['adopt','handoff'].includes(command)&&manifest.schema!=='saturn.guarded-runtime.v3')throw new Error('v3_manifest_required');
  const url=(await protectedFile(config.databaseUrlFile,8192)).toString("utf8").trim(),db=new Database(url,{max:2,maintenanceBarrier:true});
  // This connection is used only inside this CLI's exclusive admission. A
  // second shared maintenance lock here would deadlock the upgrade command.
  const writer=new Database((await protectedFile(manifest.writerDatabaseUrlFile,8192)).toString("utf8").trim(),{max:2,maintenanceBarrier:false});
  const outputDirectory=async()=>{
    await fs.mkdir(config.outputDirectory,{recursive:true,mode:0o700});const stat=await fs.lstat(config.outputDirectory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(config.outputDirectory)!==path.resolve(config.outputDirectory)
      ||process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid?.()))throw new Error('protected_directory_invalid');
  };
  const output=async(label:string,value:unknown)=>{await outputDirectory();const file=path.join(config.outputDirectory,`${label}-${randomUUID()}.json`);await save(file,value);return {file,...(value&&typeof value==="object"?value:{})};};
  const inspect=()=>db.withSql(async sql=>{
    const clock=(await sql<Record<string, unknown>[]>`SELECT root_id,epoch,binding_version,published_seq::text,namespace_state FROM sync_root_clock WHERE root_id=${config.rootId}`)[0];
    const pending=await sql<Record<string, unknown>[]>`SELECT id,operation_type,state,namespace_state,upload_effect_state,catalog_effect_state,created_at FROM operation_journal WHERE sync_root_id=${config.rootId} AND sync_result IS NULL ORDER BY created_at,id LIMIT 500`;
    const streams=await sql<Record<string, unknown>[]>`SELECT operation_id,state,received_size::text,final_sha256,created_at FROM sync_stream_uploads WHERE root_id=${config.rootId} AND state<>'PUBLISHED' ORDER BY created_at LIMIT 500`;
    const backend=(await sql<Record<string, unknown>[]>`SELECT backend_identity,generation,state,owner_id,fencing_token,stopped_receipt,heartbeat_at FROM sync_backend_executor WHERE backend_identity=${manifest.backend.identity}`)[0];
    const policy=(await sql<Record<string, unknown>[]>`SELECT codec,policy_hash,policy_version,features,state FROM sync_root_policy WHERE root_id=${config.rootId}`)[0];
    return {schema:"saturn.sync-inspection.v1",rootId:config.rootId,clock,pending,streams,backend,policy};
  });
  try{
    if(['pause','resume','adopt','handoff'].includes(command)){
      const identity=(await db.withSql(sql=>sql<{valid:boolean}[]>`SELECT session_user=current_user AND session_user=${manifest.roles.migratorRole} AS valid`))[0];
      if(!identity?.valid)throw new Error('operator_identity_required');
    }
    if(command==='recovery-plan'){
      const current=await inspect();
      return await output('recovery-plan',{...current,actions:current.pending.map(op=>({operationId:op.id,
        action:op.operation_type==='offline_folder_revalidation'?'repair-folder-original':op.upload_effect_state==='transport'?'resume-original-upload':
          op.namespace_state==='PREPARED'?'resume-original-mutation':'inspect-original-and-fence',automaticPhysicalReplay:false})),
        folderRepairTool:'scripts/revalidate-guarded-folders.mts',unknownRequiresConclusiveEvidence:true,ageCleanupAllowed:false});
    }
    if(command==='repair-folder'){
      if(!artifact)throw new Error('reviewed_plan_required');
      const file=path.resolve(artifact),bytes=await protectedFile(file,65536),plan=recordJson(bytes.toString('utf8'));
      if(plan.schema!=='saturn.offline-folder-revalidation-plan.v1'||record(plan.binding).root_id!==config.rootId||plan.backendIdentity!==manifest.backend.identity)throw new Error('plan_changed');
      const script=fileURLToPath(new URL('./revalidate-guarded-folders.mts',import.meta.url));
      await new Promise<void>((resolve,reject)=>{
        const child=spawn(process.execPath,[...process.execArgv,script,file,sha(bytes)],{windowsHide:true,stdio:'inherit'});
        child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('repair_unresolved')));
      });
      return await output('folder-repair',{schema:'saturn.sync-repair-dispatch.v1',rootId:config.rootId,originalPlanSha256:sha(bytes),status:'accepted-by-existing-operator'});
    }
    if(command==='handoff'){
      if(!artifact)throw new Error('reviewed_handoff_required');
      const receipt=recordJson((await protectedFile(path.resolve(artifact),16384)).toString('utf8'));
      const fenceBytes=await protectedFile(manifest.backend.fenceReceiptFile,16384),fence=recordJson(fenceBytes.toString('utf8'));
      if(sha(fenceBytes)!==manifest.backend.fenceReceiptSha256||fence.backendIdentity!==manifest.backend.identity||fence.generation!==manifest.backend.generation
        ||fence.oldExecutorsDrained!==true||fence.oldCredentialsRevoked!==true||fence.protectedAncestorsVerified!==true
        ||receipt.schema!=='saturn.backend-handoff.v1'||receipt.backendIdentity!==manifest.backend.identity||receipt.nextGeneration!==manifest.backend.generation
        ||receipt.fenceReceiptSha256!==manifest.backend.fenceReceiptSha256||receipt.oldConnectionsClosed!==true)throw new Error('fence_unproved');
      return await db.withExclusiveMaintenance(async()=>{
        await db.transaction(async sql=>{
          const old=(await sql<{generation:string;owner_id:string|null;fencing_token:string|null}[]>`SELECT generation,owner_id,fencing_token FROM sync_backend_executor WHERE backend_identity=${manifest.backend.identity} FOR UPDATE`)[0];
          if(!old||old.generation!==receipt.previousGeneration||old.owner_id!==receipt.previousOwnerId||old.fencing_token!==receipt.previousFencingToken||old.generation===receipt.nextGeneration)throw new Error('handoff_stale');
          await sql<Record<string, unknown>[]>`UPDATE sync_backend_tasks SET state='UNKNOWN',error_code='fenced_during_execution',updated_at=now() WHERE backend_identity=${manifest.backend.identity} AND state='RUNNING'`;
          await sql<Record<string, unknown>[]>`UPDATE sync_backend_tasks SET state='REJECTED',error_code='fenced_before_execution',payload=payload-'bytes',updated_at=now() WHERE backend_identity=${manifest.backend.identity} AND state='QUEUED'`;
          await sql<Record<string, unknown>[]>`INSERT INTO sync_backend_handoffs(id,backend_identity,previous_generation,next_generation,receipt) VALUES(${randomUUID()},${manifest.backend.identity},${old.generation},${manifest.backend.generation},${JSON.stringify(receipt)}::text::jsonb)`;
          await sql<Record<string, unknown>[]>`DELETE FROM sync_backend_read_slots WHERE backend_identity=${manifest.backend.identity}`;
          await sql<Record<string, unknown>[]>`UPDATE sync_backend_executor SET generation=${manifest.backend.generation},owner_id=NULL,fencing_token=NULL,
            state=CASE WHEN EXISTS(SELECT 1 FROM sync_backend_tasks WHERE backend_identity=${manifest.backend.identity} AND state='UNKNOWN') THEN 'UNKNOWN' ELSE 'STOPPED' END,updated_at=now() WHERE backend_identity=${manifest.backend.identity}`;
        });
        return output('handoff',{...await inspect(),rootRequalificationRequired:true,unknownReplayed:false});
      });
    }
    if(command==="inspect"||command==="diagnostics")return await output(command,await inspect());
    if(command==="pause"){
      const rows=await db.withSql(sql=>sql<Record<string, unknown>[]>`UPDATE sync_root_policy SET state='PAUSED',updated_at=now() WHERE root_id=${config.rootId} RETURNING root_id`);
      if(rows.length!==1)throw new Error('policy_missing');
      return await output("paused",await inspect());
    }
    if(command==="checkpoint"){
      const current=await inspect();
      return await output("checkpoint",{...current,checkpointComplete:current.pending.length===0&&current.streams.length===0,unknownPreserved:true});
    }
    if(command==="rollback-plan"){
      const current=await inspect();return await output("rollback-plan",{...current,featureRollback:"pause preserves all new indexes/originals/receipts",binaryRollbackAllowed:!current.clock&&!current.pending.length&&!current.streams.length,reason:"New publications and schema require compatible binaries; do not delete journals to roll back"});
    }
    if(command==="backup"){
      await outputDirectory();const dump=path.join(config.outputDirectory,`catalog-${randomUUID()}.dump`),out=await fs.open(dump,"wx",0o600),connection=new URL(url);
      try{await db.withExclusiveMaintenance(async()=>{
        // libpq does not expand a connection URI supplied through PGDATABASE.
        // Pass the endpoint/options explicitly, with the password only in env.
        const password=connection.searchParams.get('password')??decodeURIComponent(connection.password);
        connection.password='';connection.searchParams.delete('password');
        if(connection.searchParams.has('sslpassword'))throw new Error('backup_connection_option_unsupported');
        const child=spawn(config.pgDumpExecutable??"pg_dump",["--format=custom","--no-owner","--dbname",connection.toString()],
          {windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,PGPASSWORD:password}});
        let stderrBytes=0;child.stderr.on("data",(b:Buffer)=>{stderrBytes+=b.length;if(stderrBytes>65536)child.kill();});
        const exit=new Promise<void>((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>code===0?resolve():reject(new Error("backup_failed")));});
        // A FileHandle stream with autoClose:false can leave pipeline waiting
        // for close forever. Keep explicit custody of the handle through fsync.
        const copy = async () => { for await (const chunk of child.stdout) await out.writeFile(chunk as Uint8Array); };
        await Promise.all([copy(),exit]);await out.sync();
      });}finally{await out.close();}
      const digest=createHash("sha256"),h=await fs.open(dump,"r");try{for await(const b of h.createReadStream())digest.update(b as Uint8Array);}finally{await h.close().catch(()=>undefined);}
      return await output("backup",{schema:"saturn.sync-backup.v1",dump,sha256:digest.digest("hex"),capturedAt:new Date().toISOString()});
    }
    if(command==="migrate-plan"){
      await outputDirectory();const id=randomUUID(),entriesFile=path.join(config.outputDirectory,`migration-${id}.ndjson`),handle=await fs.open(entriesFile,"wx",0o600);
      const hash=createHash("sha256"),blockers=new Set<string>();let count=0,last="",epoch:string|null=null,binding:string|null=null,seq="0";
      const findings:{nodeId:string;code:string}[]=[];let findingsTruncated=false;
      const finding=(nodeId:string,code:string)=>{blockers.add(code);if(findings.length<500)findings.push({nodeId,code});else findingsTruncated=true;};
      try{await db.transaction(async sql=>{
        await sql<Record<string, unknown>[]>`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
        const clock=(await sql<{epoch:string;binding_version:string|null;published_seq:string}[]>`SELECT epoch,binding_version,published_seq::text FROM sync_root_clock WHERE root_id=${config.rootId}`)[0];
        epoch=clock?.epoch??null;binding=clock?.binding_version??null;seq=clock?.published_seq??"0";
        const names=new Set<string>();
        for(;;){
          const rows=await sql<Entry[]>`WITH RECURSIVE tree AS(SELECT r.*,0 depth FROM resources r WHERE id=${config.rootId}
            UNION ALL SELECT r.*,t.depth+1 FROM resources r JOIN tree t ON r.parent_id=t.id WHERE t.depth<128 AND r.status NOT IN ('trashed','purged'))
            SELECT id::text,parent_id::text,name,type,storage_path,size_bytes::text,sha256,current_version_id::text,metadata_version::text,status FROM tree WHERE id::text>${last} ORDER BY id LIMIT 500`;
          if(!rows.length)break;
          for(const row of rows){
            if(++count>200000)throw new Error("plan_limit");
            try{const key=(row.parent_id??"")+":"+syncNameKey(row.name,config.codec);if(names.has(key))finding(row.id,"name_collision");names.add(key);}catch{finding(row.id,"invalid_name");}
            if(row.status!=="active"||row.type==="file"&&(!row.sha256||!row.current_version_id))finding(row.id,"unqualified_content");
            const line=JSON.stringify(row)+"\n";hash.update(line);await handle.writeFile(line);last=row.id;
          }
        }
        if((await sql<Record<string, unknown>[]>`SELECT id FROM operation_journal WHERE sync_root_id=${config.rootId} AND sync_result IS NULL LIMIT 1`).length)blockers.add("originals_unresolved");
        const collisions=await sql<{id:string}[]>`WITH RECURSIVE tree AS(SELECT id,parent_id,name,0 depth FROM resources WHERE id=${config.rootId}
          UNION ALL SELECT r.id,r.parent_id,r.name,t.depth+1 FROM resources r JOIN tree t ON r.parent_id=t.id WHERE t.depth<129 AND r.status NOT IN ('trashed','purged'))
          SELECT id FROM tree t WHERE depth=129 OR EXISTS(SELECT 1 FROM tree other WHERE other.parent_id=t.parent_id AND other.id<>t.id AND lower(other.name)=lower(t.name)) LIMIT 501`;
        for(const row of collisions)finding(row.id,'database_collision_or_depth_limit');
      });await handle.sync();}finally{await handle.close();}
      if(!count)throw new Error("root_missing");
      const plan:Plan={schema:"saturn.sync-migration-plan.v1",id,rootId:config.rootId,codec:config.codec,policyHash:config.policyHash,treeSha256:hash.digest("hex"),nodeCount:count,epoch,binding,seq,entriesFile,blockers:[...blockers],findings,findingsTruncated};
      return await output("migration-plan",plan);
    }
    if(command==="resume"){
      const current=await inspect();if(current.pending.length||current.streams.some(x=>x.state==="UNKNOWN")||current.clock?.namespace_state!=="ACTIVE")throw new Error("reconciliation_required");
      const rows=await db.withSql(sql=>sql<Record<string, unknown>[]>`UPDATE sync_root_policy SET state='ACTIVE',updated_at=now() WHERE root_id=${config.rootId} AND codec=${config.codec} AND policy_hash=${config.policyHash} RETURNING root_id`);
      if(rows.length!==1)throw new Error('policy_mismatch');
      return await output("resumed",await inspect());
    }
    if(!artifact)throw new Error("reviewed_plan_required");
    const planBytes=await protectedFile(path.resolve(artifact),65536),plan=JSON.parse(planBytes.toString("utf8")) as Plan;
    if(plan.schema!=="saturn.sync-migration-plan.v1"||plan.rootId!==config.rootId||plan.codec!==config.codec||plan.policyHash!==config.policyHash||plan.blockers.length)throw new Error("plan_blocked");
    const lines=(await protectedFile(plan.entriesFile,128*1024*1024)).toString("utf8");
    if(sha(lines)!==plan.treeSha256)throw new Error("plan_changed");
    const qualification=await protectedFile(manifest.qualificationReceiptFile,65536);
    if(sha(qualification)!==manifest.qualificationReceiptSha256)throw new Error("qualification_changed");
    requireGuardedRuntimeQualification(recordJson(qualification.toString("utf8")),manifest,guardedApprovedFunctionsSha256(manifest.approvedFunctions));
    await qualifyCatalogDatabaseRoles(writer,{...manifest.roles,approvedFunctions:manifest.approvedFunctions,connection:"writer"});
    const accepted=(await db.withSql(sql=>sql<{plan_sha256:string;result:unknown}[]>`SELECT plan_sha256,result FROM sync_migration_plans WHERE id=${plan.id} AND state='APPLIED'`))[0];
    if(accepted){
      if(accepted.plan_sha256!==sha(planBytes)||!accepted.result)throw new Error('plan_changed');
      const result=accepted.result as {manifestRoot:{rootId:string};backend_identity:string;qualification_receipt_sha256:string};
      if(result.backend_identity!==manifest.backend.identity||result.qualification_receipt_sha256!==manifest.qualificationReceiptSha256)throw new Error('qualification_changed');
      const saved=await output('runtime-manifest',{...manifest,roots:[...manifest.roots.filter(r=>r.rootId!==plan.rootId),result.manifestRoot]});
      return await output('adoption-replay',{...result,runtimeManifestFile:saved.file,manifestRefreshRequired:true,automaticActivation:false});
    }
    const storageConfig=config.storage.kind==='sftp'?JSON.parse((await protectedFile(config.storage.configFile,65536)).toString('utf8'))as SaturnConfig['storage']:undefined;
    if(storageConfig?.backend==='local'||manifest.backend.kind==='local'&&config.storage.kind!=='local')throw new Error('backend_profile_mismatch');
    const storage=storageConfig?new SftpStorageAdapter(storageConfig):new LocalStorageAdapter((config.storage as {root:string}).root);
    storage.enableExactPaths();
    try{return await db.withExclusiveMaintenance(async()=>{
      const current=await inspect();if(current.pending.length||current.streams.length)throw new Error("originals_unresolved");
      if(current.backend&&current.backend.state!=="STOPPED")throw new Error("backend_not_stopped");
      const fenceBytes=await protectedFile(manifest.backend.fenceReceiptFile,16384);
      if(sha(fenceBytes)!==manifest.backend.fenceReceiptSha256)throw new Error("fence_changed");
      const fence=recordJson(fenceBytes.toString("utf8"));
      if(manifest.backend.kind==='local'){
        try{parseGuardedBackendFence(fence,manifest);}catch{throw new Error('fence_unproved');}
      }else if(fence.schema!=='saturn.backend-fence.v1'||fence.backendIdentity!==manifest.backend.identity||fence.profileId!==manifest.backend.profileId||fence.profileRevision!==manifest.backend.profileRevision
        ||fence.generation!==manifest.backend.generation||fence.oldExecutorsDrained!==true||fence.oldCredentialsRevoked!==true||fence.protectedAncestorsVerified!==true)throw new Error("fence_unproved");
      let localIdentity:{root:string;device:bigint;inode:bigint}|undefined;
      let runtimeCustody:LocalCustodyStorageAdapter|undefined;
      if(storageConfig){
        if(guardedStorageConfigSha256({profileId:manifest.backend.profileId,revision:manifest.backend.profileRevision,activatedAt:'',source:'runtime',config:storageConfig})!==fence.storageConfigSha256)throw new Error('backend_profile_mismatch');
        const credential=storageConfig.authMode==='password_file'?storageConfig.passwordFile:storageConfig.privateKeyFile;
        if(!credential||sha(await protectedFile(credential,262144))!==fence.credentialSha256)throw new Error('credential_changed');
      }else if(config.storage.kind==='local'){
        const stat=await fs.lstat(config.storage.root,{bigint:true});
        if(manifest.backend.kind==='local'){
          // New runtime custody binds the complete actual profile. Do not
          // reconstruct it from defaults or accept a dummy SFTP credential.
          if(!config.storage.configFile)throw new Error('local_profile_required');
          const profile=recordJson((await protectedFile(config.storage.configFile,65536)).toString('utf8'));
          const keys=['backend','root','custodyFile','operationTimeoutMs','healthTimeoutMs','maxConnections','requireFsync'];
          if(Object.keys(profile).length!==keys.length||keys.some(key=>!Object.hasOwn(profile,key))||profile.backend!=='local'
            ||profile.root!==config.storage.root||profile.custodyFile!==config.storage.custodyFile||profile.requireFsync!==true
            ||!Number.isInteger(profile.operationTimeoutMs)||Number(profile.operationTimeoutMs)<1000||Number(profile.operationTimeoutMs)>120000
            ||!Number.isInteger(profile.healthTimeoutMs)||Number(profile.healthTimeoutMs)<500||Number(profile.healthTimeoutMs)>5000
            ||!Number.isInteger(profile.maxConnections)||Number(profile.maxConnections)<1||Number(profile.maxConnections)>8
            ||guardedStorageConfigSha256({profileId:manifest.backend.profileId,revision:manifest.backend.profileRevision,activatedAt:'',source:'runtime',config:profile as unknown as SaturnConfig['storage']})!==fence.storageConfigSha256)throw new Error('backend_profile_mismatch');
          runtimeCustody=new LocalCustodyStorageAdapter({backend:'local',root:config.storage.root,custodyFile:config.storage.custodyFile});
          const custody=await runtimeCustody.custody();
          if(custody.sha256!==fence.localCustodySha256||custody.receipt.backendIdentity!==manifest.backend.identity||custody.receipt.generation!==manifest.backend.generation)throw new Error('local_custody_unproved');
        }else{
          // Preserve the old offline-only local witness and fence format.
          const custody=recordJson((await protectedFile(config.storage.custodyFile,16384)).toString('utf8'));
          if(custody.schema!=='saturn.local-backend-custody.v1'||custody.backendIdentity!==manifest.backend.identity||custody.backendGeneration!==manifest.backend.generation
            ||custody.fenceReceiptSha256!==manifest.backend.fenceReceiptSha256||custody.root!==path.resolve(config.storage.root)||custody.device!==stat.dev.toString()||custody.inode!==stat.ino.toString()
            ||!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(config.storage.root)!==path.resolve(config.storage.root))throw new Error('local_custody_unproved');
        }
        localIdentity={root:path.resolve(config.storage.root),device:stat.dev,inode:stat.ino};
      }
      const localWitness=async(entry:Entry)=>{
        validateExactStoragePath(entry.storage_path,false);
        if(!localIdentity)return null;
        if(runtimeCustody&& (await runtimeCustody.custody()).sha256!==fence.localCustodySha256)throw new Error('local_custody_changed');
        const base=await fs.lstat(localIdentity.root,{bigint:true});
        if(base.dev!==localIdentity.device||base.ino!==localIdentity.inode||!base.isDirectory()||base.isSymbolicLink())throw new Error('local_custody_changed');
        let current=localIdentity.root,identity='';const segments=entry.storage_path.split('/');
        for(let n=0;n<segments.length;n++){
          current=path.join(current,requireDefined(segments[n]));const st=await fs.lstat(current,{bigint:true}),directory=n<segments.length-1||entry.type==='folder';
          if(st.isSymbolicLink()||st.dev!==localIdentity.device||(directory?!st.isDirectory():!st.isFile()||st.nlink!==1n))throw new Error('local_boundary_unproved');
          identity+=`${String(st.dev)}:${String(st.ino)}:${directory?'directory':String(st.ctimeNs)};`;
        }
        return identity;
      };
      const entries=lines.trimEnd().split("\n").map(line=>JSON.parse(line) as Entry);
      if(entries.length!==plan.nodeCount)throw new Error("plan_changed");
      // Resume progress belongs to the exact drained custody and qualified
      // writer. A new fence/generation requires a new reviewed plan.
      const custodySha256=sha(JSON.stringify({backend:manifest.backend,roles:manifest.roles,
        qualification:manifest.qualificationReceiptSha256,functions:guardedApprovedFunctionsSha256(manifest.approvedFunctions),
        policyVersion:manifest.policyVersion,extensions:manifest.extensions,storage:config.storage}));
      const children=new Map<string,string[]>();
      for(const e of entries)if(e.parent_id){const list=children.get(e.parent_id)??[];list.push(e.name);children.set(e.parent_id,list);}
      await db.withSql(sql=>sql<Record<string, unknown>[]>`INSERT INTO sync_migration_plans(id,root_id,plan_sha256,tree_sha256,custody_sha256,expected_epoch,expected_binding,expected_seq,node_count,state,plan)
        VALUES(${plan.id},${plan.rootId},${sha(planBytes)},${plan.treeSha256},${custodySha256},${plan.epoch},${plan.binding},${plan.seq}::bigint,${String(plan.nodeCount)},'VERIFYING',${JSON.stringify(plan)}::text::jsonb)
        ON CONFLICT(id) DO NOTHING`);
      const stored=(await db.withSql(sql=>sql<{plan_sha256:string;custody_sha256:string;state:string;initialization_done:boolean}[]>`SELECT plan_sha256,custody_sha256,state,initialization_done FROM sync_migration_plans WHERE id=${plan.id}`))[0];
      if(stored?.plan_sha256!==sha(planBytes)||stored.custody_sha256!==custodySha256)throw new Error("plan_changed");
      if(stored.state==="APPLIED")return output("adoption-replay",await inspect());
      const progress=new Map((await db.withSql(sql=>sql<{node_id:string;fingerprint:string}[]>`SELECT node_id,fingerprint FROM sync_migration_progress WHERE plan_id=${plan.id}`)).map(row=>[row.node_id,row.fingerprint]));
      for(const entry of stored.initialization_done?[]:entries){
        const live=(await db.withSql(sql=>sql<Entry[]>`SELECT id::text,parent_id::text,name,type,storage_path,size_bytes::text,sha256,current_version_id::text,metadata_version::text,status FROM resources WHERE id=${entry.id}`))[0];
        if(JSON.stringify(live)!==JSON.stringify(entry))throw new Error("plan_stale");
        const localBefore=await localWitness(entry);
        const stat=await storage.stat(entry.storage_path);
        if(stat.type!==(entry.type==="folder"?"directory":"file"))throw new Error("physical_mismatch");
        const fingerprint=sha(JSON.stringify([entry,manifest.backend.fenceReceiptSha256,stat.size,stat.modifiedAt.toISOString(),localBefore]));
        if(entry.type==="file"&&progress.get(entry.id)!==fingerprint){
          const digest=createHash("sha256");let size=0n;
          for await(const raw of await storage.openRead(entry.storage_path)){const b=Buffer.from(raw as Uint8Array);size+=BigInt(b.length);if(size>BigInt(entry.size_bytes))throw new Error("physical_mismatch");digest.update(b);}
          if(size.toString()!==entry.size_bytes||digest.digest("hex")!==entry.sha256)throw new Error("physical_mismatch");
          const after=await storage.stat(entry.storage_path);
          if(after.type!==stat.type||after.size!==stat.size||after.modifiedAt.getTime()!==stat.modifiedAt.getTime())throw new Error('physical_changed');
        }else if(entry.type==="folder"){
          let cursor:string|undefined;const expected=(children.get(entry.id)??[]).sort(),actual:string[]=[];
          const cursors=new Set<string>();
          do{const page=await storage.list(entry.storage_path,cursor,500);actual.push(...page.entries.map(e=>e.name));cursor=page.nextCursor;
            if(actual.length>plan.nodeCount||cursor&&cursors.has(cursor))throw new Error('physical_membership_mismatch');if(cursor)cursors.add(cursor);
          }while(cursor);
          if(JSON.stringify(actual.sort())!==JSON.stringify(expected))throw new Error("physical_membership_mismatch");
        }
        if(await localWitness(entry)!==localBefore)throw new Error('local_custody_changed');
        await db.transaction(async sql=>{await sql<Record<string, unknown>[]>`INSERT INTO sync_migration_progress(plan_id,node_id,fingerprint,evidence) VALUES(${plan.id},${entry.id},${fingerprint},${JSON.stringify(entry)}::text::jsonb)
          ON CONFLICT(plan_id,node_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,evidence=EXCLUDED.evidence,verified_at=now()`;
          await sql<Record<string, unknown>[]>`UPDATE sync_migration_plans SET verified_nodes=(SELECT count(*) FROM sync_migration_progress WHERE plan_id=${plan.id}),last_node_id=${entry.id},updated_at=now() WHERE id=${plan.id}`;});
      }
      await db.withSql(sql=>sql<Record<string, unknown>[]>`UPDATE sync_migration_plans SET state='VERIFIED',updated_at=now() WHERE id=${plan.id} AND verified_nodes=node_count`);
      if(!stored.initialization_done)await db.transaction(async sql=>{
        const initial=(await sql<{epoch:string;binding_version:string|null;published_seq:string}[]>`SELECT epoch,binding_version,published_seq::text FROM sync_root_clock WHERE root_id=${plan.rootId} FOR UPDATE`)[0];
        if((initial?.epoch??null)!==plan.epoch||(initial?.binding_version??null)!==plan.binding||(initial?.published_seq??"0")!==plan.seq)throw new Error("plan_stale");
        await sql<Record<string, unknown>[]>`INSERT INTO sync_backend_executor(backend_identity,generation,writer_login,writer_owner) VALUES(${manifest.backend.identity},${manifest.backend.generation},${manifest.roles.writerLogin},${manifest.roles.writerOwner}) ON CONFLICT(backend_identity) DO NOTHING`;
        const backend=(await sql<{valid:boolean}[]>`SELECT state='STOPPED' AND generation=${manifest.backend.generation}::uuid AND writer_login=${manifest.roles.writerLogin} AND writer_owner=${manifest.roles.writerOwner} AS valid FROM sync_backend_executor WHERE backend_identity=${manifest.backend.identity} FOR UPDATE`)[0];
        if(!backend?.valid)throw new Error("backend_generation_changed");
        if(!initial)await sql<Record<string, unknown>[]>`INSERT INTO sync_root_clock(root_id,epoch,namespace_state,descriptor_schema) VALUES(${plan.rootId},${randomUUID()},'QUALIFYING','saturn.current-namespace.v1')`;
        await sql<Record<string, unknown>[]>`UPDATE sync_root_clock SET namespace_state='QUALIFYING',descriptor_schema='saturn.current-namespace.v1' WHERE root_id=${plan.rootId} AND namespace_state='LEGACY'`;
        for(const entry of entries){
          if(entry.type==="file"&&!(await sql<Record<string, unknown>[]>`SELECT id FROM file_versions WHERE id=${entry.current_version_id} AND resource_id=${entry.id} AND state='active' AND sha256=${entry.sha256} AND size_bytes=${entry.size_bytes}::bigint AND storage_path=${entry.storage_path}`).length)throw new Error("version_preimage_mismatch");
          await sql<Record<string, unknown>[]>`UPDATE resources SET sync_availability='AVAILABLE',metadata_version=coalesce(metadata_version,gen_random_uuid()) WHERE id=${entry.id} AND (sync_availability IS DISTINCT FROM 'AVAILABLE' OR metadata_version IS NULL)`;
        }
        const root=(await sql<{parent_id:string}[]>`SELECT parent_id FROM resources WHERE id=${plan.rootId}`)[0];if(!root)throw new Error("root_missing");
        if(!(await sql<Record<string, unknown>[]>`SELECT root_id FROM catalog_guard_roots WHERE root_id=${plan.rootId}`).length)await sql<Record<string, unknown>[]>`INSERT INTO catalog_guard_roots(root_id,guard_revision,writer_contract,runtime_role,writer_login,writer_owner,backend_identity,control_ancestor_ids)
          VALUES(${plan.rootId},${randomUUID()},'folder-only-g1.v1',${manifest.roles.runtimeRole},${manifest.roles.writerLogin},${manifest.roles.writerOwner},${manifest.backend.identity},ARRAY['00000000-0000-7000-8000-000000000001'::uuid,${root.parent_id}::uuid])`;
        await sql<Record<string, unknown>[]>`UPDATE sync_migration_plans SET expected_epoch=c.epoch,expected_binding=c.binding_version,initialization_done=true FROM sync_root_clock c WHERE sync_migration_plans.id=${plan.id} AND c.root_id=${plan.rootId}`;
      });
      const g=(await db.withSql(sql=>sql<{writer_contract:string}[]>`SELECT writer_contract FROM catalog_guard_roots WHERE root_id=${plan.rootId}`))[0];
      if(g?.writer_contract==='folder-only-g1.v1')await writer.withSql(sql=>sql<Record<string, unknown>[]>`SELECT public.catalog_guard_upgrade_file(${plan.rootId}::uuid)`);
      await db.transaction(async sql=>{
        const clock=(await sql<{epoch:string;binding_version:string;published_seq:string;namespace_state:string}[]>`SELECT epoch,binding_version,published_seq::text,namespace_state FROM sync_root_clock WHERE root_id=${plan.rootId} FOR UPDATE`)[0];
        if(!clock||clock.published_seq!==plan.seq)throw new Error("plan_stale");
        // The fixed folder→file upgrade rotates binding twice. Seal its new
        // binding into this verified offline continuation, including recovery
        // after that upgrade committed but before this transaction began.
        await sql<Record<string, unknown>[]>`UPDATE sync_migration_plans p SET expected_binding=c.binding_version
          FROM sync_root_clock c JOIN catalog_guard_roots g ON g.root_id=c.root_id
          WHERE p.id=${plan.id} AND p.root_id=c.root_id AND p.state='VERIFIED' AND p.initialization_done
            AND p.expected_epoch=c.epoch AND p.expected_seq=c.published_seq AND c.namespace_state='QUALIFYING'
            AND g.active_runtime IS NULL AND g.writer_contract='folder-file-cas-cj04.v1'`;
        await sql<Record<string, unknown>[]>`INSERT INTO sync_root_policy(root_id,codec,policy_hash,policy_version,features,state) VALUES(${plan.rootId},${plan.codec},${plan.policyHash},${manifest.policyVersion},${JSON.stringify(manifest.extensions?.features??[])}::text::jsonb,'ACTIVE')
          ON CONFLICT(root_id) DO UPDATE SET codec=EXCLUDED.codec,policy_hash=EXCLUDED.policy_hash,policy_version=EXCLUDED.policy_version,features=EXCLUDED.features,state='ACTIVE',updated_at=now()`;
        {
          const root=(await sql<{metadata_version:string;storage_path:string}[]>`SELECT metadata_version,storage_path FROM resources WHERE id=${plan.rootId}`)[0];if(!root)throw new Error("root_missing");
          const proof={schema:"saturn.catalog-active.v2",rootId:plan.rootId,serverEpoch:clock.epoch,serverIdentity:manifest.serverIdentity,policyVersion:manifest.policyVersion,backendIdentity:manifest.backend.identity,
            backendProfileId:manifest.backend.profileId,backendProfileRevision:manifest.backend.profileRevision,backendGeneration:manifest.backend.generation,fenceReceiptSha256:manifest.backend.fenceReceiptSha256,
            qualificationReceiptSha256:manifest.qualificationReceiptSha256,activationReceiptSha256:sha(planBytes),maximumFileBytes:manifest.maximumFileBytes,observedMetadataVersion:root.metadata_version,
            observedPathSha256:sha(root.storage_path),observedAt:new Date().toISOString(),oldExecutorsDrained:true,oldCredentialsRevoked:true,emptyPhysicalRootVerified:false,adoptionPlanId:plan.id,treeSha256:plan.treeSha256};
          await sql<Record<string, unknown>[]>`UPDATE catalog_guard_roots SET active_runtime=${JSON.stringify(proof)}::text::jsonb,guard_revision=gen_random_uuid() WHERE root_id=${plan.rootId}`;
          await sql<Record<string, unknown>[]>`UPDATE sync_root_clock SET namespace_state='ACTIVE',binding_version=gen_random_uuid(),updated_at=now() WHERE root_id=${plan.rootId}`;
        }
        await sql<Record<string, unknown>[]>`INSERT INTO sync_backend_executor(backend_identity,generation,writer_login,writer_owner) VALUES(${manifest.backend.identity},${manifest.backend.generation},${manifest.roles.writerLogin},${manifest.roles.writerOwner}) ON CONFLICT(backend_identity) DO NOTHING`;
        const identity=(await sql<{rootId:string;epoch:string;bindingVersion:string;guardRevision:string;activationReceiptSha256:string;deviceId:string}[]>`SELECT g.root_id AS "rootId",c.epoch,c.binding_version AS "bindingVersion",g.guard_revision AS "guardRevision",g.active_runtime->>'activationReceiptSha256' AS "activationReceiptSha256",d.id AS "deviceId"
          FROM catalog_guard_roots g JOIN sync_root_clock c ON c.root_id=g.root_id JOIN devices d ON d.sync_root_id=g.root_id AND d.state='active' AND d.can_read AND d.can_write WHERE g.root_id=${plan.rootId}`);
        if(identity.length!==1)throw new Error('canonical_device_required');
        const root=requireDefined(identity[0]),result={schema:'saturn.sync-adoption.v1',planId:plan.id,planSha256:sha(planBytes),treeSha256:plan.treeSha256,
          binding:{protocol:'neptune-sync/1',descriptor_schema:'saturn.current-namespace.v1',server_identity:manifest.serverIdentity,root_id:root.rootId,server_epoch:root.epoch,policy_version:manifest.policyVersion,binding_version:root.bindingVersion},
          device_id:root.deviceId,backend_identity:manifest.backend.identity,qualification_receipt_sha256:manifest.qualificationReceiptSha256,
          namespace:{codec:plan.codec,policyHash:plan.policyHash},manifestRoot:{rootId:root.rootId,epoch:root.epoch,bindingVersion:root.bindingVersion,guardRevision:root.guardRevision,activationReceiptSha256:root.activationReceiptSha256}};
        await sql<Record<string, unknown>[]>`UPDATE sync_migration_plans SET state='APPLIED',result=${JSON.stringify(result)}::text::jsonb,updated_at=now() WHERE id=${plan.id}`;
      });
      const roots=await db.withSql(sql=>sql<{rootId:string;epoch:string;bindingVersion:string;guardRevision:string;activationReceiptSha256:string}[]>`SELECT g.root_id AS "rootId",c.epoch,c.binding_version AS "bindingVersion",g.guard_revision AS "guardRevision",g.active_runtime->>'activationReceiptSha256' AS "activationReceiptSha256" FROM catalog_guard_roots g JOIN sync_root_clock c ON c.root_id=g.root_id WHERE g.root_id=${plan.rootId}`);
      const nextManifest={...manifest,roots:[...manifest.roots.filter(r=>r.rootId!==plan.rootId),...roots]};
      const saved=await output("runtime-manifest",nextManifest);
      const receipt=(await db.withSql(sql=>sql<{result:Record<string,unknown>}[]>`SELECT result FROM sync_migration_plans WHERE id=${plan.id}`))[0]?.result;
      return output("adopted",{...receipt,runtimeManifestFile:saved.file,manifestRefreshRequired:true,automaticActivation:false});
    });}finally{await storage.close();}
  }finally{await Promise.all([writer.close(),db.close()]);}
}
main().then(result=>process.stdout.write(JSON.stringify(result,null,2)+"\n"),(error: unknown)=>{process.stderr.write(JSON.stringify({code:error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:"lifecycle_failed"})+"\n");process.exitCode=1;});
