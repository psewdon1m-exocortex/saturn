import { requireTestValue } from "../../contracts/src/test-support.js";
import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {BrowserTreeDirectoryExecutor} from "./browser-upload-tree-executor.js";
import type {PostgresBrowserTreeDatabase} from "./browser-upload-tree-database.js";
import type {PostgresBrowserNamespaceCoordinator} from "./browser-upload-namespace-context.js";
import type {BrowserTreeAuthority} from "./browser-upload-tree-authority.js";
import type {StorageAdapter} from "@saturn/storage";

// Functional ordering only; native SQL/fencing/physical proof runs separately.
function fixture(){
 const reference={treeId:randomUUID(),jobId:randomUUID(),itemId:randomUUID()},proof={} as BrowserTreeAuthority;
 const receipt={resourceId:randomUUID(),versionId:null,kind:"directory" as const,sizeBytes:0,sha256:null,relativePath:"empty"};
 const original={reference,operationId:randomUUID(),resourceId:receipt.resourceId,publishTaskId:randomUUID(),parentId:randomUUID(),name:"empty",destinationPath:"root/empty",state:"reserved",receipt:null};
 const database={inspectDirectory:vi.fn(async()=>original),beginDirectory:vi.fn(async()=>({...original,destinationPath:"current-root/empty"})),publishDirectory:vi.fn(async()=>receipt),markExecutionUnknown:vi.fn(async()=>{})};
 const namespace={run:vi.fn(async(_intent:unknown,action:()=>Promise<unknown>)=>action())};
 const storage={supportsMkdirOnce:vi.fn(async()=>true),mkdirOnce:vi.fn(async()=>{}),mkdir:vi.fn(),delete:vi.fn()};
 const executor=new BrowserTreeDirectoryExecutor({database:database as unknown as PostgresBrowserTreeDatabase,namespace:namespace as unknown as PostgresBrowserNamespaceCoordinator,storage:storage as unknown as StorageAdapter});
 return {reference,proof,receipt,original,database,namespace,storage,executor};
}
describe("browser tree fixed directory execution",()=>{
 it("uses the reserved task and freshly authorized path, never legacy mkdir",async()=>{
  const f=fixture();expect(await f.executor.execute(f.reference,f.proof)).toEqual(f.receipt);
  expect(f.storage.mkdirOnce).toHaveBeenCalledExactlyOnceWith(f.original.publishTaskId,"current-root/empty");
  expect(f.storage.mkdir).not.toHaveBeenCalled();expect(f.database.publishDirectory).toHaveBeenCalledOnce();
  expect(requireTestValue(f.namespace.run.mock.calls[0])[0]).toEqual({operationId:f.original.operationId,kind:"create-folder",parentId:f.original.parentId,name:"empty"});
 });
 it("refuses an unsupported runtime before beginning any physical operation",async()=>{
  const f=fixture();f.storage.supportsMkdirOnce.mockResolvedValue(false);
  await expect(f.executor.execute(f.reference,f.proof)).rejects.toThrow("unsupported");expect(f.database.beginDirectory).not.toHaveBeenCalled();expect(f.storage.mkdirOnce).not.toHaveBeenCalled();
 });
 it("rechecks authorization after namespace admission and preserves an interrupted original",async()=>{
  const f=fixture();f.database.beginDirectory.mockRejectedValue(Error("authorization_changed"));
  await expect(f.executor.execute(f.reference,f.proof)).rejects.toThrow("authorization_changed");expect(f.storage.mkdirOnce).not.toHaveBeenCalled();expect(f.database.markExecutionUnknown).toHaveBeenCalledOnce();
 });
 it("resolves a lost publication acknowledgement only from the exact persisted receipt",async()=>{
  const f=fixture();f.database.publishDirectory.mockImplementation(async()=>{f.database.inspectDirectory.mockResolvedValue({...f.original,state:"published",receipt:f.receipt} as never);throw Error("commit reply lost");});
  expect(await f.executor.execute(f.reference,f.proof)).toEqual(f.receipt);expect(f.storage.mkdirOnce).toHaveBeenCalledOnce();expect(f.database.markExecutionUnknown).not.toHaveBeenCalled();
 });
 it("retains uncertain physical effects without retry, replacement or compensation",async()=>{
  const f=fixture();f.storage.mkdirOnce.mockRejectedValue(Error("physical reply lost"));
  await expect(f.executor.execute(f.reference,f.proof)).rejects.toThrow("physical reply lost");expect(f.storage.mkdirOnce).toHaveBeenCalledOnce();expect(f.storage.delete).not.toHaveBeenCalled();expect(f.database.publishDirectory).not.toHaveBeenCalled();expect(f.database.markExecutionUnknown).toHaveBeenCalledOnce();
 });
 it("returns a confirmed old receipt without acquiring another permit or requiring a new effect",async()=>{
  const f=fixture();f.database.inspectDirectory.mockResolvedValue({...f.original,state:"published",receipt:f.receipt} as never);
  expect(await f.executor.execute(f.reference,f.proof)).toEqual(f.receipt);expect(f.namespace.run).not.toHaveBeenCalled();expect(f.storage.supportsMkdirOnce).not.toHaveBeenCalled();
 });
 it("joins no concurrent duplicate original and aborts before an additional physical send",async()=>{
  const f=fixture();let resume!:()=>void;const wait=new Promise<void>(resolve=>{resume=resolve;});f.storage.mkdirOnce.mockImplementation(async()=>wait);
  const first=f.executor.execute(f.reference,f.proof);
  await expect(f.executor.execute(f.reference,f.proof)).rejects.toThrow("already_running");resume();await first;expect(f.storage.mkdirOnce).toHaveBeenCalledOnce();
 });
});
