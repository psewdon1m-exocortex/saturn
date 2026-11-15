import {expect,it,vi} from 'vitest';
import {createGuardedBackendCommand} from './guarded-backend-command.js';
import type {BackendExecutorIdentity} from '../../storage/src/durable-backend-executor.js';
const identity:BackendExecutorIdentity={backendIdentity:'unit',generation:'generation',ownerId:'owner',fencingToken:'fence'};
const payload={id:'original',body:{payloadRef:'fresh'}};
it('compound observer proof is invocation-bound and does not consume cleanup authority',async()=>{
  const raw=Error('invalid_input');let saved:object|undefined;
  const writer={
    backendCommand:vi.fn(async()=>({})),
    backendSubmitAndClaim:vi.fn(async(_c:string,_i:unknown,_p:unknown,w?:object)=>{saved=w;throw raw;}),
    confirmsBackendRollback:vi.fn((e:unknown,c:string,i:unknown,p:unknown,w:object)=>e===raw&&c==='submit-once'&&i===identity&&p===payload&&w===saved),
    confirmsBackendSubmitClaimRollback:vi.fn((e:unknown,c:string,i:unknown,p:unknown,w:object)=>e===raw&&c==='submit-once'&&i===identity&&p===payload&&w===saved),
  };
  const command=createGuardedBackendCommand(writer),compound=command.submitAndClaim;
  if(!compound)throw Error('Expected compound capability');
  const failure=await compound('submit-once',identity,payload).catch((e:unknown)=>e);
  expect(Object.isFrozen(saved)).toBe(true);
  expect(compound.confirmsNoCommit?.(failure,'submit-once',identity,payload)).toBe(true);
  expect(compound.confirmsNoCommit?.(failure,'submit-once',identity,{...payload,id:'other'})).toBe(false);
  expect(command.confirmedRollback?.(failure,'submit-once',identity,payload)).toBe(true);
  expect(command.confirmedRollback?.(failure,'submit-once',identity,payload)).toBe(false);
  expect(compound.confirmsNoCommit?.(failure,'submit-once',identity,payload)).toBe(false);
});
it('ordinary errors and forged cause/code cannot supply compound rollback evidence',async()=>{
  const raw=Object.assign(Error('invalid_input'),{code:'P0001'});
  const writer={backendCommand:async()=>{throw raw;},backendSubmitAndClaim:async()=>{throw raw;},
    confirmsBackendRollback:()=>true,confirmsBackendSubmitClaimRollback:()=>true};
  const command=createGuardedBackendCommand(writer),compound=command.submitAndClaim;
  if(!compound)throw Error('Expected capability');
  const ordinary=await command('submit-once',identity,payload).catch((e:unknown)=>e);
  expect(compound.confirmsNoCommit?.(ordinary,'submit-once',identity,payload)).toBe(false);
  for(const error of [raw,{code:'55P03',cause:raw},Object.assign(Error('invalid_input'),{cause:raw})])
    expect(compound.confirmsNoCommit?.(error,'submit-once',identity,payload)).toBe(false);
});
it('unconfirmed compound error stays unconfirmed and old writer exposes no compound capability',async()=>{
  const raw=Object.assign(Error('connection_lost'),{code:'55P03'});
  const command=createGuardedBackendCommand({backendCommand:async()=>({}),backendSubmitAndClaim:async()=>{throw raw;},
    confirmsBackendRollback:()=>false,confirmsBackendSubmitClaimRollback:()=>false});
  const c=command.submitAndClaim;if(!c)throw Error('Expected capability');
  const error=await c('submit',identity,payload).catch((e:unknown)=>e);
  expect(c.confirmsNoCommit?.(error,'submit',identity,payload)).toBe(false);
  expect(command.confirmedRollback?.(error,'submit',identity,payload)).toBe(false);
  expect(createGuardedBackendCommand({backendCommand:async()=>({}),confirmsBackendRollback:()=>false}).submitAndClaim).toBeUndefined();
});
