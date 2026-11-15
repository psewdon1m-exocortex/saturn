import {useEffect,useRef,useState} from "react";
import {chooseUploadDirectory,directoryPickerAvailable,captureDroppedTree,enumerateUploadTree,type UploadTreeSource} from "./upload-source-tree.js";
import {planUploadTree,reselectUploadTree} from "./upload-tree-plan.js";
import {durableUploadTrees,type UploadTreeScope,type UploadTreeSummary,type DurableTreeJob} from "./upload-tree-durable.js";
import {uploadTreeHttp,uploadTreeTransport,parseUploadTreeCapability} from "./upload-tree-transport.js";
import {runUploadTree,type UploadTreeQueueState} from "./upload-tree-queue.js";
import {uploadTreeStreamHttp} from "./upload-tree-stream-http.js";
import {uploadTreeStreamTransport,parseUploadTreeStreamCapability} from "./upload-tree-stream-transport.js";
import "./upload-tree-panel.css";

const scopeIdentity=(scope:UploadTreeScope)=>scope.kind+":"+(scope.kind==="owner"?scope.rootId:scope.channelId);
const text=(error:unknown)=>error instanceof Error?error.message:"The upload outcome is unavailable. Its original remains saved.";

/** Product entry point for the real picker/drag manifest, including empty
 * directories. Server capability gates new work; retained originals remain
 * visible even when execution is temporarily unavailable. */
