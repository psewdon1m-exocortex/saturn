// @vitest-environment node
import { requiredValue } from "./test-value.js";
import {createHash,randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {planUploadTree,plannedJobSources} from "./upload-tree-plan.js";
import {prepareUploadTreeJob} from "./upload-tree-batch.js";
import {runSmallUploadTree,runUploadTree,type UploadTreeQueueState} from "./upload-tree-queue.js";
import {UploadTreeStreamSource,type PreparedUploadTreeStreamJob} from "./upload-tree-stream.js";
import type {UploadTreeStreamTransport} from "./upload-tree-stream-transport.js";
import type {DurableTreeJob} from "./upload-tree-durable.js";
import type {UploadTreeAdvance} from "./upload-tree-transport.js";

const wait=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
async function fixture(count=48){
 const input=Array.from({length:count},(_,i)=>({kind:"directory" as const,itemId:randomUUID(),relativePath:"folder-"+String(i),name:"folder-"+String(i)}));
 const {plan,sources}=await planUploadTree(randomUUID(),input),scope:{kind:"owner";rootId:string}={kind:"owner",rootId:randomUUID()};
 const rows=new Map<string,DurableTreeJob>(plan.jobs.map(job=>[job.jobId,{key:plan.treeId+":"+job.jobId,treeId:plan.treeId,jobId:job.jobId,scope,job,items:plan.items.filter(i=>job.itemIds.includes(i.itemId)),phase:"planned",createdAt:1,updatedAt:1} satisfies DurableTreeJob]));
 const get=(id:string)=>requiredValue(rows.get(id)),set=(id:string,row:DurableTreeJob)=>{rows.set(id,row);return row;};
 // Protocol-only store fixture. Native IDB admission limits have their own probe.
 const store={loadPlan:vi.fn(async()=>({scope,plan})),loadJob:vi.fn(async(_tree:string,id:string)=>get(id)),reserveJob:vi.fn(async(_tree:string,id:string)=>set(id,{...get(id),phase:"preparing"})),savePrepared:vi.fn(async(_tree:string,id:string,prepared:Awaited<ReturnType<typeof prepareUploadTreeJob>>)=>set(id,{...get(id),phase:"ready",encoded:prepared.encoded,fingerprints:prepared.fingerprints}))};
 const done=(id:string):UploadTreeAdvance=>{const row=get(id),record=set(id,{...row,phase:"completed",status:{treeId:plan.treeId,jobId:id,intentSha256:"0".repeat(64),state:"completed",items:row.items.map(item=>({itemId:item.itemId,parentItemId:item.parentItemId,relativePath:item.relativePath,kind:item.kind,state:"published",receipt:{fixture:true}}))}});return {record,outcome:"completed"};};
 const transport={advance:vi.fn(async(_tree:string,id:string)=>done(id))};
 const prepare=vi.fn(prepareUploadTreeJob);
 return {plan,sources,store,transport,prepare,done,get,set};
}
describe("bounded persisted small-tree DAG queue",()=>{
 it("opens at most two lanes and reports completed items only after durable outcomes",async()=>{
  const f=await fixture(),gates=f.plan.jobs.map(()=>wait()),states:UploadTreeQueueState[]=[];
  f.transport.advance.mockImplementation(async(_tree,id)=>{await requiredValue(gates[f.plan.jobs.findIndex(job=>job.jobId===id)]).promise;return f.done(id);});
  const run=runSmallUploadTree(f.plan.treeId,f.sources,{...f,onState:state=>states.push(state)});
  await vi.waitFor(()=>expect(f.transport.advance).toHaveBeenCalledTimes(2));expect(f.prepare).toHaveBeenCalledTimes(2);expect(requiredValue(states.at(-1)).completedDirectories).toBe(0);
  requiredValue(gates[0]).release();await vi.waitFor(()=>expect(f.transport.advance).toHaveBeenCalledTimes(3));expect(requiredValue(states.at(-1)).completedDirectories).toBe(16);
  requiredValue(gates[1]).release();requiredValue(gates[2]).release();expect(await run).toMatchObject({activeJobs:0,completedJobs:3,completedDirectories:48});expect(Math.max(...states.map(s=>s.activeJobs))).toBe(2);
 });
 it("waits for the parent's confirmed job before preparing any descendants",async()=>{
  const f=await fixture(32),parent=requiredValue(f.plan.items[0]),child=requiredValue(f.plan.items[16]);
  const items=f.plan.items.map(item=>item===child?{...item,parentItemId:parent.itemId,relativePath:parent.relativePath+"/"+child.name}:item);
  const plan={...f.plan,items,jobs:f.plan.jobs.map((job,index)=>index?{...job,dependencies:[requiredValue(f.plan.jobs[0]).jobId]}:job)};
  f.store.loadPlan.mockResolvedValueOnce({scope:f.get(requiredValue(plan.jobs[0]).jobId).scope as {kind:"owner";rootId:string},plan});
  const gate=wait();f.transport.advance.mockImplementationOnce(async(_tree,id)=>{await gate.promise;return f.done(id);});
  const run=runSmallUploadTree(plan.treeId,f.sources,f);await vi.waitFor(()=>expect(f.transport.advance).toHaveBeenCalledOnce());expect(f.prepare).toHaveBeenCalledOnce();gate.release();expect((await run).completedJobs).toBe(2);
 });
 it("does not return or schedule the third job until aborted in-flight callbacks actually settle",async()=>{
  const f=await fixture(),abort=new AbortController(),gate=wait();let settled=false;
  f.transport.advance.mockImplementation(async(_tree,id)=>{await gate.promise;return f.done(id);});
  const run=runSmallUploadTree(f.plan.treeId,f.sources,{...f,signal:abort.signal}).catch((error: unknown) =>error).finally(()=>{settled=true;});
  await vi.waitFor(()=>expect(f.transport.advance).toHaveBeenCalledTimes(2));abort.abort(Error("cancel gesture"));await new Promise(resolve=>setTimeout(resolve,10));expect(settled).toBe(false);expect(f.prepare).toHaveBeenCalledTimes(2);
  gate.release();expect(await run).toMatchObject({message:"cancel gesture"});expect(f.transport.advance).toHaveBeenCalledTimes(2);
 });
 it("joins another lane after a failure and retains its published outcome",async()=>{
  const f=await fixture(),gate=wait();let settled=false;
  f.transport.advance.mockImplementationOnce(async()=>{throw Error("lost response");}).mockImplementationOnce(async(_tree,id)=>{await gate.promise;return f.done(id);});
  // Let both preparations finish before the first response is rejected.
  const entered=wait();let n=0;f.prepare.mockImplementation(async(...args)=>{const result=await prepareUploadTreeJob(...args);if(++n===2)entered.release();await entered.promise;return result;});
  const run=runSmallUploadTree(f.plan.treeId,f.sources,f).catch((error: unknown) =>error).finally(()=>{settled=true;});
  await vi.waitFor(()=>expect(f.transport.advance).toHaveBeenCalledTimes(2));expect(settled).toBe(false);gate.release();expect(await run).toMatchObject({message:"lost response"});expect(f.get(requiredValue(f.plan.jobs[1]).jobId).phase).toBe("completed");expect(f.prepare).toHaveBeenCalledTimes(2);
 });
 it("restores an ambiguous later original before reading any new source body",async()=>{
  const f=await fixture(),id=requiredValue(f.plan.jobs[1]).jobId,gate=wait();f.set(id,{...f.get(id),phase:"unknown",encoded:"retained"});
  f.transport.advance.mockImplementationOnce(async(_tree,job)=>{expect(job).toBe(id);await gate.promise;return f.done(id);});
  const run=runSmallUploadTree(f.plan.treeId,new Map(),f);await vi.waitFor(()=>expect(f.transport.advance).toHaveBeenCalledOnce());expect(f.prepare).not.toHaveBeenCalled();gate.release();expect((await run).completedDirectories).toBe(48);expect(f.prepare).toHaveBeenCalledTimes(2);
 });
 it("stops on unresolved materialization without preparing later jobs or deleting originals",async()=>{
  const f=await fixture(),id=requiredValue(f.plan.jobs[0]).jobId;f.set(id,{...f.get(id),phase:"unknown",encoded:"retained"});f.transport.advance.mockResolvedValueOnce({record:f.get(id),outcome:"reconciliation_required"});
  await expect(runSmallUploadTree(f.plan.treeId,f.sources,f)).rejects.toThrow("reconciliation");expect(f.prepare).not.toHaveBeenCalled();expect(f.get(id).encoded).toBe("retained");
 });
 it("refuses mixed streaming trees before ANY preparation or HTTP effect",async()=>{
  const f=await fixture(),file=new File([new Uint8Array(262145)],"large",{lastModified:1});
  const {plan}=await planUploadTree(randomUUID(),[{kind:"file",itemId:randomUUID(),relativePath:"large",name:"large",getFile:async()=>file}]);
  f.store.loadPlan.mockResolvedValueOnce({scope:{kind:"owner",rootId:randomUUID()},plan});
  await expect(runSmallUploadTree(plan.treeId,new Map(),f)).rejects.toThrow("streaming");expect(f.store.reserveJob).not.toHaveBeenCalled();expect(f.transport.advance).not.toHaveBeenCalled();
 });
 it("does not reopen prepared bytes after restart when File handles are absent",async()=>{
  const f=await fixture(1),job=requiredValue(f.plan.jobs[0]);f.set(job.jobId,{...f.get(job.jobId),phase:"ready",encoded:"already durable"});
  expect((await runSmallUploadTree(f.plan.treeId,new Map(),f)).completedDirectories).toBe(1);expect(f.prepare).not.toHaveBeenCalled();expect(f.store.reserveJob).not.toHaveBeenCalled();
 });
 it("keeps file hashing inside a granted slot and never reads absent new sources",async()=>{
  const f=await fixture(1),file=new File(["payload"],"file",{lastModified:1}),{plan,sources}=await planUploadTree(randomUUID(),[{kind:"file",itemId:randomUUID(),relativePath:"file",name:"file",getFile:async()=>file}]);
  const old=f.get(requiredValue(f.plan.jobs[0]).jobId),job=requiredValue(plan.jobs[0]);f.set(job.jobId,{...old,key:plan.treeId+":"+job.jobId,treeId:plan.treeId,jobId:job.jobId,job,items:plan.items});f.store.loadPlan.mockResolvedValue({scope:old.scope as {kind:"owner";rootId:string},plan});
  await expect(runSmallUploadTree(plan.treeId,new Map(),f)).rejects.toThrow("source is unavailable");expect(f.store.reserveJob).not.toHaveBeenCalled();
  f.prepare.mockImplementation(async(...args)=>{expect(f.store.reserveJob).toHaveBeenCalledOnce();return prepareUploadTreeJob(args[0],args[1],{...args[2],hasher:{hash:async blob=>createHash("sha256").update(new Uint8Array(await blob.arrayBuffer())).digest("hex")}});});
  expect((await runSmallUploadTree(plan.treeId,sources,f)).completedFiles).toBe(1);
 });
});

async function mixedFixture(length=262145,extraStream=false){
 const root=randomUUID(),file=new File([new Uint8Array(length).fill(93)],"large",{lastModified:2});
 const {plan,sources}=await planUploadTree(randomUUID(),[
  {kind:"directory",itemId:root,relativePath:"root",name:"root"},
  {kind:"directory",itemId:randomUUID(),parentItemId:root,relativePath:"root/empty",name:"empty"},
  {kind:"file",itemId:randomUUID(),parentItemId:root,relativePath:"root/large",name:"large",getFile:async()=>file},
  ...(extraStream?[{kind:"file" as const,itemId:randomUUID(),parentItemId:root,relativePath:"root/second",name:"second",getFile:async()=>new File([new Uint8Array(length)],"second",{lastModified:2})}]:[]),
 ]),scope:{kind:"owner";rootId:string}={kind:"owner",rootId:randomUUID()};
 const rows=new Map<string,DurableTreeJob>(plan.jobs.map(job=>[job.jobId,{key:plan.treeId+":"+job.jobId,treeId:plan.treeId,jobId:job.jobId,scope,job,items:plan.items.filter(i=>job.itemIds.includes(i.itemId)),phase:"planned",createdAt:1,updatedAt:1}]));
 const get=(id:string)=>requiredValue(rows.get(id)),set=(id:string,row:DurableTreeJob)=>{rows.set(id,row);return row;},large=requiredValue(plan.jobs.find(job=>job.kind==="stream"));
 const store={loadPlan:vi.fn(async()=>({scope,plan})),loadJob:vi.fn(async(_tree:string,id:string)=>get(id)),reserveJob:vi.fn(async(_tree:string,id:string)=>set(id,{...get(id),phase:"preparing"})),
  savePrepared:vi.fn(async(_tree:string,id:string,value:Awaited<ReturnType<typeof prepareUploadTreeJob>>)=>set(id,{...get(id),phase:"ready",encoded:value.encoded,fingerprints:value.fingerprints})),
  savePreparedStream:vi.fn(async(_tree:string,id:string,value:PreparedUploadTreeStreamJob)=>set(id,{...get(id),phase:"ready",encoded:value.encoded,fingerprints:value.fingerprints})),
 };
 const done=(id:string):UploadTreeAdvance=>{const row=get(id),record=set(id,{...row,phase:"completed",status:{treeId:plan.treeId,jobId:id,intentSha256:"0".repeat(64),state:"completed",items:row.items.map(item=>({itemId:item.itemId,parentItemId:item.parentItemId,relativePath:item.relativePath,kind:item.kind,state:"published",receipt:{fixture:true}}))}});return {record,outcome:"completed"};};
 const hasher={hash:async(blob:Blob)=>createHash("sha256").update(new Uint8Array(await blob.arrayBuffer())).digest("hex")};
 const prepareStream=vi.fn(async(...args:Parameters<typeof UploadTreeStreamSource.prepare>)=>UploadTreeStreamSource.prepare(args[0],args[1],{...args[2],hasher}));
 const reselectStream=vi.fn(async(...args:Parameters<typeof UploadTreeStreamSource.reselect>)=>UploadTreeStreamSource.reselect(args[0],args[1],{...args[2],hasher}));
 const streamTransport={advance:vi.fn<UploadTreeStreamTransport["advance"]>(async(_tree,id)=>done(id))};
 const streamCapability=vi.fn(async()=>({schema:"saturn.browser-tree-stream-capability.v1",available:true,limits:{metadataBytes:65536,chunkBytes:4194304,maximumFileBytes:8388608,activeClientJobs:2}}));
 return {plan,sources,large,store,get,set,done,prepareStream,reselectStream,streamTransport,streamCapability,transport:{advance:vi.fn(async(_tree:string,id:string)=>done(id))}};
}
describe("mixed tree queue with saved streaming originals",()=>{
 it("polls the same pending background original with bounded backoff and counts publication once",async()=>{
  const f=await mixedFixture(),states:UploadTreeQueueState[]=[],waitForStreamPoll=vi.fn(async()=>undefined);let polls=0;
  f.streamTransport.advance.mockImplementation(async(_tree,id)=>++polls<7?{record:f.set(id,{...f.get(id),phase:"accepted"}),outcome:"pending"}:f.done(id));
  const result=await runUploadTree(f.plan.treeId,f.sources,{...f,waitForStreamPoll,onState:s=>states.push(s)});
  expect(result.completedFiles).toBe(1);expect(f.prepareStream).toHaveBeenCalledOnce();expect(f.reselectStream).not.toHaveBeenCalled();expect(f.store.savePreparedStream).toHaveBeenCalledOnce();
  expect(waitForStreamPoll.mock.calls.map(call=>(call as unknown as [number])[0])).toEqual([250,500,1000,2000,2000,2000]);
  expect(new Set(f.streamTransport.advance.mock.calls.map(call=>call[1]))).toEqual(new Set([f.large.jobId]));expect(states.filter(s=>s.completedFiles===0).every(s=>s.completedJobs<f.plan.jobs.length)).toBe(true);
 });
 it("an abort during the real poll wait issues no further request and retains accepted state",async()=>{
  const f=await mixedFixture(),controller=new AbortController();for(const job of f.plan.jobs.filter(job=>job.kind==="small"))f.done(job.jobId);
  f.streamTransport.advance.mockImplementationOnce(async(_tree,id)=>({record:f.set(id,{...f.get(id),phase:"accepted"}),outcome:"pending"}));
  const run=runUploadTree(f.plan.treeId,f.sources,{...f,signal:controller.signal}).catch((error: unknown) =>error);await vi.waitFor(()=>expect(f.streamTransport.advance).toHaveBeenCalledOnce());controller.abort(Error("pause polling"));
  expect(await run).toMatchObject({message:"pause polling"});expect(f.streamTransport.advance).toHaveBeenCalledOnce();expect(f.get(f.large.jobId).phase).toBe("accepted");
 });
 it("UNKNOWN stops polling without discarding its original or manufacturing a receipt",async()=>{
  const f=await mixedFixture(),waitForStreamPoll=vi.fn(async()=>undefined);
  f.streamTransport.advance.mockImplementationOnce(async(_tree,id)=>({record:f.set(id,{...f.get(id),phase:"accepted"}),outcome:"pending"}));
  f.streamTransport.advance.mockImplementationOnce(async(_tree,id)=>({record:f.set(id,{...f.get(id),phase:"unknown"}),outcome:"reconciliation_required"}));
  await expect(runUploadTree(f.plan.treeId,f.sources,{...f,waitForStreamPoll})).rejects.toThrow("requires reconciliation");expect(waitForStreamPoll).toHaveBeenCalledOnce();expect(f.get(f.large.jobId).phase).toBe("unknown");expect(f.prepareStream).toHaveBeenCalledOnce();
 });
 it("refuses unavailable capability or a lower file limit before sending even small parents",async()=>{
  const f=await mixedFixture(262146),cap=await f.streamCapability();f.streamCapability.mockResolvedValueOnce({...cap,available:false});await expect(runUploadTree(f.plan.treeId,f.sources,f)).rejects.toThrow("unavailable");
  f.streamCapability.mockResolvedValueOnce({...cap,limits:{...cap.limits,maximumFileBytes:262145}});await expect(runUploadTree(f.plan.treeId,f.sources,f)).rejects.toThrow("current file limit");
  expect(f.store.reserveJob).not.toHaveBeenCalled();expect(f.transport.advance).not.toHaveBeenCalled();expect(f.prepareStream).not.toHaveBeenCalled();
 });
 it("waits for parent publication and a strict stream save, counting received bytes only after final receipt",async()=>{
  const f=await mixedFixture(),parent=wait(),transfer=wait(),states:UploadTreeQueueState[]=[];
  f.transport.advance.mockImplementationOnce(async(_tree,id)=>{await parent.promise;return f.done(id);});
  f.streamTransport.advance.mockImplementationOnce(async(_tree,id,options)=>{expect(f.store.savePreparedStream).toHaveBeenCalledOnce();expect(options?.source?.prepared.encoded).toBe(f.get(id).encoded);options?.onProgress?.(262145,262145);await transfer.promise;return f.done(id);});
  const run=runUploadTree(f.plan.treeId,f.sources,{...f,onState:state=>states.push(state)});await vi.waitFor(()=>expect(f.transport.advance).toHaveBeenCalledOnce());expect(f.prepareStream).not.toHaveBeenCalled();parent.release();
  await vi.waitFor(()=>expect(f.streamTransport.advance).toHaveBeenCalledOnce());expect(requiredValue(states.at(-1)).completedFiles).toBe(0);expect(states.some(state=>state.activeStreamBytes?.[0]?.confirmedBytes===262145)).toBe(true);
  transfer.release();expect(await run).toMatchObject({completedFiles:1,completedDirectories:2,completedJobs:f.plan.jobs.length,activeJobs:0});expect(Math.max(...states.map(s=>s.activeJobs))).toBeLessThanOrEqual(2);expect(f.reselectStream).not.toHaveBeenCalled();
 });
 it("inspects a restored stream before reading its available File and reselects only when requested",async()=>{
  const f=await mixedFixture();for(const job of f.plan.jobs.filter(job=>job.kind==="small"))f.done(job.jobId);
  const row=f.get(f.large.jobId),source=await f.prepareStream(f.large.jobId,plannedJobSources(f.plan,f.large.jobId,f.sources));
  f.set(row.jobId,{...row,phase:"unknown",encoded:source.prepared.encoded,fingerprints:source.prepared.fingerprints});f.prepareStream.mockClear();
  f.streamTransport.advance.mockImplementationOnce(async(_tree,id,options)=>{expect(options?.source).toBeUndefined();expect(f.reselectStream).not.toHaveBeenCalled();return {record:f.get(id),outcome:"source_required"};});
  expect((await runUploadTree(f.plan.treeId,f.sources,f)).completedFiles).toBe(1);expect(f.streamTransport.advance).toHaveBeenCalledTimes(2);expect(f.reselectStream).toHaveBeenCalledOnce();expect(f.prepareStream).not.toHaveBeenCalled();expect(f.streamCapability).not.toHaveBeenCalled();expect(f.store.reserveJob).not.toHaveBeenCalled();
 });
 it("inspects and finishes retained sent originals without capability or File handles",async()=>{
  const f=await mixedFixture();for(const job of f.plan.jobs.filter(job=>job.kind==="small"))f.done(job.jobId);f.set(f.large.jobId,{...f.get(f.large.jobId),phase:"unknown"});
  expect((await runUploadTree(f.plan.treeId,new Map(),f)).completedFiles).toBe(1);expect(f.streamCapability).not.toHaveBeenCalled();expect(f.prepareStream).not.toHaveBeenCalled();expect(f.reselectStream).not.toHaveBeenCalled();
 });
 it("recovers a sent original before a disabled capability blocks the remaining new streams",async()=>{
  const f=await mixedFixture(262145,true);for(const job of f.plan.jobs.filter(job=>job.kind==="small"))f.done(job.jobId);f.set(f.large.jobId,{...f.get(f.large.jobId),phase:"unknown"});
  const cap=await f.streamCapability();f.streamCapability.mockClear();f.streamCapability.mockImplementationOnce(async()=>{expect(f.get(f.large.jobId).phase).toBe("completed");return {...cap,available:false};});
  await expect(runUploadTree(f.plan.treeId,f.sources,f)).rejects.toThrow("unavailable");expect(f.streamTransport.advance).toHaveBeenCalledOnce();expect(f.store.reserveJob).not.toHaveBeenCalled();expect(f.prepareStream).not.toHaveBeenCalled();expect(f.get(f.large.jobId).phase).toBe("completed");
 });
 it("retains a source-required original and stops new work without manufacturing completion",async()=>{
  const f=await mixedFixture();for(const job of f.plan.jobs.filter(job=>job.kind==="small"))f.done(job.jobId);f.set(f.large.jobId,{...f.get(f.large.jobId),phase:"unknown"});
  f.streamTransport.advance.mockResolvedValueOnce({record:f.get(f.large.jobId),outcome:"source_required"});await expect(runUploadTree(f.plan.treeId,new Map(),f)).rejects.toThrow("Reselect the original");expect(f.get(f.large.jobId).phase).toBe("unknown");expect(f.reselectStream).not.toHaveBeenCalled();
 });
 it("retains its lane through aborted streaming work and joins its completion",async()=>{
  const f=await mixedFixture(),gate=wait(),abort=new AbortController();let settled=false;
  f.streamTransport.advance.mockImplementationOnce(async(_tree,id)=>{await gate.promise;return f.done(id);});
  const operation=runUploadTree(f.plan.treeId,f.sources,{...f,signal:abort.signal}).catch((error: unknown) =>error).finally(()=>{settled=true;});await vi.waitFor(()=>expect(f.streamTransport.advance).toHaveBeenCalledOnce());abort.abort(Error("stopped"));await Promise.resolve();expect(settled).toBe(false);
  gate.release();expect(await operation).toMatchObject({message:"stopped"});expect(f.get(f.large.jobId).phase).toBe("completed");
 });
});
