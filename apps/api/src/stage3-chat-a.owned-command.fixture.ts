import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {fixtureManifest} from "./stage3-chat-a.fixture.js";
import {startOwnedFixtureProcess} from "./stage3-chat-a.owned-process.fixture.js";
interface Context {directory:string;url:string;backendIdentity:string;generation:string}
interface CommandInput {action:string;lifecycleConfig:string;artifact?:string;fault?:string;privateArtifacts:readonly string[]}
let admissionClosed=false;
export async function ownedLifecycleCommand(f:Context,input:CommandInput){
 if(admissionClosed)throw Error("lifecycle_command_admission_closed");
 const observeMs=60000,startedAt=new Date().toISOString(),deadlineMs=Date.now()+observeMs,id=randomUUID(),config=path.join(f.directory,"owned-command-"+id+".json"),fixture=await fixtureManifest();
 const privateArtifacts=[...input.privateArtifacts];
 if(input.artifact){const artifactPath=path.resolve(input.artifact);if(!artifactPath.startsWith(path.resolve(f.directory)+path.sep))throw Error("lifecycle_artifact_scope_required");const before=await fs.lstat(artifactPath);if(!before.isFile()||before.isSymbolicLink()||before.size>4194304)throw Error("lifecycle_artifact_type_refused");const artifact=JSON.parse(await fs.readFile(artifactPath,"utf8")) as unknown;if(artifact&&typeof artifact==="object"&&"entriesFile" in artifact&&typeof artifact.entriesFile==="string")privateArtifacts.push(artifact.entriesFile);}
 const spec={schema:"saturn.test-owned-lifecycle-command.v1",...input,privateArtifacts,url:f.url,directory:path.join(f.directory,"storage"),backendIdentity:f.backendIdentity,generation:f.generation,phase:"lifecycle-"+(input.fault??input.action),containerId:fixture.containerId};await fs.writeFile(config,JSON.stringify(spec,null,2)+"\n",{flag:"wx",mode:0o600});
 const state:{expired:boolean;metadataError:string|undefined}={expired:false,metadataError:undefined};let deadlineWrite:Promise<void>|undefined;
 const timer=setTimeout(()=>{state.expired=true;admissionClosed=true;deadlineWrite=fs.writeFile(path.join(f.directory,"owned-command-"+id+"-deadline.json"),JSON.stringify({startedAt,deadlineMs,observedAt:new Date().toISOString(),actualExit:null,actorPending:true,admissionClosed:true,noKill:true})+"\n",{flag:"wx",mode:0o600}).catch((error:unknown)=>{state.metadataError=String(error);});},observeMs);
 try{
  const snapshot=["adopt","checkpoint","pause","resume"].includes(input.action),helper=fileURLToPath(new URL("./stage3-chat-a.owned-command-helper.mts",import.meta.url));
  const options={deadlineMs,...(snapshot?{snapshotScope:"A13-cli-"+(input.fault??input.action)}:{})};
  const owned=await startOwnedFixtureProcess(helper,config,options),actual=await owned.closed;await owned.stop();
  const raw=JSON.parse(await fs.readFile(path.join(owned.root,"closed.json"),"utf8")) as {stdout:string;stderr:string;overflow:boolean;spawnError?:string};
  const late=state.expired||Date.now()>=deadlineMs;
  await fs.writeFile(path.join(f.directory,"owned-command-"+id+"-outcome.json"),JSON.stringify({id,action:input.action,fault:input.fault??null,config,root:owned.root,startedAt,finishedAt:actual.finishedAt,actualExit:actual.code,signal:actual.signal,late,overflow:raw.overflow,noKill:true},null,2)+"\n",{flag:"wx",mode:0o600});
  if(late||state.metadataError||raw.overflow||raw.spawnError){admissionClosed=true;throw Object.assign(Error(late?"lifecycle_command_observation_deadline":"lifecycle_command_metadata_refused"),{code:"OBSERVATION_REFUSED",actualExit:actual.code});}
  if(actual.code!==0||actual.signal)throw Object.assign(Error(raw.stderr||"lifecycle_child_failed"),{code:actual.code,signal:actual.signal});
  return {stdout:raw.stdout,stderr:raw.stderr};
 }catch(error){if(!(error&&typeof error==="object"&&"code" in error&&typeof error.code==="number"))admissionClosed=true;throw error;}
 finally{clearTimeout(timer);await deadlineWrite;}
}
