// @vitest-environment node
import { createHash,randomUUID } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
import { validateBrowserTreeJob } from "../../../packages/file-core/src/browser-upload-tree-contract.js";
import { prepareUploadTreeJob,UploadTreeNeedsStreamingError } from "./upload-tree-batch.js";
import type { UploadTreeItem } from "./upload-source-tree.js";

const hasher={hash:vi.fn(async(file:Blob)=>createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex"))};
function file(name:string,size:number,parent?:UploadTreeItem):UploadTreeItem{
  const value=new File([new Uint8Array(size).fill(219)],name,{lastModified:123});
  return {kind:"file",name,itemId:randomUUID(),...(parent?{parentItemId:parent.itemId}:{}),relativePath:parent?parent.relativePath+"/"+name:name,getFile:async()=>value};
}
const folder=(name:string):UploadTreeItem=>({kind:"directory",name,relativePath:name,itemId:randomUUID()});
describe("bounded browser tree job preparation",()=>{
  it("round-trips real bytes, empty directories and hashes through the server's closed parser",async()=>{
    const root=folder("folder"),empty={...folder("empty"),parentItemId:root.itemId,relativePath:"folder/empty"};
    const result=await prepareUploadTreeJob(randomUUID(),[root,empty,file("zero",0,root),file("content",48*1024,root)],{hasher});
    const accepted=validateBrowserTreeJob(JSON.parse(result.encoded));expect(accepted.directories).toBe(2);expect(accepted.files).toBe(2);expect(accepted.payloadBytes).toBe(48*1024);
    expect(result.fingerprints).toHaveLength(2);expect(result.fingerprints[1]).toMatchObject({relativePath:"folder/content",sizeBytes:48*1024,lastModified:123});
  });
  it("rejects an oversized encoded job before hashing any source bytes",async()=>{
    const hash=vi.fn();await expect(prepareUploadTreeJob(randomUUID(),Array.from({length:16},(_,n)=>file("file"+String(n),256*1024)),{hasher:{hash}})).rejects.toThrow("wire or metadata");expect(hash).not.toHaveBeenCalled();
  });
  it("makes the large-file streaming requirement explicit at the boundary",async()=>{
    const small=file("limit",256*1024),large=file("large",256*1024+1);expect(validateBrowserTreeJob((await prepareUploadTreeJob(randomUUID(),[small],{hasher})).job).files).toBe(1);
    const hash=vi.fn();await expect(prepareUploadTreeJob(randomUUID(),[large],{hasher:{hash}})).rejects.toBeInstanceOf(UploadTreeNeedsStreamingError);expect(hash).not.toHaveBeenCalled();
  });
  it("honours cancellation after hashing without opening payload bytes or preparing later files",async()=>{
    const controller=new AbortController(),source=file("first",1),next=file("second",1),getNext=vi.fn(next.getFile);
    let hashCalls=0;const aborting={hash:async()=>{hashCalls++;controller.abort();return "0".repeat(64);}};
    await expect(prepareUploadTreeJob(randomUUID(),[source,{...next,getFile:getNext}],{hasher:aborting,signal:controller.signal})).rejects.toMatchObject({name:"AbortError"});expect(hashCalls).toBe(1);
    // Header-only handles are bounded and may be opened before the first hash.
    expect(getNext).toHaveBeenCalledTimes(1);
  });
  it("rejects case collisions and a mismatched declared parent before source hashing",async()=>{
    const hash=vi.fn();await expect(prepareUploadTreeJob(randomUUID(),[folder("A"),folder("a")],{hasher:{hash}})).rejects.toThrow("identity or parent");
    const parent=folder("first"),child=file("child",1,parent);await expect(prepareUploadTreeJob(randomUUID(),[parent,{...child,relativePath:"second/child"}],{hasher:{hash}})).rejects.toThrow("exact declared");expect(hash).not.toHaveBeenCalled();
  });
});
