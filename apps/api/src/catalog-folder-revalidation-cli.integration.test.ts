import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash,randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {Database} from "@saturn/database";
import {expect,it} from "vitest";
import {folderRevalidationTreeSha256,type FolderRevalidationTreeEntry} from "../../../packages/file-core/src/catalog-folder-revalidation.js";
import {qualifyCatalogDatabaseRoles} from "../../../packages/database/src/catalog-role-qualification.js";

const fixture=process.env.SYNC_FOLDER_REVALIDATION_FIXTURE,exec=promisify(execFile),sha=(v:Uint8Array|string)=>createHash("sha256").update(v).digest("hex");
it.skipIf(!fixture)("runs the private operator in a new PID with pinned bootstrap/drain/coherent backup and replays its original",async()=>{
  if(!fixture)throw Error("Clone required");
  const f=JSON.parse(await fs.readFile(fixture,"utf8")) as {containerId:string;created:string;runId:string;template:string;databaseUrl:string;writerUrl:string;fixtureDirectory:string;pepper:string;originalStorageDirectory:string;guard:{writer_owner:string;writer_login:string;runtime_role:string;guard_revision:string;backend_identity:string};client:{deviceId:string;token:string;binding:Record<string,string>}};
  const containers=JSON.parse((await exec("docker",["inspect",f.containerId],{windowsHide:true})).stdout) as {Id:string;Created:string;State:{Running:boolean};Config:{Labels:Record<string,string>};NetworkSettings:{Ports:Record<string,{HostIp:string;HostPort:string}[]>}}[];
  const own=containers[0];if(!own)throw Error("Container absent");expect([own.Id,own.Created,own.Config.Labels["exocortex.sync-performance.run"],own.State.Running]).toEqual([f.containerId,f.created,f.runId,true]);
  const source=fileURLToPath(new URL("../../../",import.meta.url)),name="cli_"+randomUUID().replaceAll("-",""),directory=path.join(path.dirname(fixture),name),backend=path.join(directory,"backend"),physicalBackup=path.join(directory,"physical-backup");
  const url=new URL(f.databaseUrl),adminUrl=new URL(url);adminUrl.pathname="/postgres";
  expect([url.hostname,url.port,f.template]).toEqual(["127.0.0.1",own.NetworkSettings.Ports["5432/tcp"]?.[0]?.HostPort,"revalidation_template"]);
  const admin=new Database(adminUrl.toString(),{max:1});let db:Database|undefined;
  const checks:string[]=[];
  try{
    await fs.mkdir(backend,{recursive:true});await fs.mkdir(physicalBackup);
    await admin.withSql(sql=>sql.unsafe(`CREATE DATABASE ${name} TEMPLATE ${f.template}`));url.pathname="/"+name;db=new Database(url.toString(),{max:1});const adb=db;
    for(const migration of ["0058_guarded_runtime_activation.up.sql","0059_offline_folder_revalidation.up.sql"]){const body=await fs.readFile(path.join(source,"packages/database/migrations",migration),"utf8");await adb.transaction(sql=>sql.unsafe(body));}
    for(const role of [f.guard.writer_login,f.guard.writer_owner,f.guard.runtime_role])expect(role).toMatch(/^[a-z_][a-z0-9_]{0,62}$/);
    await adb.withSql(sql=>sql.unsafe(`ALTER FUNCTION public.catalog_folder_revalidation_command(text,jsonb,jsonb) OWNER TO ${f.guard.writer_owner};GRANT EXECUTE ON FUNCTION public.catalog_folder_revalidation_command(text,jsonb,jsonb) TO ${f.guard.writer_login}`));
    const functions=await adb.withSql(sql=>sql<{identity:string;sourceSha256:string}[]>`SELECT 'public.'||p.oid::regprocedure::text AS identity,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS "sourceSha256" FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=${f.guard.writer_owner}) ORDER BY p.oid`);
    expect(functions.map(p=>p.identity).sort()).toEqual(["public.catalog_folder_command(text,jsonb,jsonb)","public.catalog_folder_revalidation_command(text,jsonb,jsonb)","public.catalog_folder_v2_command(text,jsonb,jsonb,jsonb)","public.catalog_guard_upgrade_file(uuid)","public.catalog_upload_command(text,jsonb,jsonb,jsonb)"].sort());
    const root=f.client.binding["root_id"];if(!root)throw Error("Root missing");
    const tree=await adb.withSql(sql=>sql<FolderRevalidationTreeEntry[]>`WITH RECURSIVE t AS (SELECT id FROM resources WHERE id=${root} UNION ALL SELECT r.id FROM resources r JOIN t ON r.parent_id=t.id)
      SELECT catalog_namespace_description(r,${root}::uuid) AS description,storage_path AS "storagePath" FROM resources r JOIN t ON t.id=r.id ORDER BY r.id`);
    expect(tree).toHaveLength(58);
    for(const targetRoot of [backend,physicalBackup])for(const e of [...tree].sort((a,b)=>a.storagePath.length-b.storagePath.length)){
      const target=path.resolve(targetRoot,e.storagePath);if(!target.startsWith(path.resolve(targetRoot)+path.sep))throw Error("Copy scope");
      if(e.description.type==="folder")await fs.mkdir(target,{recursive:true});else await fs.copyFile(path.join(f.originalStorageDirectory,e.storagePath),target);
    }
    const dump=(await exec("docker",["exec",f.containerId,"pg_dump","-U","postgres","-d",name,"-Fc","--lock-wait-timeout=2000"],{windowsHide:true,encoding:"buffer",maxBuffer:4194304})).stdout;
    const write=async(file:string,value:unknown)=>{const full=path.join(directory,file),bytes=typeof value==="string"?value:JSON.stringify(value,null,2)+"\n";await fs.writeFile(full,bytes,{flag:"wx",mode:0o600});return {file:full,sha256:sha(bytes)};};
    const dumpFile=path.join(directory,"database.dump");await fs.writeFile(dumpFile,dump,{flag:"wx"});
    const generation=randomUUID(),stat=await fs.stat(backend,{bigint:true}),nativeIdentity=stat.dev.toString(16).padStart(8,"0")+":"+stat.ino.toString(16).padStart(16,"0"),common={binding:f.client.binding,backendIdentity:f.guard.backend_identity,backendRoot:backend,backendGeneration:generation};
    const construction=await write("clone-construction.json",{schema:"saturn.test-owned-clone.v1",containerId:f.containerId,database:name,backendRoot:backend,objects:tree.length,dumpSha256:sha(dump)});
    // Retain the accepted historical bootstrap document from the source cohort;
    // a populated clone must never manufacture a fresh-empty root receipt.
    const rootProofFile=path.join(path.dirname(f.originalStorageDirectory),"root-bootstrap-verification.json"),rootProof={file:rootProofFile,sha256:sha(await fs.readFile(rootProofFile))};
    const bootstrap=await write("bootstrap.json",{schema:"saturn.offline-folder-bootstrap.v1",...common,acceptedConstruction:[construction],rootProof});
    const drain=await write("drain.json",{schema:"saturn.offline-folder-drain.v1",...common,backendNativeIdentity:nativeIdentity,nativeProcesses:[],containers:[]});
    const backup=await write("backup.json",{schema:"saturn.offline-folder-backup.v1",...common,expectedSeq:"73",treeSha256:folderRevalidationTreeSha256(tree),databaseDump:{file:dumpFile,sha256:sha(dump)},physicalRoot:physicalBackup});
    const operationId=randomUUID(),now=Date.now(),intent={schema:"saturn.catalog-folder-revalidation-intent.v1",operationId,idempotencyKey:"folder-revalidate-"+operationId,binding:f.client.binding,guardRevision:f.guard.guard_revision,backendIdentity:f.guard.backend_identity,deviceId:f.client.deviceId,expectedSeq:"73",observedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),
      custody:{backendGeneration:generation,bootstrapSha256:bootstrap.sha256,drainSha256:drain.sha256,backupSha256:backup.sha256,treeSha256:folderRevalidationTreeSha256(tree)},tree,folders:tree.filter(e=>e.description.availability==="UNKNOWN").map(e=>e.description.node_id)};
    const original=await write("original.json",intent),ru=new URL(f.writerUrl),wu=new URL(f.writerUrl);ru.username=f.guard.runtime_role;ru.pathname="/"+name;wu.pathname="/"+name;
    const runtimeFile=await write("runtime.url",ru.toString()),writerFile=await write("writer.url",wu.toString()),authorization=await write("authorization.txt","Bearer "+f.client.token),pepper=await write("pepper.txt",f.pepper),helper=path.join(source,"scripts/folder-revalidation-handles.ps1");
    const plan={schema:"saturn.offline-folder-revalidation-plan.v1",original,...common,binding:f.client.binding,guardRevision:f.guard.guard_revision,backendNativeIdentity:nativeIdentity,
      runtimeDatabaseUrlFile:runtimeFile.file,writerDatabaseUrlFile:writerFile.file,authorizationFile:authorization.file,pepperFile:pepper.file,evidenceDirectory:directory,
      powershell:path.join(process.env["SystemRoot"]??"C:/Windows","System32/WindowsPowerShell/v1.0/powershell.exe"),nativeHelper:helper,nativeHelperSha256:sha(await fs.readFile(helper)),
      roles:{runtimeRole:f.guard.runtime_role,writerLogin:f.guard.writer_login,writerOwner:f.guard.writer_owner,migratorRole:"postgres"},approvedFunctions:functions,bootstrap,drain,backup};
    const acceptedPlan=await write("plan.json",plan);
    const run=async(ref:{file:string;sha256:string},label:string)=>{
      try{const result=await exec(process.execPath,[path.join(source,"node_modules/tsx/dist/cli.mjs"),"--tsconfig",path.join(source,"apps/api/tsconfig.json"),path.join(source,"scripts/revalidate-guarded-folders.mts"),ref.file,ref.sha256],{cwd:source,windowsHide:true,maxBuffer:1048576,timeout:25000});await fs.writeFile(path.join(directory,label+".stdout.log"),result.stdout);await fs.writeFile(path.join(directory,label+".stderr.log"),result.stderr);return {ok:true,stdout:result.stdout,stderr:result.stderr};}
      catch(error){const e=error as Error&{stdout?:string;stderr?:string};await fs.writeFile(path.join(directory,label+".stdout.log"),e.stdout??"");await fs.writeFile(path.join(directory,label+".stderr.log"),e.stderr??e.message);return {ok:false,stdout:e.stdout??"",stderr:e.stderr??e.message};}
    };
    const before=await adb.withSql(sql=>sql`SELECT published_seq::text FROM sync_root_clock WHERE root_id=${root}`);
    const unpinned=await run({...acceptedPlan,sha256:"f".repeat(64)},"unpinned-plan");expect(unpinned.ok,unpinned.stderr).toBe(false);expect(unpinned.stderr).toContain("qualification_changed");checks.push("unpinned plan refused");
    const wrongBootstrap=await write("bad-bootstrap-plan.json",{...plan,bootstrap:{...bootstrap,sha256:"f".repeat(64)}}),refused=await run(wrongBootstrap,"bad-bootstrap");expect(refused.ok,refused.stderr).toBe(false);expect(refused.stderr).toContain("qualification_changed");expect(await adb.withSql(sql=>sql`SELECT published_seq::text FROM sync_root_clock WHERE root_id=${root}`)).toEqual(before);checks.push("missing bootstrap proof refuses without root effects");
    const result=await run(acceptedPlan,"commit");expect(result.ok,result.stderr).toBe(true);expect(result.stdout).toContain('"firstSeq":"74"');expect(result.stdout).toContain('"lastSeq":"77"');checks.push("new PID private CLI commits actual native + SQL");
    const replay=await run(acceptedPlan,"replay");expect(replay.ok,replay.stderr).toBe(true);expect(replay.stdout).toContain('"replayed":true');expect(await fs.readFile(original.file,"utf8")).toBe(JSON.stringify(intent,null,2)+"\n");checks.push("new PID exact original replay");
    await adb.withSql(sql=>sql.unsafe(`REVOKE ALL ON FUNCTION public.catalog_folder_revalidation_command(text,jsonb,jsonb) FROM ${f.guard.writer_login};ALTER FUNCTION public.catalog_folder_revalidation_command(text,jsonb,jsonb) OWNER TO postgres`));
    expect((await adb.withSql(sql=>sql<{allowed:boolean}[]>`SELECT has_function_privilege(${f.guard.writer_login},'catalog_folder_revalidation_command(text,jsonb,jsonb)','EXECUTE') AS allowed`))[0]?.allowed).toBe(false);checks.push("offline command permit revoked and owner returned to migrator");
    const runtimeCheck=new Database(ru.toString(),{max:1}),writerCheck=new Database(wu.toString(),{max:1});
    try{const approvedFunctions=functions.filter(fn=>!fn.identity.includes("catalog_folder_revalidation_command"));
      await qualifyCatalogDatabaseRoles(runtimeCheck,{...plan.roles,approvedFunctions,connection:"runtime"});await qualifyCatalogDatabaseRoles(writerCheck,{...plan.roles,approvedFunctions,connection:"writer"});
      checks.push("preexisting runtime/writer function policy qualifies after private permit closes");
    }finally{await writerCheck.close();await runtimeCheck.close();}
    await fs.writeFile(path.join(f.fixtureDirectory,"revalidation-cli-result.json"),JSON.stringify({at:new Date().toISOString(),checks,directory,originalTouched:false,scope:"controlled logical/physical clone, real device authentication/roles/CLI/native/SQL; no original custody claim"},null,2)+"\n");
  }finally{await db?.close();await admin.withSql(sql=>sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));await admin.close();}
},90000);
