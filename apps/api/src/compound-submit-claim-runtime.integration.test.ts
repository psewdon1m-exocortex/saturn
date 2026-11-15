import {requireDefined} from "../../../packages/contracts/src/require-defined.js";
import {fixtureForwardMethod} from "./test-values.fixture.js";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect,it,vi } from "vitest";
import { BackendPayloadStore } from "../../../packages/storage/src/backend-payload-store.js";
import { createGuardedBackendCommand } from "../../../packages/sync/src/guarded-backend-command.js";
import { backendFixture,uid,evidence } from "./stage3-chat-a.fixture.js";

const qualified=it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE);
const options={offset:0,create:true,exclusive:true,truncate:false};
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){if(Date.now()>=end)throw Error("Actual runtime boundary not reached");await delay(3);}}
type Fixture=Awaited<ReturnType<typeof backendFixture>>;
async function finish(f:Fixture,id:string,details:Record<string,unknown>){
  await f.executor.close();
  const state=await f.writer.backendCommand("inspect",f.executor.identity,{});
  expect(state).toMatchObject({state:"STOPPED",queued:0,unknown:0,activeReads:0,waitingReads:0,oldestPendingAt:null});
  const counts=await f.admin.withSql(sql=>sql.unsafe("SELECT state,count(*)::int AS count FROM sync_backend_tasks WHERE backend_identity=$1 GROUP BY state ORDER BY state",[f.backendIdentity]));
  const migrations=await f.admin.withSql(sql=>sql.unsafe("SELECT count(*)::int AS count FROM _vault_migrations"));
  expect(migrations[0]?.count).toBe(117);
  await evidence(id,"result",{backendIdentity:f.backendIdentity,generation:f.generation,identity:f.executor.identity,state,counts,migrations,...details});
}

qualified("compound real PG returns a peer claim, waits for its ACK before I/O and replays the exact original",async()=>{
  const id="compound-peer-original",f=await backendFixture(id,126,undefined,createGuardedBackendCommand),peer=uid(),local=uid(),peerBytes=Buffer.from("genuine peer original"),bytes=Buffer.from("genuine local original");
  const store=new BackendPayloadStore(path.join(f.directory,"payloads"),f.backendIdentity,f.generation);
  const entered=gate(),ack=gate();let write:Promise<number>|undefined;
  const rawWrites=vi.spyOn(f.raw,"write"),actual=f.writer.backendSubmitAndClaim.bind(f.writer);
  let claimed:string|undefined,inserted=false,compoundCalls=0;
  try{
    const peerRef=await store.put(peerBytes);
    vi.spyOn(f.writer,"backendSubmitAndClaim").mockImplementation(async(kind,identity,payload,witness)=>{
      compoundCalls++;
      if(!inserted){
        inserted=true;
        await f.writer.backendCommand("submit-once",identity,{id:peer,command:"write",body:{schema:"saturn.backend-write-once.v1",path:"peer.bin",options,payloadRef:peerRef},reservedBytes:peerRef.size});
        const result=await actual(kind,identity,payload,witness) as {task:{id:string}|null};
        claimed=result.task?.id;entered.release();await ack.promise;return result;
      }
      return actual(kind,identity,payload,witness);
    });
    await f.executor.start();await delay(5);
    write=f.executor.writeOnce(local,"local.bin",bytes,options);await entered.promise;
    expect(claimed).toBe(peer);expect(rawWrites).not.toHaveBeenCalled();
    ack.release();expect(await write).toBe(bytes.length);
    expect(await f.executor.writeOnce(local,"local.bin",bytes,options)).toBe(bytes.length);
    expect(rawWrites).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(f.directory,"storage/peer.bin"))).toEqual(peerBytes);
    expect(await fs.readFile(path.join(f.directory,"storage/local.bin"))).toEqual(bytes);
    expect(await fs.readdir(store.directory)).toEqual([]);
    await finish(f,id,{peer,local,claimed,compoundCalls,physicalWrites:rawWrites.mock.calls.length,fullBytes:true,replayWithoutNewWrite:true});
  }finally{ack.release();await Promise.allSettled([write]);await f.close();vi.restoreAllMocks();}
},60000);

