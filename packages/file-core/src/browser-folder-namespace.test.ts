import { randomUUID } from "node:crypto";
import type { Database } from "@saturn/database";
import type { StorageAdapter } from "@saturn/storage";
import type { TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { FileService, type FileServiceOptions } from "./file.service.js";
import type { FileRepository } from "./repository.js";
import { ROOT_RESOURCE_ID, type Resource } from "./models.js";
import { PostgresBrowserNamespaceCoordinator } from "./browser-upload-namespace-context.js";

// Focused composition/order checks. SQL is mocked here; the separately recorded
// real database + backend + FileService probes qualify cross-process fencing.
function fixture() {
  const events:string[]=[], now=new Date(), parentId=randomUUID(), epoch=randomUUID();
  let denied=false, failedCommit=false, committedBeforeFailure=false, child:Resource|undefined;
  let parent:Resource={id:parentId,parentId:ROOT_RESOURCE_ID,name:"parent",storagePath:"parent",type:"folder",sizeBytes:0,status:"active",createdAt:now,updatedAt:now};
  const sql=(async(parts:TemplateStringsArray)=>{
    const query=parts.join("?");
    if(query.includes("browser_namespace_acquire")){events.push("acquire");if(denied)throw Error("namespace_conflict");parent={...parent,name:"current-parent",storagePath:"current-parent"};return [{epoch,state:"HELD"}];}
    if(query.includes("browser_namespace_finish")){events.push("finish");return [{state:"RELEASED"}];}
    if(query.includes("browser_namespace_unknown"))events.push("unknown");
    return [];
  }) as unknown as TransactionSql;
  Object.assign(sql,{json:vi.fn((value:unknown)=>value)});
  const database={withSql:async(action:(sql:TransactionSql)=>Promise<unknown>)=>action(sql)} as unknown as Database;
  const namespace=new PostgresBrowserNamespaceCoordinator(database,{backendIdentity:"folder-test",generation:randomUUID()});
  const create=vi.fn(async(record:{id:string;parentId:string;name:string;storagePath:string})=>{
    events.push("catalog");const value:Resource={...record,type:"folder",status:"active",sizeBytes:0,createdAt:now,updatedAt:now};
    if(!failedCommit||committedBeforeFailure)child=value;if(failedCommit)throw Error("catalog reply lost");return value;
  });
  const repository={getResource:async(id:string)=>{events.push(id===parentId?"parent":"lookup");return id===parentId?parent:child;},getChild:async()=>undefined,createFolder:create} as unknown as FileRepository;
  const mkdir=vi.fn(async()=>{events.push("mkdir");}),remove=vi.fn(async()=>{events.push("delete");});
  const storage={mkdir,delete:remove} as unknown as StorageAdapter;
  const options={uploadMaxBytes:1024,browserNamespaceCoordinator:namespace} as FileServiceOptions;
  const files=new FileService(repository,storage,options);
  return {files,parentId,events,mkdir,remove,create,deny:()=>{denied=true;},failCommit:(committed=false)=>{failedCommit=true;committedBeforeFailure=committed;}};
}
describe("FileService folder namespace integration",()=>{
  it("acquires the durable namespace before reading the current parent and holds it through publication",async()=>{
    const f=fixture();const folder=await f.files.createFolder(f.parentId,"child");
    expect(f.events).toEqual(["acquire","parent","mkdir","catalog","finish"]);
    expect(f.mkdir).toHaveBeenCalledWith("current-parent/child");expect(folder.storagePath).toBe("current-parent/child");
  });
  it("performs no physical or catalog mutation when namespace admission refuses",async()=>{
    const f=fixture();f.deny();await expect(f.files.createFolder(f.parentId,"child")).rejects.toThrow("namespace_conflict");
    expect(f.mkdir).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();expect(f.events).toEqual(["acquire"]);
  });
  it("retains an ambiguous published directory instead of issuing delete compensation",async()=>{
    const f=fixture();f.failCommit();await expect(f.files.createFolder(f.parentId,"child")).rejects.toThrow("catalog reply lost");
    expect(f.remove).not.toHaveBeenCalled();expect(f.events).toEqual(["acquire","parent","mkdir","catalog","lookup","unknown"]);
  });
  it("resolves a lost acknowledgement from the exact original published resource",async()=>{
    const f=fixture();f.failCommit(true);const folder=await f.files.createFolder(f.parentId,"child");
    expect(folder.id).toBe(f.create.mock.calls[0]?.[0].id);expect(f.create).toHaveBeenCalledTimes(1);expect(f.mkdir).toHaveBeenCalledTimes(1);expect(f.remove).not.toHaveBeenCalled();
    expect(f.events).toEqual(["acquire","parent","mkdir","catalog","lookup","finish"]);
  });
});
