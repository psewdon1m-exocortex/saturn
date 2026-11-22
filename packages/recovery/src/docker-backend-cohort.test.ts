import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe,it,expect } from 'vitest';
import type { Database } from '@saturn/database';
import { DockerBackendCohort,EngineFencedBackendOwner,type DockerCohortControl,type DockerCohortMember } from './docker-backend-cohort.js';
import { recoverEngineFencedBackendOwner } from './backend-owner-process.js';

const identity={backendIdentity:'qualified-backend',generation:'00000000-0000-4000-8000-000000000001',ownerId:'00000000-0000-4000-8000-000000000002',fencingToken:'00000000-0000-4000-8000-000000000003'};
const members:DockerCohortMember[]=[{id:'a'.repeat(64),created:'2026-11-22T00:00:00Z',image:'sha256:'+'b'.repeat(64),role:'worker'},{id:'c'.repeat(64),created:'2026-11-22T00:00:00Z',image:'sha256:'+'b'.repeat(64),role:'api'}];
const control:DockerCohortControl={executable:process.execPath,executableSha256:createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),endpoint:'unix:///run/qualified-docker.sock',engineId:'qualified-engine',ownershipLabel:{key:'qualification.cohort',value:'owned'},writerVolumes:['owned-payload']};
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
