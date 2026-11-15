import {beforeEach,expect,it,vi} from 'vitest';
import postgres from 'postgres';
import {Database} from './index.js';
interface Call{query:string;values:unknown[]}
const transport=vi.hoisted<{calls:Call[];respond:(call:Call)=>unknown}>(()=>({calls:[],respond:()=>[{value:{}}]}));
vi.mock('postgres',async importOriginal=>{
  const actual=await importOriginal<{default:typeof postgres}>();
  const factory=()=>{const query=(strings:TemplateStringsArray,...values:unknown[])=>{
    const call={query:strings.join('?'),values};transport.calls.push(call);return Promise.resolve().then(()=>transport.respond(call));
  };return Object.assign(query,{reserve:async()=>Object.assign(query,{release:()=>undefined}),end:async()=>undefined});};
  return {...actual,default:Object.assign(factory,{PostgresError:actual.default.PostgresError})};
});
const identity={backendIdentity:'unit',generation:'generation',ownerId:'owner',fencingToken:'fence'};
const payload={id:'original',command:'write',body:{payloadRef:{id:'fresh',size:'3',sha256:'a'.repeat(64)}},reservedBytes:'3'};
const pgError=(message:string,code='P0001')=>Reflect.construct(postgres.PostgresError,[{message,code,severity:'ERROR'}]) as unknown;
beforeEach(()=>{transport.calls=[];transport.respond=()=>[{value:{submitted:{id:'original',state:'QUEUED'},task:null}}];});
it.each(['operation_reused','capacity','backend_draining','invalid_input'])('attests the actual whole compound rollback %s, with separate invocation witnesses',async reason=>{
  const db=new Database('postgres://fixture.invalid/unit'),witness={},error=pgError(reason);
  transport.respond=()=>{throw error;};
  await expect(db.backendSubmitAndClaim('submit-once',identity,payload,witness)).rejects.toBe(error);
  expect(db.confirmsBackendSubmitClaimRollback(error,'submit-once',identity,payload,witness)).toBe(true);
  expect(db.confirmsBackendRollback(error,'submit-once',identity,payload,witness)).toBe(true);
  expect(db.confirmsBackendSubmitClaimRollback(error,'submit-once',identity,payload,{})).toBe(false);
  expect(db.confirmsBackendSubmitClaimRollback(error,'submit-once',{...identity,ownerId:'other'},payload,witness)).toBe(false);
  expect(transport.calls).toHaveLength(1);
  expect(transport.calls[0]?.query).toContain('WITH submitted AS MATERIALIZED');
  await db.close();
});
it('55P03 proves no compound commit but never grants fresh-payload deletion',async()=>{
  const db=new Database('postgres://fixture.invalid/unit'),witness={},error=pgError('lock unavailable','55P03');
  transport.respond=()=>{throw error;};
  await expect(db.backendSubmitAndClaim('submit-once',identity,payload,witness)).rejects.toBe(error);
  expect(db.confirmsBackendSubmitClaimRollback(error,'submit-once',identity,payload,witness)).toBe(true);
  expect(db.confirmsBackendRollback(error,'submit-once',identity,payload,witness)).toBe(false);
  await db.close();
});
it('probe errors, forged driver fields and disconnects cannot attest compound rollback',async()=>{
  for(const raw of [Object.assign(Error('invalid_input'),{code:'P0001',severity:'ERROR'}),pgError('connection lost','08006')]){
    const db=new Database('postgres://fixture.invalid/unit'),witness={};transport.respond=()=>{throw raw;};
    await expect(db.backendSubmitAndClaim('submit',identity,payload,witness)).rejects.toBe(raw);
    expect(db.confirmsBackendSubmitClaimRollback(raw,'submit',identity,payload,witness)).toBe(false);await db.close();
  }
  const db=new Database('postgres://fixture.invalid/unit',{maintenanceBarrier:true}),witness={},error=pgError('capacity');
  transport.respond=()=>{throw error;};
  await expect(db.backendSubmitAndClaim('submit',identity,payload,witness)).rejects.toBe(error);
  expect(db.confirmsBackendSubmitClaimRollback(error,'submit',identity,payload,witness)).toBe(false);
  expect(db.confirmsBackendRollback(error,'submit',identity,payload,witness)).toBe(false);await db.close();
});
it('atomic maintenance wraps both fixed functions in the same statement',async()=>{
  const db=new Database('postgres://fixture.invalid/unit',{maintenanceBarrier:true});
  transport.respond=call=>call.query.includes('to_regprocedure')?[{available:true}]:[{value:{submitted:{id:'original',state:'DONE',result:3},task:null}}];
  await expect(db.backendSubmitAndClaim('submit',identity,payload,{})).resolves.toMatchObject({submitted:{state:'DONE'},task:null});
  const actual=transport.calls.filter(x=>x.query.includes('WITH submitted'));
  expect(actual).toHaveLength(1);expect(actual[0]?.query.match(/public.sync_maintenance_command/g)).toHaveLength(2);
  await db.close();
});
