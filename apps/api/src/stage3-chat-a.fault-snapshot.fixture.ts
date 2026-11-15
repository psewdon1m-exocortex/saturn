import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {fixtureManifest} from "./stage3-chat-a.fixture.js";
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
interface OriginalFile {source:string;copy:string;bytes:number;sha256:string}
async function save(file:string,value:unknown){await fs.writeFile(file,JSON.stringify(value,null,2)+"\n",{flag:"wx",mode:0o600});}
export async function captureFixtureDocker(root:string,args:string[],input?:Buffer){
  const id=randomUUID(),startedAt=new Date().toISOString(),child=spawn("docker",args,{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  const chunks:Buffer[]=[];let bytes=0,stderr="";const observation:{overflow:boolean;spawnError:string|undefined;inputError:string|undefined;inputErrorCode:string|undefined}={overflow:false,spawnError:undefined,inputError:undefined,inputErrorCode:undefined};
  child.stdout.on("data",(b:Buffer)=>{bytes+=b.length;if(bytes<=67108864)chunks.push(b);else observation.overflow=true;});
  child.stderr.on("data",(b:Buffer)=>{if(Buffer.byteLength(stderr)+b.length<=65536)stderr+=b.toString();else observation.overflow=true;});child.on("error",e=>{observation.spawnError=e.message;});child.stdin.on("error",(error: NodeJS.ErrnoException)=>{observation.inputError=error.message;observation.inputErrorCode=error.code;});
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null;finishedAt:string}>(resolve=>child.once("close",(code,signal)=>resolve({code,signal,finishedAt:new Date().toISOString()})));
  child.stdin.end(input);
  const result=await closed;
  const output=Buffer.concat(chunks);
  // pg_restore --list reads the TOC and exits without consuming the data blocks.
  // A full restore must still consume the entire input and exit successfully.
  const tocReaderClosedEarly = observation.inputError !== undefined
    && ["EPIPE", "EOF"].includes(observation.inputErrorCode ?? "")
    && args.length === 5 && args[0] === "exec" && args[1] === "-i" && args[3] === "pg_restore" && args[4] === "--list"
    && input?.subarray(0, 5).toString() === "PGDMP" && result.code === 0 && stderr === ""
    && output.includes(Buffer.from("TOC Entries:"));
  await save(path.join(root,"snapshot-command-"+id+".json"),{pid:child.pid,parentPid:process.pid,args,startedAt,...result,...observation,tocReaderClosedEarly,bytes,stderr});
  if(result.code!==0||result.signal||observation.overflow||observation.spawnError||(observation.inputError&&!tocReaderClosedEarly))throw Error("fault_snapshot_command_refused");
  return output;
}
export async function snapshotFixtureBeforeFault(configFile:string,root:string,scope:string){
  const fixture=await fixtureManifest(),configBytes=await fs.readFile(configFile),c=JSON.parse(configBytes.toString()) as {url:string;directory:string;backendIdentity:string;generation:string;phase:string;privateArtifacts?:string[]};
  const database=path.basename(path.dirname(configFile)),base=new URL(fixture.databaseUrl),target=new URL(c.url);
  if(!/^stage3_[a-f0-9]{32}$/.test(database)||target.pathname!=="/"+database||target.hostname!==base.hostname||target.port!==base.port||path.resolve(c.directory)!==path.resolve(path.dirname(configFile),"storage")||!path.resolve(configFile).startsWith(path.resolve(fixture.fixtureDirectory)+path.sep)||c.backendIdentity!=="backend-"+database.slice(7))throw Error("fault_snapshot_fixture_custody_refused");
  const nativeScope=["queued","before","after"].includes(c.phase)?scope==="A03-native-"+c.phase:["retention-queued","retention-effect","retention-done"].includes(c.phase)&&scope==="A08-native-"+c.phase;
  const lifecycleScope=["adopt","checkpoint","pause","resume","before-progress","after-progress","after-receipt"].some(phase=>c.phase==="lifecycle-"+phase&&scope==="A13-cli-"+phase);
  if(!nativeScope&&!lifecycleScope)throw Error("explicit_prework_scope_required");
  const output=path.join(root,"before-fault");await fs.mkdir(output,{mode:0o700});
  const files:OriginalFile[]=[];let total=0;
  async function copy(dir:string){const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error("fault_snapshot_storage_reparse");for(const entry of await fs.readdir(dir,{withFileTypes:true})){const source=path.join(dir,entry.name),target=path.join(output,"storage",path.relative(c.directory,source));const before=await fs.lstat(source);if(before.isSymbolicLink())throw Error("fault_snapshot_original_reparse");if(before.isDirectory()){await fs.mkdir(target,{recursive:true,mode:0o700});await copy(source);}else if(before.isFile()){total+=before.size;if(total>33554432||files.length>=256)throw Error("fault_snapshot_original_bound");const bytes=await fs.readFile(source);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,bytes,{flag:"wx",mode:0o600});const after=await fs.stat(source);if(after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs||bytes.length!==before.size)throw Error("fault_snapshot_original_changed");files.push({source,copy:target,bytes:bytes.length,sha256:sha(bytes)});}else throw Error("fault_snapshot_original_type");}}
  await fs.mkdir(path.join(output,"storage"),{mode:0o700});await copy(c.directory);
  const dump=await captureFixtureDocker(root,["exec",fixture.containerId,"pg_dump","--format=custom","-U","postgres","--dbname",database]);if(dump.subarray(0,5).toString()!=="PGDMP")throw Error("fault_snapshot_dump_format");
  const dumpFile=path.join(output,"database.dump");await fs.writeFile(dumpFile,dump,{flag:"wx",mode:0o600});
  const toc=await captureFixtureDocker(root,["exec","-i",fixture.containerId,"pg_restore","--list"],dump);if(!toc.toString().includes("TABLE DATA public"))throw Error("fault_snapshot_archive_list_required");await fs.writeFile(path.join(output,"archive-list.txt"),toc,{flag:"wx",mode:0o600});
  const suffix=database.slice(7),roles=["rt_","wr_","ow_"].map(prefix=>prefix+suffix),quoted=roles.map(role=>"'"+role+"'").join(",");
  const roleQuery="SELECT jsonb_build_object('roles',(SELECT jsonb_agg(to_jsonb(a)-'oid') FROM pg_authid a WHERE rolname IN ("+quoted+")),'memberships',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'admin_option',a.admin_option)),'[]'::jsonb) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE r.rolname IN ("+quoted+") OR m.rolname IN ("+quoted+")))";
  const roleBytes=await captureFixtureDocker(root,["exec",fixture.containerId,"psql","-X","-A","-t","-U","postgres","-d","postgres","-c",roleQuery]);const authority=JSON.parse(roleBytes.toString()) as {roles:{rolname:string;rolsuper:boolean;rolcreatedb:boolean;rolcreaterole:boolean;rolreplication:boolean;rolbypassrls:boolean}[]};
  if(authority.roles.length!==3||authority.roles.some(r=>!roles.includes(r.rolname)||r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolreplication||r.rolbypassrls))throw Error("fault_snapshot_authority_scope");
  await fs.writeFile(path.join(output,"roles-and-memberships.private.json"),roleBytes,{flag:"wx",mode:0o600});await fs.writeFile(path.join(output,"child-config.private.json"),configBytes,{flag:"wx",mode:0o600});const fixtureBytes=await fs.readFile(process.env.STAGE3_CHAT_A_FIXTURE??"");await fs.writeFile(path.join(output,"fixture.private.json"),fixtureBytes,{flag:"wx",mode:0o600});
  for(const row of files)if(sha(await fs.readFile(row.source))!==row.sha256||sha(await fs.readFile(row.copy))!==row.sha256)throw Error("fault_snapshot_original_changed_across_dump");
  const privateCopies:{source:string;copy:string;bytes:number;sha256:string}[]=[];
  if(lifecycleScope){
    const inputs=[...new Set(c.privateArtifacts??[])];if(inputs.length>16)throw Error("lifecycle_private_input_bound");
    for(const input of inputs){const source=path.resolve(input),fixtureRoot=path.resolve(path.dirname(configFile));if(!source.startsWith(fixtureRoot+path.sep))throw Error("lifecycle_private_input_scope");for(let current=source;;current=path.dirname(current)){const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw Error("lifecycle_private_input_reparse");if(current===fixtureRoot)break;}
      const before=await fs.lstat(source);if(!before.isFile()||before.nlink!==1||before.size>4194304)throw Error("lifecycle_private_input_type");const bytes=await fs.readFile(source),copy=path.join(output,"configuration-inputs",path.relative(fixtureRoot,source));await fs.mkdir(path.dirname(copy),{recursive:true,mode:0o700});await fs.writeFile(copy,bytes,{flag:"wx",mode:0o600});const after=await fs.lstat(source);if(after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error("lifecycle_private_input_changed");privateCopies.push({source,copy,bytes:bytes.length,sha256:sha(bytes)});
    }
  }
  const artifacts=[...privateCopies.map(x=>x.copy),dumpFile,path.join(output,"archive-list.txt"),path.join(output,"roles-and-memberships.private.json"),path.join(output,"child-config.private.json"),path.join(output,"fixture.private.json")];const artifactPins=await Promise.all(artifacts.map(async file=>({path:file,sha256:sha(await fs.readFile(file))})));
  const receipt={schema:"saturn.test-native-fault.snapshot.v1",scope,phase:c.phase,database,containerId:fixture.containerId,containerCreated:fixture.created,files,originalBytes:total,privateCopies,artifactPins,SQLWrites:0,createdAt:new Date().toISOString(),coherence:"single isolated fixture, physical originals stable across transactional pg_dump, before gated fault actor admission",archiveParsedByRealPgRestore:true,ownersAndScopedRolesRetained:true};await save(path.join(output,"receipt.json"),receipt);
  return {receipt,path:path.join(output,"receipt.json"),sha256:sha(Buffer.from(JSON.stringify(receipt,null,2)+"\n"))};
}
export async function verifyFaultSnapshot(snapshot:Awaited<ReturnType<typeof snapshotFixtureBeforeFault>>){if(sha(await fs.readFile(snapshot.path))!==snapshot.sha256)throw Error("fault_snapshot_receipt_changed");for(const row of snapshot.receipt.files)if(sha(await fs.readFile(row.copy))!==row.sha256)throw Error("fault_snapshot_copy_changed");for(const row of snapshot.receipt.artifactPins)if(sha(await fs.readFile(row.path))!==row.sha256)throw Error("fault_snapshot_artifact_changed");}