qualified("compound real PG preserves one observer and four physical workers across twelve originals",async()=>{
  const id="compound-physical-cap",f=await backendFixture(id,126,undefined,createGuardedBackendCommand),release=gate();
  const actualWrite=f.raw.write.bind(f.raw),actualCompound=f.writer.backendSubmitAndClaim.bind(f.writer);
  let active=0,peak=0,entered=0,inFlight=0,observerPeak=0,compoundCalls=0;
  const ids=Array.from({length:12},()=>uid()),bytes=ids.map((_,n)=>Buffer.from("original-"+String(n)));
  let writes:Promise<number>[]=[];
  try{
    vi.spyOn(f.raw,"write").mockImplementation(async(...args)=>{active++;entered++;peak=Math.max(peak,active);try{await release.promise;return await actualWrite(...args);}finally{active--;}});
    vi.spyOn(f.writer,"backendSubmitAndClaim").mockImplementation(async(...args)=>{compoundCalls++;inFlight++;observerPeak=Math.max(observerPeak,inFlight);try{return await actualCompound(...args);}finally{inFlight--;}});
    await f.executor.start();await delay(5);
    writes=ids.map((original,n)=>f.executor.writeOnce(original,String(n)+".bin",requireDefined(bytes[n]),options));
    await until(()=>entered===4);expect(peak).toBe(4);expect(entered).toBe(4);
    const held=await f.admin.withSql(sql=>sql.unsafe("SELECT state,count(*)::int AS count FROM sync_backend_tasks WHERE backend_identity=$1 GROUP BY state ORDER BY state",[f.backendIdentity]));
    expect(held.find(x=>x.state==="RUNNING")?.count).toBe(4);
    release.release();expect(await Promise.all(writes)).toEqual(bytes.map(x=>x.length));
    for(let n=0;n<ids.length;n++)expect(await fs.readFile(path.join(f.directory,"storage",String(n)+".bin"))).toEqual(bytes[n]);
    expect(peak).toBe(4);expect(observerPeak).toBe(1);expect(compoundCalls).toBeGreaterThan(0);
    await finish(f,id,{ids,physicalPeak:peak,observerPeak,compoundCalls,physicalWrites:entered,held,fullBytes:true});
  }finally{release.release();await Promise.allSettled(writes);await f.close();vi.restoreAllMocks();}
},60000);

qualified("compound real PG capacity rollback seals its nonce, cleans only the fresh ref and leaves the owner usable",async()=>{
  const id="compound-capacity-rollback",f=await backendFixture(id,126,undefined,createGuardedBackendCommand),rawWrites=vi.spyOn(f.raw,"write");
  const actual=f.writer.backendSubmitAndClaim.bind(f.writer);let attested=false,wrongWitness=false,cleanup=false;
  try{
    await f.admin.withSql(sql=>sql.unsafe("UPDATE sync_backend_executor SET maximum_reserved_bytes=2 WHERE backend_identity=$1",[f.backendIdentity]));
    vi.spyOn(f.writer,"backendSubmitAndClaim").mockImplementation(async(kind,identity,payload,witness)=>{
      try{return await actual(kind,identity,payload,witness);}
      catch(error){
        if((error as {code?:string}).code==="P0001"&&witness){
          attested=f.writer.confirmsBackendSubmitClaimRollback(error,kind,identity,payload,witness);
          wrongWitness=f.writer.confirmsBackendSubmitClaimRollback(error,kind,identity,payload,{});
          cleanup=f.writer.confirmsBackendRollback(error,kind,identity,payload,witness);
        }
        throw error;
      }
    });
    await f.executor.start();await delay(5);
    await expect(f.executor.writeOnce(uid(),"refused.bin",Buffer.from("too large"),options)).rejects.toMatchObject({code:"capacity"});
    expect(attested).toBe(true);expect(wrongWitness).toBe(false);expect(cleanup).toBe(true);
    expect(rawWrites).not.toHaveBeenCalled();
    expect(await fs.readdir(new BackendPayloadStore(path.join(f.directory,"payloads"),f.backendIdentity,f.generation).directory)).toEqual([]);
    expect(await f.executor.writeOnce(uid(),"accepted.bin",Buffer.from("x"),options)).toBe(1);
    expect(rawWrites).toHaveBeenCalledTimes(1);
    await finish(f,id,{attested,wrongWitness,cleanup,refusedBeforePhysical:true,acceptedBytes:true});
  }finally{await f.close();vi.restoreAllMocks();}
},60000);