export function UploadTreePanel({scope,disabled=false,onBusy,onStored}:{
 readonly scope:UploadTreeScope;readonly disabled?:boolean;readonly onBusy?:(value:boolean)=>void;readonly onStored?:()=>void;
}){
 const identity=scopeIdentity(scope),current=useRef(identity);current.current=identity;
 const [available,setAvailable]=useState(false),[storageReady,setStorageReady]=useState(false),[trees,setTrees]=useState<readonly UploadTreeSummary[]>([]);
 const [streamAvailable,setStreamAvailable]=useState(false);
 const [selected,setSelected]=useState<string>(),[page,setPage]=useState(0),[jobs,setJobs]=useState<readonly DurableTreeJob[]>([]),[jobCount,setJobCount]=useState(0);
 const [message,setMessage]=useState(""),[busy,setBusy]=useState(false),[progress,setProgress]=useState<UploadTreeQueueState>();
 const active=useRef<AbortController|undefined>(undefined),handles=useRef(new Map<string,ReadonlyMap<string,File>>()),view=useRef(0),callbacks=useRef({onBusy,onStored});callbacks.current={onBusy,onStored};
 const fileInput=useRef<HTMLInputElement>(null),fileReselection=useRef<string|undefined>(undefined);
 const refresh=async(captured=identity)=>{const value=await durableUploadTrees.listPlans(scope);if(current.current===captured)setTrees(value);};
 const show=async(treeId:string,index=0)=>{
  const revision=++view.current,captured=current.current,{plan}=await durableUploadTrees.loadPlan(treeId);
  const shown=await Promise.all(plan.jobs.slice(index*2,index*2+2).map(job=>durableUploadTrees.loadJob(treeId,job.jobId)));
  if(current.current===captured&&view.current===revision){setSelected(treeId);setPage(index);setJobCount(plan.jobs.length);setJobs(shown);}
 };
 useEffect(()=>{
  const controller=new AbortController();let mounted=true;
  setAvailable(false);setStreamAvailable(false);setStorageReady(false);setTrees([]);setSelected(undefined);setJobs([]);setMessage("");setProgress(undefined);view.current++;
  void Promise.resolve().then(()=>uploadTreeHttp.capability(scope,controller.signal)).then(value=>{if(mounted)setAvailable(parseUploadTreeCapability(value)!==undefined);}).catch(()=>{if(mounted)setAvailable(false);});
  void Promise.resolve().then(()=>uploadTreeStreamHttp.capability(scope,controller.signal)).then(value=>{if(mounted)setStreamAvailable(parseUploadTreeStreamCapability(value)!==undefined);}).catch(()=>{if(mounted)setStreamAvailable(false);});
  void durableUploadTrees.listPlans(scope).then(value=>{if(mounted){setTrees(value);setStorageReady(true);}}).catch((error: unknown) =>{if(mounted)setMessage(text(error));});
  return()=>{mounted=false;controller.abort();active.current?.abort(new DOMException("Upload view closed; originals retained","AbortError"));handles.current.clear();view.current++;};
 },[identity]);
 const action=async(work:(signal:AbortSignal)=>Promise<void>)=>{
  if(active.current||disabled)return;const controller=new AbortController(),captured=current.current;active.current=controller;setBusy(true);callbacks.current.onBusy?.(true);
  try{await work(controller.signal);}
  catch(error){if(current.current===captured)setMessage(text(error));}
  finally{
   try{if(current.current===captured)await refresh(captured);}catch(error){if(current.current===captured)setMessage(text(error));}
   if(active.current===controller){active.current=undefined;setBusy(false);callbacks.current.onBusy?.(false);}
   if(fileInput.current)fileInput.current.value="";
  }
 };
 const run=async(treeId:string,sources:ReadonlyMap<string,File>,signal:AbortSignal)=>{
  let latest:UploadTreeQueueState|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const captured=current.current,flush=()=>{timer=undefined;if(latest&&current.current===captured)setProgress(latest);};
  try{
   const result=await runUploadTree(treeId,sources,{signal,onState:state=>{latest=state;if(timer===undefined)timer=setTimeout(flush,100);}});
   if(current.current===captured){setProgress(result);setMessage(`${String(result.completedFiles)} files and ${String(result.completedDirectories)} directories stored. ${String(result.cancelledJobs)} jobs cancelled.`);callbacks.current.onStored?.();}
  }finally{if(timer!==undefined)clearTimeout(timer);flush();if(current.current===captured)await show(treeId);}
 };
 const start=async(source:Promise<readonly UploadTreeSource[]>,signal:AbortSignal)=>{
  if(!available||!storageReady)throw Error("Folder upload is not available yet");
  setMessage("Reading selected folder entries…");setProgress(undefined);
  const items=await enumerateUploadTree(await source,{signal}),prepared=await planUploadTree(crypto.randomUUID(),items,signal);
  // No plan/body/operation is admitted for an unsupported mixed tree.
  if(!streamAvailable&&prepared.plan.jobs.some(job=>job.kind==="stream"))throw Error("This folder contains files over 256 KiB. Folder streaming is not available yet. No items were sent; use Upload files for those files.");
  signal.throwIfAborted();await durableUploadTrees.savePlan(scope,prepared.plan);handles.current.set(prepared.plan.treeId,prepared.sources);
  if(current.current!==identity)return;setSelected(prepared.plan.treeId);await refresh();await run(prepared.plan.treeId,prepared.sources,signal);
 };
 const choose=(treeId?:string)=>{
  if(active.current||disabled)return;
  const source=chooseUploadDirectory().then(root=>[root]);
  void source.catch(()=>undefined); // Picker cancellation can precede an IDB read.
  void action(async signal=>{
   if(treeId===undefined){await start(source,signal);return;}
   const roots=await source,{plan}=await durableUploadTrees.loadPlan(treeId),items=await enumerateUploadTree(roots,{signal}),sources=await reselectUploadTree(plan,items,signal);
   handles.current.set(treeId,sources);await run(treeId,sources,signal);
  });
 };
 const cancel=async(treeId:string,signal:AbortSignal)=>{
  const {plan}=await durableUploadTrees.loadPlan(treeId);let unresolved=0;
  // Descendants first: never declare a parent cancelled while a child exists.
  for(const job of [...plan.jobs].reverse()){
   signal.throwIfAborted();try{await(job.kind==="stream"?uploadTreeStreamTransport:uploadTreeTransport).cancel(treeId,job.jobId,signal);}catch(error){signal.throwIfAborted();unresolved++;setMessage(text(error));}
  }
  await show(treeId);setMessage(unresolved?`${String(unresolved)} original jobs remain unresolved. Stored files and uncertain outcomes are retained.`:"Pending jobs cancelled where possible. Already stored files remain stored.");callbacks.current.onStored?.();
 };
 if(!available&&trees.length===0)return null;
 const blocked=disabled||busy||!storageReady,folderPicker=directoryPickerAvailable();
 return <section className="upload-tree-panel" aria-label="Folder upload" onDragOver={event=>{if(event.dataTransfer.types.includes("Files")){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=blocked||!available?"none":"copy";}}} onDrop={event=>{
  if(!event.dataTransfer.types.includes("Files"))return;event.preventDefault();event.stopPropagation();if(blocked||!available)return;
  const source=captureDroppedTree(event.dataTransfer);void action(signal=>start(source,signal));
 }}>
  <h3>Folder upload</h3>
  <p>Select a folder or drop its tree here. Empty directories are preserved. {streamAvailable?"Large files can resume from their confirmed progress.":"Files up to 256 KiB are supported in this mode."}</p>
  <div className="upload-tree-actions"><button type="button" disabled={blocked||!available||!folderPicker} onClick={()=>choose()}>Choose folder</button><button type="button" disabled={blocked||!available} onClick={()=>{fileReselection.current=undefined;fileInput.current?.click();}}>{streamAvailable?"Choose files":"Choose small files"}</button></div>
  {!folderPicker?<p>This browser cannot select folders with empty directories. Choose individual files, or drag a folder if your browser supports it.</p>:null}
  {!available?<p>Folder uploads are unavailable on this server. Saved originals remain available for inspection.</p>:null}
  <input ref={fileInput} type="file" multiple className="visually-hidden-input" aria-label="Choose files for batch upload" onChange={event=>{
   const files=[...event.target.files??[]],treeId=fileReselection.current;fileReselection.current=undefined;if(!files.length)return;
   const roots=files.map(file=>({kind:"file" as const,name:file.name,getFile:()=>Promise.resolve(file)}));
   void action(async signal=>{
    if(treeId===undefined){await start(Promise.resolve(roots),signal);return;}
    const {plan}=await durableUploadTrees.loadPlan(treeId),items=await enumerateUploadTree(roots,{signal}),sources=await reselectUploadTree(plan,items,signal);
    handles.current.set(treeId,sources);await run(treeId,sources,signal);
   });
  }} />
  {busy?<button type="button" onClick={()=>{active.current?.abort(new DOMException("Sending stopped. Saved originals remain available for recovery.","AbortError"));setMessage("Stopping sends and waiting for active operations…");}}>Stop sending</button>:null}
  {progress?<p role="status">{progress.completedFiles} files stored · {progress.completedDirectories} directories stored · {progress.activeJobs} active jobs</p>:null}
  {progress?.activeStreamBytes?.map(item=><p key={item.relativePath} role="status">{item.relativePath}: {item.confirmedBytes.toLocaleString()} / {item.totalBytes.toLocaleString()} bytes received. Waiting for final storage confirmation.</p>)}
  {message?<p role="status">{message}</p>:null}
  {trees.length?<details open><summary>Saved folder uploads · {trees.length}</summary><ul>{trees.map(tree=><li key={tree.treeId}>
   <span>{tree.files} files · {tree.directories} directories · {new Date(tree.createdAt).toLocaleString()}</span>
   <button type="button" disabled={blocked} onClick={()=>void action(async()=>{await show(tree.treeId);})}>View results</button>
   <button type="button" disabled={blocked} onClick={()=>void action(signal=>run(tree.treeId,handles.current.get(tree.treeId)??new Map(),signal))}>Continue saved upload</button>
   <button type="button" disabled={blocked||!folderPicker} onClick={()=>choose(tree.treeId)}>Reselect original folder</button>
   <button type="button" disabled={blocked} onClick={()=>{fileReselection.current=tree.treeId;fileInput.current?.click();}}>Reselect original files</button>
   <button type="button" disabled={blocked} onClick={()=>void action(signal=>cancel(tree.treeId,signal))}>Cancel pending jobs</button>
   <button type="button" disabled={blocked} onClick={()=>void action(async()=>{await durableUploadTrees.releaseCompletedTree(tree.treeId);handles.current.delete(tree.treeId);if(selected===tree.treeId){setSelected(undefined);setJobs([]);}setMessage("Completed local record removed. Stored files remain stored.");})}>Remove completed record</button>
  </li>)}</ul></details>:null}
  {selected?<div aria-label="Individual folder upload results"><ul>{jobs.flatMap(job=>job.items.map(item=>{
   const state=job.status?.items.find(row=>row.itemId===item.itemId)?.state??job.phase;
   return <li key={item.itemId}><span>{item.relativePath}</span><strong>{state==="published"?"stored":state}</strong></li>;
  }))}</ul>{jobCount>2?<nav aria-label="Folder upload result pages"><button type="button" disabled={blocked||page===0} onClick={()=>void action(async()=>{await show(selected,page-1);})}>Previous results</button><span>{page+1} / {Math.ceil(jobCount/2)}</span><button type="button" disabled={blocked||(page+1)*2>=jobCount} onClick={()=>void action(async()=>{await show(selected,page+1);})}>Next results</button></nav>:null}</div>:null}
 </section>;
}
