const migration=Number(process.env.SMALL_FILE_VERIFIED_WRITE_MIGRATION??98);
import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {expect,it,vi} from 'vitest';
import {backendFixture,databaseFixture,barrier,migrations,sha,uid} from './stage3-chat-a.fixture.js';
import {BackendPayloadStore} from '../../../packages/storage/src/backend-payload-store.js';
import {DurableBackendExecutor} from '../../../packages/storage/src/durable-backend-executor.js';

type VerifiedExecutor=DurableBackendExecutor&{writeVerifiedOnce(id:string,p:string,bytes:Buffer):Promise<{sizeBytes:string;sha256:string;prefix:Buffer}>};
function executor(f:Awaited<ReturnType<typeof backendFixture>>,send=f.command,check?:()=>Promise<void>){return new DurableBackendExecutor(f.raw,send,f.backendIdentity,f.generation,0,undefined,{workers:4,payloads:new BackendPayloadStore(path.join(f.directory,'verified-payloads'),f.backendIdentity,f.generation),...(check?{groupStorageCheck:check}:{})}) as VerifiedExecutor;}

const schema='saturn.backend-write-verified-once.v1';
const bytes=Buffer.from('physically verified bytes');
const ref=()=>({id:uid(),size:String(bytes.length),sha256:sha(bytes)});
const body=(payloadRef=ref(),verified=true)=>({schema:verified?schema:'saturn.backend-write-once.v1',path:'verified.bin',options:{offset:0,create:true,exclusive:true,truncate:false},payloadRef});
const receipt=()=>({schema:'saturn.backend-write-verified-result.v1',sizeBytes:String(bytes.length),sha256:sha(bytes),prefixBase64:bytes.toString('base64')});

