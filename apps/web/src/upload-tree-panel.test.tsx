import { requiredValue } from "./test-value.js";
import {afterEach,beforeEach,describe,expect,it,vi,type MockInstance} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {UploadTreePanel} from "./upload-tree-panel.js";
import {durableUploadTrees,type DurableTreeJob,type UploadTreeScope,type UploadTreeSummary,type DurableUploadTreeStore} from "./upload-tree-durable.js";
import {uploadTreeHttp,uploadTreeTransport,type UploadTreeHttp} from "./upload-tree-transport.js";
import {planUploadTree,type UploadTreePlan} from "./upload-tree-plan.js";
import * as source from "./upload-source-tree.js";
import {runUploadTree} from "./upload-tree-queue.js";
import {uploadTreeStreamHttp,type UploadTreeStreamHttp} from "./upload-tree-stream-http.js";
import {uploadTreeStreamTransport} from "./upload-tree-stream-transport.js";
vi.mock("./upload-tree-queue.js",()=>({runUploadTree:vi.fn()}));
const scope:UploadTreeScope={kind:"owner",rootId:crypto.randomUUID()},capability={schema:"saturn.browser-tree-capability.v1",available:true,limits:{items:16,wireBytes:4194304,metadataBytes:65536,smallFileBytes:262144,activeClientJobs:2}};
let plans:Map<string,UploadTreePlan>;
let treeCapability:MockInstance<UploadTreeHttp["capability"]>,streamCapability:MockInstance<UploadTreeStreamHttp["capability"]>;
let savePlan:MockInstance<DurableUploadTreeStore["savePlan"]>,releaseCompletedTree:MockInstance<DurableUploadTreeStore["releaseCompletedTree"]>;
const summary=(plan:UploadTreePlan):UploadTreeSummary=>({treeId:plan.treeId,createdAt:1,jobs:plan.jobs.length,files:plan.items.filter(i=>i.kind==="file").length,directories:plan.items.filter(i=>i.kind==="directory").length});
const directory=(name:string,children:readonly source.UploadTreeSource[]=[]):source.UploadTreeSource=>({kind:"directory",name,children:async function*(){yield*children;}});
const fileSource=(bytes=1):source.UploadTreeSource=>({kind:"file",name:"file.bin",getFile:async()=>new File([new Uint8Array(bytes)],"file.bin",{lastModified:1})});
beforeEach(()=>{
 plans=new Map();
 treeCapability=vi.spyOn(uploadTreeHttp,"capability").mockResolvedValue(capability);
 streamCapability=vi.spyOn(uploadTreeStreamHttp,"capability").mockResolvedValue({schema:"saturn.browser-tree-stream-capability.v1",available:false});
 vi.spyOn(source,"directoryPickerAvailable").mockReturnValue(true);
 vi.spyOn(source,"chooseUploadDirectory").mockResolvedValue(directory("root",[directory("empty"),fileSource()]));
 // UI protocol fixtures only: disk/restart/server evidence is separate.
 vi.spyOn(durableUploadTrees,"listPlans").mockImplementation(async()=>[...plans.values()].map(summary));
 savePlan=vi.spyOn(durableUploadTrees,"savePlan").mockImplementation(async(_scope,plan)=>{plans.set(plan.treeId,plan);});
 vi.spyOn(durableUploadTrees,"loadPlan").mockImplementation(async treeId=>({scope,plan:requiredValue(plans.get(treeId))}));
 vi.spyOn(durableUploadTrees,"loadJob").mockImplementation(async(treeId,jobId)=>{
  const plan=requiredValue(plans.get(treeId)),job=requiredValue(plan.jobs.find(j=>j.jobId===jobId));
  return {key:treeId+":"+jobId,treeId,jobId,scope,job,items:plan.items.filter(item=>job.itemIds.includes(item.itemId)),phase:"ready",createdAt:1,updatedAt:1} satisfies DurableTreeJob;
 });
 releaseCompletedTree=vi.spyOn(durableUploadTrees,"releaseCompletedTree").mockImplementation(async treeId=>{plans.delete(treeId);});
 vi.mocked(runUploadTree).mockImplementation(async treeId=>{
  const plan=requiredValue(plans.get(treeId));
  return {treeId,totalJobs:plan.jobs.length,completedJobs:plan.jobs.length,cancelledJobs:0,activeJobs:0,completedFiles:plan.items.filter(i=>i.kind==="file").length,completedDirectories:plan.items.filter(i=>i.kind==="directory").length,activeItemPaths:[]};
 });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.mocked(runUploadTree).mockReset();});