qualified("compound real PG lock timeout proves no commit without payload cleanup and falls back to one ordinary original",async()=>{
  const id="compound-lock-rollback",f=await backendFixture(id,126,undefined,createGuardedBackendCommand),initial=gate(),firstReply=gate(),staged=gate(),releaseLock=gate(),locked=gate();
  const actualOrdinary=f.writer.backendCommand.bind(f.writer),actualCompound=f.writer.backendSubmitAndClaim.bind(f.writer);
  const store=new BackendPayloadStore(path.join(f.directory,"payloads"),f.backendIdentity,f.generation);
  let first=true,lock:Promise<unknown>|undefined,write:Promise<number>|undefined,compoundCalls=0,ordinarySubmits=0;
  let noCommit=false,cleanup=true,retained=false,exactPayload:unknown,exactIdentity:unknown;
  const original=uid(),bytes=Buffer.from("retained through actual lock timeout");
  try{
    vi.spyOn(f.writer,"backendCommand").mockImplementation(async(kind,identity,payload,witness)=>{
      if(kind==="submit-once"){ordinarySubmits++;expect(payload).toBe(exactPayload);expect(identity).toBe(exactIdentity);}
      const result=await actualOrdinary(kind,identity,payload,witness);
      if(kind==="claim"&&first){first=false;initial.release();await firstReply.promise;}
      return result;
    });
    vi.spyOn(f.writer,"backendSubmitAndClaim").mockImplementation(async(kind,identity,payload,witness)=>{
      compoundCalls++;exactPayload=payload;exactIdentity=identity;
      try{return await actualCompound(kind,identity,payload,witness);}
      catch(error){
        expect(error).toMatchObject({code:"55P03"});if(!witness)throw Error("Missing private invocation witness");
        noCommit=f.writer.confirmsBackendSubmitClaimRollback(error,kind,identity,payload,witness);
        cleanup=f.writer.confirmsBackendRollback(error,kind,identity,payload,witness);
        const reference=(payload as {body:{payloadRef:{id:string;size:string;sha256:string}}}).body.payloadRef;
        retained=(await store.read(reference)).equals(bytes);releaseLock.release();throw error;
      }
    });
    await f.executor.start();await initial.promise;
    lock=f.admin.transaction(async sql=>{await sql.unsafe("SELECT backend_identity FROM sync_backend_executor WHERE backend_identity=$1 FOR UPDATE",[f.backendIdentity]);locked.release();await releaseLock.promise;});
    await locked.promise;
    const actualPut=fixtureForwardMethod(BackendPayloadStore.prototype,"put");
    vi.spyOn(BackendPayloadStore.prototype,"put").mockImplementation(async function(this:BackendPayloadStore,value:Buffer){const result=await actualPut.call(this,value);staged.release();return result;});
    write=f.executor.writeOnce(original,"fallback.bin",bytes,options);await staged.promise;await delay(2);firstReply.release();
    expect(await write).toBe(bytes.length);await lock;
    expect(noCommit).toBe(true);expect(cleanup).toBe(false);expect(retained).toBe(true);
    expect(compoundCalls).toBe(1);expect(ordinarySubmits).toBe(1);
    expect(await fs.readFile(path.join(f.directory,"storage/fallback.bin"))).toEqual(bytes);
    await finish(f,id,{original,noCommit,cleanup,retained,compoundCalls,ordinarySubmits,actualError:"55P03",fullBytes:true,phaseReplyDelay:"Initial successful empty claim reply is held after commit only to select the compound lock phase; no failed response is mocked"});
  }finally{firstReply.release();releaseLock.release();await Promise.allSettled([lock,write]);await f.close();vi.restoreAllMocks();}
},60000);

