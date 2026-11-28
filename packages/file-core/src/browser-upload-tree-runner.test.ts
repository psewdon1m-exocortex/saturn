import { requireTestValue } from "../../contracts/src/test-support.js";
import {randomUUID} from "node:crypto";
import {describe,it,expect,vi} from "vitest";
import {BrowserTreeJobRunner} from "./browser-upload-tree-runner.js";
import type {BrowserTreeAuthority} from "./browser-upload-tree-authority.js";
import type {BrowserTreeJobStatus} from "./browser-upload-tree-database.js";
import type {BrowserTreeOriginalReference,BrowserTreeReceipt} from "./browser-upload-tree-executor.js";

const proof={proof:"saturn.browser-tree-authority.v1"} as BrowserTreeAuthority;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function fixture(){
 const jobs=new Map<string,BrowserTreeJobStatus>(),events:string[]=[];let authorized=true;
 const database={inspect:vi.fn(async(p:BrowserTreeAuthority,treeId:string,jobId:string)=>{if(!authorized||p!==proof)throw Error("browser_tree_authorization_changed");const job=jobs.get(treeId+":"+jobId);if(!job)throw Error("browser_tree_not_found");return structuredClone(job);})};
 let active=0,peak=0;const blockers=new Map<string,ReturnType<typeof gate>>(),failures=new Map<string,string>();
 const execute=vi.fn(async(ref:BrowserTreeOriginalReference,_p:BrowserTreeAuthority,_signal?:AbortSignal):Promise<BrowserTreeReceipt>=>{void _signal;void _p;
  const job=requireTestValue(jobs.get(ref.treeId+":"+ref.jobId)),item=requireTestValue(job.items.find(i=>i.itemId===ref.itemId));events.push(item.relativePath);active++;peak=Math.max(peak,active);
  try{await blockers.get(item.itemId)?.promise;const error=failures.get(item.itemId);if(error){(item as {state:string}).state="unknown";(job as {state:string}).state="unknown";throw Error(error);}
   const receipt={resourceId:randomUUID(),versionId:item.kind==="file"?randomUUID():null,relativePath:item.relativePath,kind:item.kind,sizeBytes:0,sha256:item.kind==="file"?"0".repeat(64):null};
   Object.assign(item,{state:"published",receipt});if(job.items.every(i=>i.state==="published"))Object.assign(job,{state:"completed"});return receipt;
  }finally{active--;}
 });
 const runner=new BrowserTreeJobRunner({database,directories:{execute},files:{execute}});
 function job(names:readonly string[]){const treeId=randomUUID(),jobId=randomUUID(),items=names.map(relativePath=>({itemId:randomUUID(),parentItemId:null as string|null,relativePath,kind:"directory" as const,state:"reserved",receipt:null}));const value={treeId,jobId,intentSha256:"a".repeat(64),state:"accepted",items};jobs.set(treeId+":"+jobId,value);return value;}
 return {runner,job,jobs,events,database,execute,blockers,failures,revoke:()=>{authorized=false;},active:()=>active,peak:()=>peak};
}
describe("bounded original tree job runner",()=>{
 it("publishes parent DAG levels, skips confirmed receipts, and retains original item identities",async()=>{
  const f=fixture(),j=f.job(["parent/child/grandchild","parent","parent/child","already"]);requireTestValue(j.items[0]).parentItemId=requireTestValue(j.items[2]).itemId;requireTestValue(j.items[2]).parentItemId=requireTestValue(j.items[1]).itemId;requireTestValue(j.items[3]).state="published";
  const result=await f.runner.run(proof,j.treeId,j.jobId);
  expect(f.events).toEqual(["parent","parent/child","parent/child/grandchild"]);expect(result.outcome).toBe("completed");
  expect(f.execute.mock.calls.map(([r])=>r.itemId)).toEqual([requireTestValue(j.items[1]).itemId,requireTestValue(j.items[2]).itemId,requireTestValue(j.items[0]).itemId]);
 });
 it("shares four item lanes across concurrent jobs and never leaves physical callbacks running",async()=>{
  const f=fixture(),jobs=[f.job(Array.from({length:8},(_,i)=>"a"+String(i))),f.job(Array.from({length:8},(_,i)=>"b"+String(i)))],hold=gate();
  for(const j of jobs)for(const item of j.items)f.blockers.set(item.itemId,hold);
  const runs=jobs.map(j=>f.runner.run(proof,j.treeId,j.jobId));await tick();expect(f.active()).toBe(4);hold.resolve();
  expect((await Promise.all(runs)).every(r=>r.outcome==="completed")).toBe(true);expect(f.peak()).toBe(4);expect(f.active()).toBe(0);
 });
 it("joins same-process duplicate execution only after authenticating the new request",async()=>{
  const f=fixture(),j=f.job(["once"]),hold=gate();f.blockers.set(requireTestValue(j.items[0]).itemId,hold);const first=f.runner.run(proof,j.treeId,j.jobId);await tick();
  const second=f.runner.run(proof,j.treeId,j.jobId);await tick();expect(f.execute).toHaveBeenCalledTimes(1);
  f.revoke();await expect(f.runner.run(proof,j.treeId,j.jobId)).rejects.toThrow("authorization_changed");hold.resolve();
  await expect(first).rejects.toThrow("authorization_changed");await expect(second).rejects.toThrow("authorization_changed");
 });
 it("retains UNKNOWN, does not execute its descendants, and completes independent siblings",async()=>{
  const f=fixture(),j=f.job(["failed","failed/child","okay"]);requireTestValue(j.items[1]).parentItemId=requireTestValue(j.items[0]).itemId;f.failures.set(requireTestValue(j.items[0]).itemId,"secret backend path/password");
  const result=await f.runner.run(proof,j.treeId,j.jobId);expect(f.events).toEqual(["failed","okay"]);expect(result.outcome).toBe("reconciliation_required");
  expect(result.failures).toEqual([{itemId:requireTestValue(j.items[0]).itemId,code:"browser_tree_execution_failed"}]);expect(requireTestValue(result.status.items[0]).state).toBe("unknown");
  await f.runner.run(proof,j.treeId,j.jobId);expect(f.execute).toHaveBeenCalledTimes(2);
 });
 it("tries an external parent once and returns pending without inventing a new original",async()=>{
  const f=fixture(),j=f.job(["external/child"]);requireTestValue(j.items[0]).parentItemId=randomUUID();f.execute.mockImplementationOnce(async()=>{throw Error("browser_tree_parent_pending");});
  const result=await f.runner.run(proof,j.treeId,j.jobId);expect(result.outcome).toBe("pending");expect(requireTestValue(result.status.items[0]).state).toBe("reserved");expect(f.execute).toHaveBeenCalledTimes(1);
 });
 it("request cancellation stops new items and joins active effects before returning",async()=>{
  const f=fixture(),j=f.job(Array.from({length:8},(_,i)=>"n"+String(i))),hold=gate(),controller=new AbortController();for(const item of j.items)f.blockers.set(item.itemId,hold);
  let settled=false;const run=f.runner.run(proof,j.treeId,j.jobId,controller.signal).finally(()=>{settled=true;});await tick();controller.abort();await tick();
  expect(settled).toBe(false);expect(f.active()).toBe(4);hold.resolve();const result=await run;expect(result.outcome).toBe("interrupted");expect(f.events).toHaveLength(4);expect(f.active()).toBe(0);
 });
 it("bounded active jobs reject overload before effects; shutdown joins admitted work and refuses new work",async()=>{
  const f=fixture(),hold=gate(),jobs=Array.from({length:8},(_,i)=>f.job(["j"+String(i)]));for(const j of jobs)f.blockers.set(requireTestValue(j.items[0]).itemId,hold);
  const runs=jobs.map(j=>f.runner.run(proof,j.treeId,j.jobId));await tick();const extra=f.job(["extra"]);
  await expect(f.runner.run(proof,extra.treeId,extra.jobId)).rejects.toThrow("browser_tree_execution_capacity");
  let closed=false;const closing=f.runner.close().then(()=>{closed=true;});await tick();expect(closed).toBe(false);
  await expect(f.runner.run(proof,extra.treeId,extra.jobId)).rejects.toThrow("browser_tree_runtime_draining");
  hold.resolve();await Promise.all(runs);await closing;expect(f.active()).toBe(0);expect(f.events).not.toContain("extra");
 });
 it("reauthorizes after every wave so revoked access prevents the next physical effect",async()=>{
  const f=fixture(),j=f.job(["parent","parent/child"]);requireTestValue(j.items[1]).parentItemId=requireTestValue(j.items[0]).itemId;const original=requireTestValue(f.execute.getMockImplementation());
  f.execute.mockImplementation(async(...args)=>{const receipt=await original(...args);f.revoke();return receipt;});
  await expect(f.runner.run(proof,j.treeId,j.jobId)).rejects.toThrow("authorization_changed");expect(f.events).toEqual(["parent"]);
 });
});