describe("product folder upload controls",()=>{
 it("keeps the legacy UI unchanged when server capability is absent",async()=>{
  treeCapability.mockResolvedValue({schema:capability.schema,available:false});
  render(<UploadTreePanel scope={scope}/>);await waitFor(()=>expect(treeCapability).toHaveBeenCalledOnce());expect(screen.queryByRole("region",{name:"Folder upload"})).toBeNull();expect(savePlan).not.toHaveBeenCalled();
 });
 it("uses the real enumeration/planner for empty folders and saves their IDs before running",async()=>{
  const busy=vi.fn(),stored=vi.fn();render(<UploadTreePanel scope={scope} onBusy={busy} onStored={stored}/>);
  fireEvent.click(await screen.findByRole<HTMLButtonElement>("button",{name:"Choose folder"}));
  await screen.findByText("1 files and 2 directories stored. 0 jobs cancelled.");
  const [,plan]=requiredValue(savePlan.mock.calls[0]);
  expect(plan.items.map(item=>item.relativePath)).toEqual(["root","root/empty","root/file.bin"]);
  expect(runUploadTree).toHaveBeenCalledWith(plan.treeId,expect.any(Map),expect.objectContaining({signal:expect.any(AbortSignal) as unknown}));
  expect(savePlan.mock.invocationCallOrder[0]).toBeLessThan(requiredValue(vi.mocked(runUploadTree).mock.invocationCallOrder[0]));
  await waitFor(()=>expect(busy.mock.calls.at(-1)).toEqual([false]));expect(stored).toHaveBeenCalledOnce();
 });
 it("offers individual files when directory selection is unsupported and keeps the exact Drop scope",async()=>{
  vi.mocked(source.directoryPickerAvailable).mockReturnValue(false);const drop:UploadTreeScope={kind:"drop",channelId:crypto.randomUUID()};
  render(<UploadTreePanel scope={drop}/>);expect((await screen.findByRole<HTMLButtonElement>("button",{name:"Choose folder"})).disabled).toBe(true);
  expect(screen.getByText(/This browser cannot select folders/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Choose files for batch upload"),{target:{files:[new File(["x"],"file.bin",{lastModified:1})]}});
  await waitFor(()=>expect(runUploadTree).toHaveBeenCalledOnce());expect(savePlan).toHaveBeenCalledWith(drop,expect.anything());
 });
 it("refuses an unsupported large member before saving or sending any part of the folder",async()=>{
  vi.mocked(source.chooseUploadDirectory).mockResolvedValue(directory("root",[directory("empty"),fileSource(262145)]));render(<UploadTreePanel scope={scope}/>);
  fireEvent.click(await screen.findByRole<HTMLButtonElement>("button",{name:"Choose folder"}));await screen.findByText(/contains files over 256 KiB/);expect(savePlan).not.toHaveBeenCalled();expect(runUploadTree).not.toHaveBeenCalled();
 });
 it("offers mixed trees only with stream capability and labels received bytes separately from stored files",async()=>{
  streamCapability.mockResolvedValue({schema:"saturn.browser-tree-stream-capability.v1",available:true,limits:{metadataBytes:65536,chunkBytes:4194304,maximumFileBytes:8*1024**2,activeClientJobs:2}});
  vi.mocked(source.chooseUploadDirectory).mockResolvedValue(directory("root",[directory("empty"),fileSource(262145)]));
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),run=requiredValue(vi.mocked(runUploadTree).getMockImplementation());
  vi.mocked(runUploadTree).mockImplementationOnce(async(...args)=>{
   args[2]?.onState?.({treeId:args[0],totalJobs:3,completedJobs:1,cancelledJobs:0,activeJobs:1,completedFiles:0,completedDirectories:1,activeItemPaths:["root/file.bin"],activeStreamBytes:[{relativePath:"root/file.bin",confirmedBytes:262145,totalBytes:262145}]});await gate;return run(...args);
  });
  render(<UploadTreePanel scope={scope}/>);await screen.findByRole<HTMLButtonElement>("button",{name:"Choose files"});fireEvent.click(screen.getByRole<HTMLButtonElement>("button",{name:"Choose folder"}));
  await screen.findByText(/bytes received. Waiting for final storage confirmation/);expect(screen.getByText(/0 files stored/)).toBeTruthy();
  const [,plan]=requiredValue(savePlan.mock.calls[0]);expect(plan.jobs.some(job=>job.kind==="stream")).toBe(true);expect(plan.items.map(item=>item.relativePath)).toEqual(["root","root/empty","root/file.bin"]);
  release();await screen.findByText("1 files and 2 directories stored. 0 jobs cancelled.");
 });
 it("keeps inspection of saved originals available when new tree admission is disabled",async()=>{
  const {plan}=await planUploadTree(crypto.randomUUID(),await source.enumerateUploadTree([fileSource(262145)]));plans.set(plan.treeId,plan);
  treeCapability.mockResolvedValue({schema:capability.schema,available:false});render(<UploadTreePanel scope={scope}/>);
  const button=await screen.findByRole<HTMLButtonElement>("button",{name:"Continue saved upload"});expect(button.disabled).toBe(false);fireEvent.click(button);
  await waitFor(()=>expect(runUploadTree).toHaveBeenCalledOnce());expect(requiredValue(vi.mocked(runUploadTree).mock.calls[0])[1].size).toBe(0);expect(savePlan).not.toHaveBeenCalled();
 });
 it("dispatches saved stream cancellation to its own original endpoint before parent jobs",async()=>{
  const {plan}=await planUploadTree(crypto.randomUUID(),await source.enumerateUploadTree([directory("root",[fileSource(262145)])]));plans.set(plan.treeId,plan);
  const stream=vi.spyOn(uploadTreeStreamTransport,"cancel").mockRejectedValue(Error("Stream remains retained")),small=vi.spyOn(uploadTreeTransport,"cancel").mockRejectedValue(Error("Parent remains retained"));
  render(<UploadTreePanel scope={scope}/>);fireEvent.click(await screen.findByRole<HTMLButtonElement>("button",{name:"Cancel pending jobs"}));await screen.findByText(/original jobs remain unresolved/);
  expect(stream.mock.calls.map(call=>call[1])).toEqual(plan.jobs.filter(job=>job.kind==="stream").map(job=>job.jobId));expect(stream.mock.invocationCallOrder[0]).toBeLessThan(requiredValue(small.mock.invocationCallOrder[0]));expect(plans.size).toBe(1);
 });
 it("responds to Stop immediately but retains busy state until the actual queue settles",async()=>{
  let release!:()=>void,captured:AbortSignal|undefined;const gate=new Promise<void>(resolve=>{release=resolve;});
  vi.mocked(runUploadTree).mockImplementation(async(_tree,_sources,options)=>{captured=options?.signal;await gate;requiredValue(captured).throwIfAborted();throw Error("unreachable");});
  const busy=vi.fn();render(<UploadTreePanel scope={scope} onBusy={busy}/>);fireEvent.click(await screen.findByRole<HTMLButtonElement>("button",{name:"Choose folder"}));await waitFor(()=>expect(runUploadTree).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole<HTMLButtonElement>("button",{name:"Stop sending"}));expect(requiredValue(captured).aborted).toBe(true);expect(screen.getByText("Stopping sends and waiting for active operations…")).toBeTruthy();expect(busy.mock.calls.at(-1)).toEqual([true]);
  release();await waitFor(()=>expect(busy.mock.calls.at(-1)).toEqual([false]));expect(plans.size).toBe(1);
 });
 it("restores saved originals with no File handles, and refuses removing unresolved records",async()=>{
  const {plan}=await planUploadTree(crypto.randomUUID(),await source.enumerateUploadTree([directory("root")]));plans.set(plan.treeId,plan);
  releaseCompletedTree.mockRejectedValueOnce(Error("Unresolved original tree jobs must be retained"));
  render(<UploadTreePanel scope={scope}/>);fireEvent.click(await screen.findByRole<HTMLButtonElement>("button",{name:"Continue saved upload"}));await waitFor(()=>expect(runUploadTree).toHaveBeenCalledOnce());
  expect(requiredValue(vi.mocked(runUploadTree).mock.calls[0])[0]).toBe(plan.treeId);expect(requiredValue(vi.mocked(runUploadTree).mock.calls[0])[1].size).toBe(0);expect(savePlan).not.toHaveBeenCalled();
  await waitFor(()=>expect((screen.getByRole<HTMLButtonElement>("button",{name:"Remove completed record"})).disabled).toBe(false));fireEvent.click(screen.getByRole<HTMLButtonElement>("button",{name:"Remove completed record"}));
  await screen.findByText("Unresolved original tree jobs must be retained");expect(plans.size).toBe(1);
 });
 it("reselects the original tree without allocating a second plan",async()=>{
  const roots=[directory("root",[directory("empty"),fileSource()])],{plan}=await planUploadTree(crypto.randomUUID(),await source.enumerateUploadTree(roots));plans.set(plan.treeId,plan);
  render(<UploadTreePanel scope={scope}/>);fireEvent.click(await screen.findByRole<HTMLButtonElement>("button",{name:"Reselect original folder"}));await waitFor(()=>expect(runUploadTree).toHaveBeenCalledOnce());
  expect(requiredValue(vi.mocked(runUploadTree).mock.calls[0])[0]).toBe(plan.treeId);expect([...requiredValue(vi.mocked(runUploadTree).mock.calls[0])[1].keys()]).toEqual(plan.items.filter(item=>item.kind==="file").map(item=>item.itemId));expect(savePlan).not.toHaveBeenCalled();
 });
 it("reselects a flat batch with original IDs and refuses changed source metadata",async()=>{
  const {plan}=await planUploadTree(crypto.randomUUID(),await source.enumerateUploadTree([fileSource()]));plans.set(plan.treeId,plan);render(<UploadTreePanel scope={scope}/>);
  fireEvent.click(await screen.findByRole<HTMLButtonElement>("button",{name:"Reselect original files"}));
  fireEvent.change(screen.getByLabelText("Choose files for batch upload"),{target:{files:[new File(["xx"],"file.bin",{lastModified:1})]}});
  await screen.findByText("Selected tree source metadata changed");expect(runUploadTree).not.toHaveBeenCalled();
  await waitFor(()=>expect((screen.getByRole<HTMLButtonElement>("button",{name:"Reselect original files"})).disabled).toBe(false));fireEvent.click(screen.getByRole<HTMLButtonElement>("button",{name:"Reselect original files"}));
  fireEvent.change(screen.getByLabelText("Choose files for batch upload"),{target:{files:[new File(["x"],"file.bin",{lastModified:1})]}});
  await waitFor(()=>expect(runUploadTree).toHaveBeenCalledOnce());expect(requiredValue(vi.mocked(runUploadTree).mock.calls[0])[0]).toBe(plan.treeId);expect(savePlan).not.toHaveBeenCalled();
 });
 it("renders at most32 individual results and pages without accumulating rows",async()=>{
  const roots=Array.from({length:33},(_,i)=>directory("folder-"+String(i))),{plan}=await planUploadTree(crypto.randomUUID(),await source.enumerateUploadTree(roots));plans.set(plan.treeId,plan);
  render(<UploadTreePanel scope={scope}/>);fireEvent.click(await screen.findByRole<HTMLButtonElement>("button",{name:"View results"}));
  const results=await screen.findByLabelText("Individual folder upload results");expect(within(results).getAllByRole("listitem")).toHaveLength(32);
  await waitFor(()=>expect((screen.getByRole<HTMLButtonElement>("button",{name:"Next results"})).disabled).toBe(false));fireEvent.click(screen.getByRole<HTMLButtonElement>("button",{name:"Next results"}));
  await waitFor(()=>expect(within(results).getAllByRole("listitem")).toHaveLength(1));expect(within(results).getByText("folder-32")).toBeTruthy();
 });
 it("cancels children before parents and retains uncertain results",async()=>{
  const roots=Array.from({length:17},(_,i)=>directory("folder-"+String(i))),{plan}=await planUploadTree(crypto.randomUUID(),await source.enumerateUploadTree(roots));plans.set(plan.treeId,plan);
  const cancel=vi.spyOn(uploadTreeTransport,"cancel").mockRejectedValue(Error("Original outcome unknown"));render(<UploadTreePanel scope={scope}/>);
  fireEvent.click(await screen.findByRole<HTMLButtonElement>("button",{name:"Cancel pending jobs"}));await screen.findByText("2 original jobs remain unresolved. Stored files and uncertain outcomes are retained.");
  expect(cancel.mock.calls.map(call=>call[1])).toEqual([...plan.jobs].reverse().map(job=>job.jobId));expect(plans.size).toBe(1);expect(releaseCompletedTree).not.toHaveBeenCalled();
 });
});