it('seals a full small verified write and requires an exact bounded verification receipt',async()=>{
  const f=await backendFixture('smallfile-verified-write-sql',migration),identity=f.executor.identity,id=uid(),payload=body();
  try{
    expect(await f.command('acquire',identity,{})).toMatchObject({owned:true,writeVerifiedOnce:true});
    const submit=(b=payload)=>f.command('submit-once',identity,{id,command:'write',body:b,reservedBytes:b.payloadRef.size});
    expect(await submit()).toMatchObject({id,state:'QUEUED'});
    expect(await submit({...payload,payloadRef:{...payload.payloadRef,id:uid()}})).toMatchObject({id,state:'QUEUED'});
    expect(await f.command('claim',identity,{})).toMatchObject({id,body:payload});
    for(const result of [bytes.length,{...receipt(),sha256:sha('wrong')},{...receipt(),sizeBytes:'1'},{...receipt(),prefixBase64:'QQ=='},{...receipt(),extra:true}]){
      await expect(f.command('complete',identity,{id,result})).rejects.toThrow('projection_mismatch');
      expect(await f.command('status',identity,{id})).toMatchObject({state:'RUNNING'});
    }
    expect(await f.command('complete',identity,{id,result:receipt()})).toMatchObject({id,state:'DONE',result:receipt()});
    expect(await submit()).toMatchObject({id,state:'DONE',result:receipt()});
    expect(await submit({...payload,schema:'saturn.backend-write-once.v1'})).toMatchObject({id,state:'DONE',result:receipt()});
    for(const p of [{...payload,path:'other.bin'},{...payload,payloadRef:{...ref(),sha256:sha('else')}}])await expect(submit(p)).rejects.toThrow('operation_reused');
    expect(await f.command('inspect',identity,{})).toMatchObject({writtenBytes:String(bytes.length),completedEffects:'1'});
    expect(await f.admin.withSql(sql=>sql`SELECT payload FROM sync_backend_tasks WHERE id=${id}`)).toEqual([{payload}]);
    await f.command('drain',identity,{});await f.command('stopped',identity,{connectionsClosed:true});
    await expect(f.admin.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0098_backend_verified_write.down.sql'),'utf8')))).rejects.toThrow('verified write task history must be retained');
  }finally{await f.close();}
},60000);

it('keeps an older matching original unchanged when asked for verified completion',async()=>{
  const f=await backendFixture('smallfile-verified-write-old-original',migration),identity=f.executor.identity,id=uid(),payload=body(ref(),false);
  try{
    await f.command('acquire',identity,{});
    await f.command('submit-once',identity,{id,command:'write',body:payload,reservedBytes:payload.payloadRef.size});
    await f.command('claim',identity,{});await f.command('complete',identity,{id,result:bytes.length});
    expect(await f.command('submit-once',identity,{id,command:'write',body:{...payload,schema,payloadRef:{...payload.payloadRef,id:uid()}},reservedBytes:payload.payloadRef.size})).toMatchObject({id,state:'DONE',result:bytes.length});
    expect(await f.admin.withSql(sql=>sql`SELECT payload FROM sync_backend_tasks WHERE id=${id}`)).toEqual([{payload}]);
    await f.command('drain',identity,{});await f.command('stopped',identity,{connectionsClosed:true});
  }finally{await f.close();}
},60000);

it('rejects partial, oversized and non-exclusive verified writes without creating tasks',async()=>{
  const f=await backendFixture('smallfile-verified-write-invalid',migration),identity=f.executor.identity;
  try{
    await f.command('acquire',identity,{});const b=body();
    const invalid=[{...b,options:{...b.options,offset:1}},{...b,options:{...b.options,create:false}},{...b,options:{...b.options,exclusive:false}},{...b,options:{...b.options,truncate:true}},{...b,payloadRef:{...b.payloadRef,size:'0'}},{...b,payloadRef:{...b.payloadRef,size:'262145'}},{...b,schema:null},{...b,extra:true}];
    for(const value of invalid)await expect(f.command('submit-once',identity,{id:uid(),command:'write',body:value,reservedBytes:value.payloadRef.size})).rejects.toThrow('invalid_input');
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks`)).toHaveLength(0);
    await f.command('drain',identity,{});await f.command('stopped',identity,{connectionsClosed:true});
  }finally{await f.close();}
},60000);

it('restores the exact predecessor and refuses installation with an active backend',async()=>{
  const f=await databaseFixture('smallfile-verified-write-rollback',97);
  try{
    const read=()=>f.db.withSql(sql=>sql`SELECT pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure) AS definition`),before=await read();
    const up=await fs.readFile(path.join(migrations,'0098_backend_verified_write.up.sql'),'utf8'),down=await fs.readFile(path.join(migrations,'0098_backend_verified_write.down.sql'),'utf8');
    await f.db.transaction(async sql=>sql.unsafe(up));await f.db.transaction(async sql=>sql.unsafe(down));expect(await read()).toEqual(before);
    await f.db.withSql(sql=>sql`INSERT INTO sync_backend_executor(backend_identity,generation,writer_login,writer_owner,state) VALUES('active',${uid()},'postgres','postgres','RUNNING')`);
    await expect(f.db.transaction(async sql=>sql.unsafe(up))).rejects.toThrow('backend must be stopped before verified write migration');
    expect(await read()).toEqual(before);
  }finally{await f.close();}
},60000);

it('reads the physical file independently before DONE and rereads a terminal original instead of trusting its old proof',async()=>{
  const f=await backendFixture('smallfile-verified-write-physical',migration),e=executor(f),data=Buffer.alloc(8192,37),id=uid();
  const reads=vi.spyOn(f.raw,'openRead'),writes=vi.spyOn(f.raw,'write'),commands: string[]=[];
  const owner=executor(f,async(c,i,p)=>{commands.push(c);return f.command(c,i,p);});
  try{
    expect(await owner.writeVerifiedOnce(id,'fresh.bin',data)).toEqual({sizeBytes:String(data.length),sha256:sha(data),prefix:data.subarray(0,512)});
    expect(reads).toHaveBeenCalledTimes(1);expect(writes).toHaveBeenCalledTimes(1);expect(commands).not.toContain('read-acquire');
    const before=await f.admin.withSql(sql=>sql`SELECT id,payload,result FROM sync_backend_tasks WHERE id=${id}`);
    expect(await e.writeVerifiedOnce(id,'fresh.bin',data)).toMatchObject({sha256:sha(data)});expect(reads).toHaveBeenCalledTimes(2);expect(writes).toHaveBeenCalledTimes(1);
    await f.raw.write('fresh.bin',Readable.from(Buffer.alloc(data.length,38)),{offset:0,create:false});writes.mockClear();
    await expect(e.writeVerifiedOnce(id,'fresh.bin',data)).rejects.toMatchObject({code:'verification_failed'});expect(writes).not.toHaveBeenCalled();
    expect(await f.admin.withSql(sql=>sql`SELECT id,payload,result FROM sync_backend_tasks WHERE id=${id}`)).toEqual(before);
  }finally{vi.restoreAllMocks();await e.close();await owner.close();await f.close();}
},60000);

it('preserves old write originals and lets ordinary callers read a new verified receipt',async()=>{
  const f=await backendFixture('smallfile-verified-write-compat',migration),e=executor(f),options={offset:0,create:true,exclusive:true,truncate:false},old=uid(),fresh=uid(),writes=vi.spyOn(f.raw,'write');
  try{
    await e.writeOnce(old,'old.bin',bytes,options);const before=await f.admin.withSql(sql=>sql`SELECT payload FROM sync_backend_tasks WHERE id=${old}`);
    expect(await e.writeVerifiedOnce(old,'old.bin',bytes)).toMatchObject({sha256:sha(bytes)});
    expect(await f.admin.withSql(sql=>sql`SELECT payload FROM sync_backend_tasks WHERE id=${old}`)).toEqual(before);
    await e.writeVerifiedOnce(fresh,'new.bin',bytes);expect(await e.writeOnce(fresh,'new.bin',bytes,options)).toBe(bytes.length);
    expect(writes).toHaveBeenCalledTimes(2);
  }finally{vi.restoreAllMocks();await e.close();await f.close();}
},60000);

it('resolves lost queue and completion acknowledgements with the original task without another physical write',async()=>{
  const f=await backendFixture('smallfile-verified-write-acks',migration);let submit=0,complete=0;
  const e=executor(f,async(c,i,p)=>{const result=await f.command(c,i,p);if(c==='submit-once'&&submit++===0)throw Error('lost submit');if(c==='complete'&&complete++===0)throw Error('lost complete');return result;}),writes=vi.spyOn(f.raw,'write'),id=uid();
  try{
    expect(await e.writeVerifiedOnce(id,'once.bin',bytes)).toMatchObject({sha256:sha(bytes)});expect(writes).toHaveBeenCalledTimes(1);expect(complete).toBe(1);
    expect(await f.admin.withSql(sql=>sql`SELECT id,state FROM sync_backend_tasks`)).toEqual([{id,state:'DONE'}]);
  }finally{vi.restoreAllMocks();await e.close();await f.close();}
},60000);

it('retains UNKNOWN after physical corruption or a generation change following write',async()=>{
  for(const failure of ['corruption','generation']){
    const f=await backendFixture('smallfile-verified-write-'+failure,migration);let written=false;
    const e=executor(f,f.command,async()=>{if(written&&failure==='generation')throw Error('backend_generation_changed');}),other=executor(f),id=uid(),write=f.raw.write.bind(f.raw);
    const writes=vi.spyOn(f.raw,'write').mockImplementation(async(p,s,o)=>{const n=await write(p,s,o);written=true;if(failure==='corruption')await write(p,Readable.from(Buffer.alloc(bytes.length,99)),{offset:0,create:false});return n;});
    try{
      await expect(e.writeVerifiedOnce(id,'bad.bin',bytes)).rejects.toMatchObject({code:'reconciliation_required'});
      expect(await f.admin.withSql(sql=>sql`SELECT id,state FROM sync_backend_tasks`)).toEqual([{id,state:'UNKNOWN'}]);
      await expect(other.writeVerifiedOnce(id,'bad.bin',bytes)).rejects.toMatchObject({code:'reconciliation_required'});expect(writes).toHaveBeenCalledTimes(1);expect(await f.raw.exists('bad.bin')).toBe(true);
    }finally{vi.restoreAllMocks();await other.close();await expect(e.close()).rejects.toThrow('backend_close_unconfirmed');await f.close();}
  }
},60000);

it('holds the physical slot through readback and never runs more than four writes or reads',async()=>{
  const f=await backendFixture('smallfile-verified-write-slots',migration),e=executor(f),held=barrier(),gate=barrier();let active=0,peak=0;
  const open=f.raw.openRead.bind(f.raw);vi.spyOn(f.raw,'openRead').mockImplementation(async(...args)=>{active++;peak=Math.max(peak,active);if(active===4)held.release();await gate.entered;try{return await open(...args);}finally{active--;}});
  const work=Array.from({length:5},(_,n)=>e.writeVerifiedOnce(uid(),'slot-'+String(n)+'.bin',bytes));
  try{
    let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([held.entered,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Four slots not reached')),5000);})]);}finally{clearTimeout(timer);}
    const rows=await f.admin.withSql(sql=>sql`SELECT state,count(*)::int AS n FROM sync_backend_tasks GROUP BY state`);expect(rows).toContainEqual({state:'RUNNING',n:4});expect(rows).toContainEqual({state:'QUEUED',n:1});
    gate.release();await Promise.all(work);expect(peak).toBe(4);
  }finally{gate.release();await Promise.allSettled(work);vi.restoreAllMocks();await e.close();await f.close();}
},60000);

it('refuses unqualified old databases before writing a task or staging bytes',async()=>{
  const f=await backendFixture('smallfile-verified-write-old-db',97),e=executor(f),write=vi.spyOn(f.raw,'write');
  try{
    await expect(e.writeVerifiedOnce(uid(),'old.bin',bytes)).rejects.toMatchObject({code:'unsupported'});expect(write).not.toHaveBeenCalled();
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks`)).toHaveLength(0);
  }finally{vi.restoreAllMocks();await e.close();await f.close();}
},60000);

it('times out a stalled physical read, closes its stream and retains the written original as UNKNOWN',async()=>{
  const f=await backendFixture('smallfile-verified-write-stalled',migration),e=executor(f),stream=new Readable({read(){}}),opened=barrier(),id=uid();
  vi.spyOn(f.raw,'openRead').mockImplementation(async()=>{opened.release();return stream;});
  const work=e.writeVerifiedOnce(id,'stalled.bin',bytes),result=expect(work).rejects.toMatchObject({code:'reconciliation_required'});
  try{
    await opened.entered;await result;expect(stream.destroyed).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT id,state FROM sync_backend_tasks`)).toEqual([{id,state:'UNKNOWN'}]);expect(await f.raw.exists('stalled.bin')).toBe(true);
  }finally{stream.destroy();await Promise.allSettled([work]);vi.restoreAllMocks();await expect(e.close()).rejects.toThrow('backend_close_unconfirmed');await f.close();}
},45000);
