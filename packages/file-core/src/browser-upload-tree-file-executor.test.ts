import { requireTestValue } from "../../contracts/src/test-support.js";
import {createHash,randomUUID} from "node:crypto";
import {Readable} from "node:stream";
import {describe,expect,it,vi} from "vitest";
import type {StorageAdapter,StorageReadStream} from "@saturn/storage";
import type {PostgresBrowserTreeDatabase} from "./browser-upload-tree-database.js";
import type {PostgresBrowserNamespaceCoordinator} from "./browser-upload-namespace-context.js";
import type {BrowserTreeAuthority} from "./browser-upload-tree-authority.js";
import {BrowserTreeFileExecutor} from "./browser-upload-tree-executor.js";

function fixture(bytes=Buffer.from("full source")){
 const reference={treeId:randomUUID(),jobId:randomUUID(),itemId:randomUUID()},proof={} as BrowserTreeAuthority;
 const sha256=createHash("sha256").update(bytes).digest("hex"),operationId=randomUUID();
 const receipt={resourceId:randomUUID(),versionId:randomUUID(),kind:"file" as const,sizeBytes:bytes.length,sha256,relativePath:"file.bin"};
 const original={reference,operationId,resourceId:receipt.resourceId,versionId:receipt.versionId,parentId:randomUUID(),publishTaskId:randomUUID(),writeTaskId:randomUUID(),name:"file.bin",destinationPath:"root/file.bin",stagingPath:`_system/incoming/${operationId}.part`,state:"reserved",receipt:null,sizeBytes:bytes.length,sha256,content:bytes};
 const database={inspectFile:vi.fn(async()=>original),beginFile:vi.fn(async()=>original),recordFileVerified:vi.fn(async(_proof:unknown,_reference:unknown,_operation:unknown,_evidence:unknown)=>{void _evidence;void _operation;void _reference;void _proof;}),beginFilePublication:vi.fn(async()=>original),publishFile:vi.fn(async()=>receipt),markExecutionUnknown:vi.fn(async()=>{})};
 const namespace={run:vi.fn(async(_intent:unknown,action:()=>Promise<unknown>)=>action())};
 let closed=true,body=bytes;
 const storage={supportsWriteVerifiedOnce:vi.fn(async()=>true),supportsWriteOnce:vi.fn(async()=>true),supportsRenameGroupOnce:vi.fn(async()=>true),exists:vi.fn(async()=>false),
  writeVerifiedOnce:vi.fn(async()=>({sizeBytes:String(bytes.length),sha256,prefix:bytes})),writeOnce:vi.fn(async()=>bytes.length),renameGroupOnce:vi.fn(async()=>{}),delete:vi.fn(),
  stat:vi.fn(async()=>({type:"file",size:bytes.length})),openRead:vi.fn(async()=>{const stream=Readable.from([body]) as StorageReadStream;if(closed)Object.defineProperty(stream,"storageClosed",{value:Promise.resolve()});return stream;})};
 const executor=new BrowserTreeFileExecutor({database:database as unknown as PostgresBrowserTreeDatabase,namespace:namespace as unknown as PostgresBrowserNamespaceCoordinator,storage:storage as unknown as StorageAdapter});
 return {reference,proof,original,receipt,storage,database,namespace,executor,unclosed:()=>{closed=false;},corrupt:()=>{body=Buffer.alloc(bytes.length,42);}};
}
describe("fixed small-file tree execution (physical SQL proof separate)",()=>{
 it("uses original write/publication identities and verifies before rename and catalog",async()=>{
  const f=fixture();expect(await f.executor.execute(f.reference,f.proof)).toEqual(f.receipt);
  expect(f.storage.writeVerifiedOnce).toHaveBeenCalledExactlyOnceWith(f.original.writeTaskId,f.original.stagingPath,f.original.content);
  expect(f.storage.renameGroupOnce).toHaveBeenCalledExactlyOnceWith(f.original.publishTaskId,[{operationId:f.original.operationId,source:f.original.stagingPath,destination:f.original.destinationPath}]);
  expect(f.database.recordFileVerified.mock.invocationCallOrder[0]).toBeLessThan(requireTestValue(f.storage.renameGroupOnce.mock.invocationCallOrder[0]));
  expect(f.storage.renameGroupOnce.mock.invocationCallOrder[0]).toBeLessThan(requireTestValue(f.database.publishFile.mock.invocationCallOrder[0]));
 });
 it("handles zero bytes through original write plus real stream/closure verification",async()=>{
  const f=fixture(Buffer.alloc(0));await f.executor.execute(f.reference,f.proof);expect(f.storage.writeVerifiedOnce).not.toHaveBeenCalled();expect(f.storage.writeOnce).toHaveBeenCalledOnce();expect(f.storage.openRead).toHaveBeenCalledOnce();expect(requireTestValue(f.database.recordFileVerified.mock.calls[0])[3]).toEqual({sizeBytes:0,sha256:f.original.sha256});
 });
 it("never publishes after corruption or missing backend handle closure",async()=>{
  for(const mode of ["corrupt","unclosed"] as const){const f=fixture();f.storage.supportsWriteVerifiedOnce.mockResolvedValue(false);f[mode]();await expect(f.executor.execute(f.reference,f.proof)).rejects.toThrow(mode==="corrupt"?"verification_failed":"read_closure_unavailable");expect(f.storage.renameGroupOnce).not.toHaveBeenCalled();expect(f.database.markExecutionUnknown).toHaveBeenCalledOnce();expect(f.storage.delete).not.toHaveBeenCalled();}
 });
 it("retains a physical orphan destination without overwriting it",async()=>{
  const f=fixture();f.storage.exists.mockResolvedValue(true);await expect(f.executor.execute(f.reference,f.proof)).rejects.toThrow("physical_target_exists");expect(f.storage.writeVerifiedOnce).not.toHaveBeenCalled();expect(f.storage.renameGroupOnce).not.toHaveBeenCalled();expect(f.storage.delete).not.toHaveBeenCalled();
 });
 it("recovers lost catalog acknowledgement from the exact version receipt",async()=>{
  const f=fixture();f.database.publishFile.mockImplementation(async()=>{f.database.inspectFile.mockResolvedValue({...f.original,state:"published",receipt:f.receipt,content:null} as never);throw Error("lost commit reply");});expect(await f.executor.execute(f.reference,f.proof)).toEqual(f.receipt);expect(f.storage.renameGroupOnce).toHaveBeenCalledOnce();expect(f.database.markExecutionUnknown).not.toHaveBeenCalled();
 });
 it("stops before rename on cancellation after verified write and retains the original",async()=>{
  const f=fixture(),controller=new AbortController();f.storage.writeVerifiedOnce.mockImplementation(async()=>{controller.abort();return {sizeBytes:String(f.original.sizeBytes),sha256:f.original.sha256,prefix:f.original.content};});await expect(f.executor.execute(f.reference,f.proof,controller.signal)).rejects.toMatchObject({name:"AbortError"});expect(f.storage.renameGroupOnce).not.toHaveBeenCalled();expect(f.database.markExecutionUnknown).toHaveBeenCalledOnce();
 });
});