qualified("compound real PG retains both originals after the committed peer claim reply is lost", async () => {
  const id = "compound-peer-ack-lost", f = await backendFixture(id,128,undefined,createGuardedBackendCommand);
  const peer = uid(), local = uid(), peerBytes = Buffer.from("retained peer original"), localBytes = Buffer.from("retained local original");
  const store = new BackendPayloadStore(path.join(f.directory,"payloads"), f.backendIdentity, f.generation);
  const actual = f.writer.backendSubmitAndClaim.bind(f.writer), ordinary = f.writer.backendCommand.bind(f.writer);
  const physical = vi.spyOn(f.raw,"write");
  let calls=0, localOrdinary=0, claimed:string|undefined;
  let localRef:{id:string;size:string;sha256:string}|undefined;
  try {
    const peerRef = await store.put(peerBytes);
    vi.spyOn(f.writer,"backendCommand").mockImplementation(async (kind,identity,payload,witness)=>{
      if (kind==="submit-once" && (payload as {id?:string}).id===local) localOrdinary++;
      return ordinary(kind,identity,payload,witness);
    });
    vi.spyOn(f.writer,"backendSubmitAndClaim").mockImplementation(async (kind,identity,payload,witness)=>{
      calls++;
      if(calls!==1) throw Error("unexpected_retry");
      localRef=(payload as {body:{payloadRef:{id:string;size:string;sha256:string}}}).body.payloadRef;
      await ordinary("submit-once",identity,{id:peer,command:"write",body:{schema:"saturn.backend-write-once.v1",path:"retained-peer.bin",options,payloadRef:peerRef},reservedBytes:peerRef.size});
      const committed=await actual(kind,identity,payload,witness) as {submitted:{id:string;state:string};task:{id:string}|null};
      expect(committed.submitted).toMatchObject({id:local,state:"QUEUED"});
      claimed=committed.task?.id;
      expect(claimed).toBe(peer);
      // The real SQL statement has committed. Withhold this reply at the caller.
      throw Error("injected_lost_compound_reply");
    });
    await f.executor.start();
    await delay(5);
    await expect(f.executor.writeOnce(local,"retained-local.bin",localBytes,options)).rejects.toMatchObject({code:"injected_lost_compound_reply"});
    const readRows = () => f.admin.withSql(sql=>sql.unsafe<{id:string;state:string;payload:unknown}[]>(
      "SELECT id,state,payload FROM public.sync_backend_tasks WHERE backend_identity=$1 ORDER BY id",[f.backendIdentity]));
    const before=await readRows();
    expect(before.map(({id,state})=>({id,state}))).toEqual([{id:peer,state:"RUNNING"},{id:local,state:"QUEUED"}].sort((a,b)=>a.id.localeCompare(b.id)));
    expect(await store.read(peerRef)).toEqual(peerBytes);
    if(!localRef)throw Error("compound did not expose its actual payload reference");
    expect(await store.read(localRef)).toEqual(localBytes);
    expect(physical).not.toHaveBeenCalled();
    expect(calls).toBe(1);
    expect(localOrdinary).toBe(0);
    await expect(f.executor.close()).rejects.toMatchObject({message:"backend_close_unconfirmed"});
    const terminal=await ordinary("inspect",f.executor.identity,{});
    expect(terminal).toMatchObject({state:"DRAINING",queued:1,unknown:0,activeReads:0,waitingReads:0});
    expect(await readRows()).toEqual(before);
    expect(await store.read(peerRef)).toEqual(peerBytes);
    expect(await store.read(localRef)).toEqual(localBytes);
    await evidence(id,"result",{peer,local,claimed,calls,localOrdinary,physicalWrites:physical.mock.calls.length,
      states:before.map(({id,state})=>({id,state})),payloadHashes:[peerRef.sha256,localRef.sha256],terminal,
      committedReplyWithheld:true,payloadsPreserved:true,stoppedReceipt:false});
  } finally {
    await f.executor.close().catch(()=>undefined);
    await Promise.all([f.writer.close(),f.runtime.close(),f.admin.close()]);
    vi.restoreAllMocks();
  }
},60000);
