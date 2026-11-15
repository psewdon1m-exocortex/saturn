import {fileURLToPath} from "node:url";
import {snapshotFixtureBeforeFault,verifyFaultSnapshot} from "./stage3-chat-a.fault-snapshot.fixture.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fork, spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { requireDefined } from "../../../packages/contracts/src/require-defined.js";

interface ProcessIdentity { pid:number; parentPid:number; exe:string; argv:string; created:string }
interface NativeExit { code:number|null; signal:NodeJS.Signals|null; finishedAt:string }
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function save(file:string,value:unknown){await fs.writeFile(file,JSON.stringify(value,null,2)+"\n",{flag:"wx",mode:0o600});}

// Metadata reads have observation deadlines, never a termination timer. Actual
// numeric exit and stdio close are persisted before parsing their output.
async function metadataCommand(root:string,binary:string,args:string[]){
  const id=randomUUID(),startedAt=new Date().toISOString(),child=spawn(binary,args,{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";const capture:{overflow:boolean;spawnError:string|undefined}={overflow:false,spawnError:undefined};
  const collect=(name:"stdout"|"stderr",b:Buffer)=>{if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+b.length>262144){capture.overflow=true;return;}if(name==="stdout")stdout+=b.toString();else stderr+=b.toString();};
  child.stdout.on("data",(b:Buffer)=>collect("stdout",b));child.stderr.on("data",(b:Buffer)=>collect("stderr",b));child.once("error",e=>{capture.spawnError=e.message;});
  const result=await new Promise<NativeExit>(resolve=>child.once("close",(code,signal)=>resolve({code,signal,finishedAt:new Date().toISOString()})));
  const late=Date.now()-Date.parse(startedAt)>7000;
  await save(path.join(root,"metadata-"+id+".json"),{pid:child.pid,parentPid:process.pid,binary,args,startedAt,...result,stdout,stderr,...capture,late});
  if(result.code!==0||result.signal||capture.overflow||capture.spawnError||late)throw Error("native_identity_metadata_refused");
  return stdout;
}
async function identity(pid:number,root:string):Promise<ProcessIdentity>{
  if(!Number.isSafeInteger(pid)||pid<=0)throw Error("native_pid_required");
  if(process.platform==="win32"){
    const script=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}';if($null -eq $p){exit 3};[pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;exe=$p.ExecutablePath;argv=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`;
    const raw=JSON.parse(await metadataCommand(root,path.join(requireDefined(process.env.SystemRoot),"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-Command",script])) as ProcessIdentity;
    if(raw.pid!==pid||!Number.isInteger(raw.parentPid)||!path.isAbsolute(raw.exe)||!raw.argv||!Number.isFinite(Date.parse(raw.created)))throw Error("native_identity_shape_refused");
    return raw;
  }
  if(process.platform!=="linux")throw Error("native_identity_platform_unqualified");
  const stat=await fs.readFile(`/proc/${String(pid)}/stat`,"utf8"),fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
  return {pid,parentPid:Number(requireDefined(fields[1])),exe:await fs.readlink(`/proc/${String(pid)}/exe`),argv:(await fs.readFile(`/proc/${String(pid)}/cmdline`,"utf8")).replaceAll("\0"," ").trim(),created:(await fs.readFile("/proc/sys/kernel/random/boot_id","utf8")).trim()+":"+requireDefined(fields[19])};
}
async function nativeExitWatch(root:string,target:ProcessIdentity,childClosed:Promise<NativeExit>){
  if(process.platform==="linux")return {finish:async()=>{
    // POSIX signal termination has no numeric exit code. Preserve the actual
    // kernel wait delivered by ChildProcess close, including its signal.
    const result=await childClosed,native={pid:target.pid,platform:"linux",nativeExitCode:result.code,signal:result.signal,finishedAt:result.finishedAt,waitForExitReturned:true,waitSource:"NODE_CHILD_CLOSE_KERNEL_WAIT"};
    await save(path.join(root,"native-exit.json"),native);return native;
  }};
  if(process.platform!=="win32")throw Error("native_fault_platform_not_qualified");
  const input=path.join(root,"native-identity.json");await save(input,{schema:"saturn.test-native-exit.identity.v1",identity:target});
  const script=fileURLToPath(new URL("./stage3-chat-a.native-exit.ps1",import.meta.url)),binary=path.join(requireDefined(process.env.SystemRoot),"System32/WindowsPowerShell/v1.0/powershell.exe"),args=["-NoProfile","-NonInteractive","-File",script,"-RootPath",root,"-IdentityPath",input];
  const startedAt=new Date().toISOString(),child=spawn(binary,args,{windowsHide:true,stdio:["ignore","pipe","pipe"]});const errors:{spawnError:string|undefined;overflow:boolean}={spawnError:undefined,overflow:false};let stdout="",stderr="";const state={exited:false};
  child.stdout.on("data",(b:Buffer)=>{if(Buffer.byteLength(stdout)+b.length<=65536)stdout+=b.toString();else errors.overflow=true;});child.stderr.on("data",(b:Buffer)=>{if(Buffer.byteLength(stderr)+b.length<=65536)stderr+=b.toString();else errors.overflow=true;});child.on("error",e=>{errors.spawnError=e.message;});
  const closed=new Promise<NativeExit>((resolve,reject)=>child.once("close",(code,signal)=>{state.exited=true;const result={code,signal,finishedAt:new Date().toISOString()};void save(path.join(root,"native-watcher-closed.json"),{pid:child.pid,parentPid:process.pid,binary,args,startedAt,...result,...errors,stdout,stderr}).then(()=>resolve(result),reject);}));void closed.catch(()=>undefined);
  const deadline=Date.now()+7000;
  try{for(;;){try{const ready=JSON.parse(await fs.readFile(path.join(root,"native-wait-ready.json"),"utf8")) as {identity:ProcessIdentity;heldNativeHandle:boolean};if(!isDeepStrictEqual(ready.identity,target)||!ready.heldNativeHandle)throw Error("native_wait_tuple_refused");break;}catch(error){if(!(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT"))throw error;}
    if(state.exited)throw Error("native_wait_actor_failed_before_ready");if(Date.now()>=deadline)throw Error("native_wait_admission_closed");await pause(10);
  }
  }catch(error){await closed;throw error;}
  return {finish:async()=>{const result=await closed;if(result.code!==0||result.signal||errors.overflow||errors.spawnError)throw Error("native_wait_actor_exit_refused");const native=JSON.parse(await fs.readFile(path.join(root,"native-exit.json"),"utf8")) as {pid:number;nativeExitCode:number;finishedAt:string;waitForExitReturned:boolean};if(native.pid!==target.pid||!Number.isInteger(native.nativeExitCode)||!native.waitForExitReturned)throw Error("native_exit_numeric_required");return native;}};
}
export async function startOwnedFixtureProcess(helper:string,config:string,options:{faultScope?:string;snapshotScope?:string;deadlineMs?:number}={}){
  if(!path.isAbsolute(helper)||!path.isAbsolute(config)||!/^stage3_[a-f0-9]{32}$/.test(path.basename(path.dirname(config))))throw Error("owned_fixture_process_paths_required");
  const root=path.join(path.dirname(config),"owned-process-"+randomUUID());await fs.mkdir(root,{mode:0o700});
  const snapshotScope=options.faultScope??options.snapshotScope;
  const snapshot=snapshotScope?await snapshotFixtureBeforeFault(config,root,snapshotScope):undefined;
  if(options.deadlineMs!==undefined&&Date.now()>=options.deadlineMs)throw Error("owned_process_admission_expired");
  const nonce=randomUUID(),startedAt=new Date().toISOString(),child=fork(helper,[config],{execArgv:["--import","tsx"],env:{...process.env,TSX_TSCONFIG_PATH:path.resolve(path.dirname(helper),"../tsconfig.json"),STAGE3_FIXTURE_START_GATE:nonce},stdio:["ignore","pipe","pipe","ipc"]});
  const messages:unknown[]=[];let stderr="",stdout="",overflow=false,spawnError:string|undefined;
  child.on("message",m=>messages.push(m));child.stdout?.on("data",(b:Buffer)=>{if(Buffer.byteLength(stdout)+b.length<=262144)stdout+=b.toString();else overflow=true;});child.stderr?.on("data",(b:Buffer)=>{if(Buffer.byteLength(stderr)+b.length<=262144)stderr+=b.toString();else overflow=true;});child.once("error",e=>{spawnError=e.message;});
  let exit:NativeExit|undefined;
  const closed=new Promise<NativeExit>((resolve,reject)=>child.once("close",(code,signal)=>{exit={code,signal,finishedAt:new Date().toISOString()};void save(path.join(root,"closed.json"),{pid:child.pid,parentPid:process.pid,helper,config,startedAt,...exit,stdout,stderr,overflow,spawnError}).then(()=>resolve(requireDefined(exit)),reject);}));
  void closed.catch(()=>undefined);
  async function message<T>():Promise<T>{const deadline=Date.now()+15000;while(!messages.length){if(exit)throw Error("fixture_child_exited_before_message "+String(exit.code)+" "+stderr);if(Date.now()>=deadline)throw Error("fixture_child_message_admission_closed");await pause(10);}return messages.shift() as T;}
  let first:ProcessIdentity,nativeWatch:Awaited<ReturnType<typeof nativeExitWatch>>|undefined;
  try{
  const ready=await message<{event:string;nonce:string;pid:number}>();if(ready.event!=="owned-ready"||ready.nonce!==nonce||ready.pid!==child.pid)throw Error("fixture_child_gate_refused");
  first=await identity(requireDefined(child.pid),root);
  if(first.parentPid!==process.pid||path.resolve(first.exe).toLowerCase()!==path.resolve(process.execPath).toLowerCase()||!first.argv.includes(helper)||!first.argv.includes(config))throw Error("fixture_child_tuple_refused");
  await save(path.join(root,"qualified.json"),{identity:first,helper,config,nonce,startedAt,qualifiedAt:new Date().toISOString()});
  nativeWatch=snapshot?await nativeExitWatch(root,first,closed):undefined;
  if(options.deadlineMs!==undefined&&Date.now()>=options.deadlineMs)throw Error("owned_process_admission_expired");
  child.send({kind:"owned-start",nonce});
  }catch(error){await closed;throw error;}
  return {child,closed,message,root,identity:first,
    crash:async()=>{
      if(!snapshot||!nativeWatch||!options.faultScope)throw Error("explicit_fault_card_snapshot_required");
      await verifyFaultSnapshot(snapshot);const current=await identity(requireDefined(child.pid),root);if(!isDeepStrictEqual(current,first))throw Error("fixture_child_tuple_changed_before_fault");
      await save(path.join(root,"fault-admitted.json"),{scope:options.faultScope,identity:current,snapshot:{path:snapshot.path,sha256:snapshot.sha256},at:new Date().toISOString(),signal:"SIGKILL",ordinaryCompletion:false});
      const signalled=child.kill("SIGKILL");await save(path.join(root,"fault-signal-result.json"),{signalled,at:new Date().toISOString()});
      const nodeExit=await closed,nativeExit=await nativeWatch.finish();if(!signalled||!(nativeExit.nativeExitCode!==null&&nativeExit.nativeExitCode!==0||("signal" in nativeExit&&nativeExit.signal==="SIGKILL")))throw Error("admitted_fault_not_observed");return {nodeExit,nativeExit};
    },
    stop:async()=>{if(!exit){const current=await identity(requireDefined(child.pid),root);if(!isDeepStrictEqual(current,first))throw Error("fixture_child_tuple_changed_before_stop");await new Promise<void>((resolve,reject)=>child.send({kind:"owned-stop",nonce},error=>error?reject(error):resolve()));}const result=await closed;if(nativeWatch)await nativeWatch.finish();return result;},
    release:async()=>{
    if(exit)return closed;
    const current=await identity(requireDefined(child.pid),root);if(!isDeepStrictEqual(current,first))throw Error("fixture_child_tuple_changed_before_IPC");
    await new Promise<void>((resolve,reject)=>child.send({release:true},error=>error?reject(error):resolve()));
    return closed;
  }};
}
export async function requireNormalFixtureExit(closed:Promise<NativeExit>){const result=await closed;if(result.code!==0||result.signal)throw Error("fixture_child_not_normal_exit "+String(result.code));return result;}
