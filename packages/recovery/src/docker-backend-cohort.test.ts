import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe,it,expect } from 'vitest';
import type { Database } from '@saturn/database';
import { dockerCohortConfigurationSha256,DockerBackendCohort,EngineFencedBackendOwner,type DockerCohortControl,type DockerCohortMember } from './docker-backend-cohort.js';
import { recoverEngineFencedBackendOwner } from './backend-owner-process.js';

const identity={backendIdentity:'qualified-backend',generation:'00000000-0000-4000-8000-000000000001',ownerId:'00000000-0000-4000-8000-000000000002',fencingToken:'00000000-0000-4000-8000-000000000003'};
const members:DockerCohortMember[]=[{id:'a'.repeat(64),created:'2026-11-22T00:00:00Z',image:'sha256:'+'b'.repeat(64),role:'worker'},{id:'c'.repeat(64),created:'2026-11-22T00:00:00Z',image:'sha256:'+'b'.repeat(64),role:'api'}];
const control:DockerCohortControl={executable:process.execPath,executableSha256:createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),endpoint:'unix:///run/qualified-docker.sock',engineId:'qualified-engine',ownershipLabel:{key:'qualification.cohort',value:'owned'},writerVolumes:['owned-payload'],registration:{fileName:'backend-owner-registration.json',nonce:'d'.repeat(64),parentScriptSHA256:'e'.repeat(64)}};
describe('Independent engine custody boundary',()=>{
  it.each([{}, {proof:()=>({schema:'saturn.authenticated-engine-cohort-fence.v1',recoveryId:identity.ownerId,identity,oldContainerIdsPermanentlyRemoved:true})},Object.create(EngineFencedBackendOwner.prototype)])('refuses fabricated receipts before any SQL authority is used',async forged=>{
    let touched=false;const database={withExclusiveMaintenance:()=>{touched=true;throw Error('SQL must never be reached');}} as unknown as Database;
    await expect(recoverEngineFencedBackendOwner(database,forged as EngineFencedBackendOwner)).rejects.toThrow('authenticated_engine_fence_required');expect(touched).toBe(false);
  });
  it('cannot construct a trusted fence with an arbitrary symbol',()=>{
    expect(()=>new EngineFencedBackendOwner(Symbol('authenticated-engine-fence'),{} as DockerBackendCohort,{})).toThrow('authenticated_engine_fence_required');
  });
  it.each(['tcp://127.0.0.1:2375','http://localhost:2375','unix:///run/docker.sock\n--context=foreign'])('refuses unauthenticated or malformed engine endpoints before starting a client',async endpoint=>{
    await expect(DockerBackendCohort.observe({...control,endpoint},members,identity,()=>Promise.resolve())).rejects.toThrow('cohort_configuration_invalid');
  });
  it.each([{value:[]},{value:[members[0]]},{value:[members[0],members[0]]},{value:members.map(m=>({...m,role:'api'}))},{value:members.map((m,i)=>({...m,role:i?'foreign':'worker'}))}])('requires the exact two distinct runtime roles and IDs',async ({value})=>{
    await expect(DockerBackendCohort.observe(control,value as unknown as DockerCohortMember[],identity,()=>Promise.resolve())).rejects.toThrow('cohort_configuration_invalid');
  });
  it('rejects a changed owner token and unqualified writable-volume contract before engine access',async()=>{
    await expect(DockerBackendCohort.observe(control,members,{...identity,fencingToken:'expired-heartbeat'},()=>Promise.resolve())).rejects.toThrow('cohort_configuration_invalid');
    await expect(DockerBackendCohort.observe({...control,writerVolumes:[]},members,identity,()=>Promise.resolve())).rejects.toThrow('cohort_configuration_invalid');
  });
});


describe('Docker wire ordering is not a process identity change',()=>{
 const original={Id:'a'.repeat(64),Created:'2026-11-22T00:00:00Z',Image:'sha256:'+'b'.repeat(64),Name:'/qualified-worker',State:{StartedAt:'2026-11-22T00:00:01Z'},Config:{Labels:{alpha:'a',beta:'b'},Env:['TOKEN_FILE=/private/runtime']},HostConfig:{Memory:1024,Privileged:false,RestartPolicy:{Name:'no'}},Mounts:[{Type:'volume',Name:'owned-data',Destination:'/data',RW:true},{Type:'bind',Source:'/qualified/config',Destination:'/config',RW:false}]};
 it('accepts map and mount-array serialization permutations without weakening fields',()=>{
  const reordered={...original,Config:{Env:original.Config.Env,Labels:{beta:'b',alpha:'a'}},Mounts:[...original.Mounts].reverse()};
  expect(dockerCohortConfigurationSha256(reordered)).toBe(dockerCohortConfigurationSha256(original));
 });
 it.each(['Id','Created','Image','Name','StartedAt','Config','HostConfig','Mounts'])('retains the %s identity and authority boundary',key=>{
  const changed:Record<string,unknown>=structuredClone(original);
  if(key==='StartedAt')changed.State={StartedAt:'2026-11-22T00:00:02Z'};
  else if(key==='Config')changed.Config={...original.Config,Env:['TOKEN_FILE=/different/authority']};
  else if(key==='HostConfig')changed.HostConfig={...original.HostConfig,Privileged:true};
  else if(key==='Mounts')changed.Mounts=original.Mounts.map(m=>({...m,RW:!m.RW}));
  else changed[key]='changed';
  expect(dockerCohortConfigurationSha256(changed)).not.toBe(dockerCohortConfigurationSha256(original));
 });
});


describe('Actual worker ownership must be registered before independent fencing',()=>{
 it.each([{name:'missing',value:undefined},{name:'wrong file',value:{fileName:'../forged',nonce:'d'.repeat(64),parentScriptSHA256:'e'.repeat(64)}},{name:'wrong nonce',value:{fileName:'backend-owner-registration.json',nonce:'forged',parentScriptSHA256:'e'.repeat(64)}},{name:'wrong parent code',value:{fileName:'backend-owner-registration.json',nonce:'d'.repeat(64),parentScriptSHA256:'forged'}}])('refuses $name registration configuration before any engine client starts',async ({value})=>{
  await expect(DockerBackendCohort.observe({...control,registration:value} as unknown as DockerCohortControl,members,identity,()=>Promise.resolve())).rejects.toThrow('cohort_configuration_invalid');
 });
});
