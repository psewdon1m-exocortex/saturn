import {randomUUID,createHash} from "node:crypto";
import type {Database} from "@saturn/database";
import {describe,it,expect,vi} from "vitest";
import {BrowserTreeAuthorityIssuer} from "./browser-upload-tree-authority.js";
import {PostgresBrowserTreeDatabase} from "./browser-upload-tree-database.js";
function fixture(maximumFileBytes=262144){
 const transaction=vi.fn(),database={transaction} as unknown as Database;
 const issuer=new BrowserTreeAuthorityIssuer({ownerSession:async()=>({id:randomUUID(),tokenHash:"1".repeat(64),credentialRevision:"1"}),dropSession:async()=>({id:randomUUID(),channelId:randomUUID(),tokenHash:"2".repeat(64)})});
 const store=new PostgresBrowserTreeDatabase(database,issuer,{backendIdentity:"test",backendGeneration:randomUUID(),maximumFileBytes,dropGlobalBytes:1048576,continuationTtlMs:3600000});
 const file=(name:string)=>{const content=Buffer.from(name);return {kind:"file",itemId:randomUUID(),parentItemId:null,relativePath:name,sizeBytes:content.length,sha256:createHash("sha256").update(content).digest("hex"),contentBase64:content.toString("base64")};};
 return {issuer,store,transaction,file};
}
describe("browser tree fixed admission before SQL",()=>{
 it("does not open a transaction when the last item has an invalid full-content hash",async()=>{
  const f=fixture(),proof=await f.issuer.ownerSession({},randomUUID()),last={...f.file("last"),sha256:"0".repeat(64)};
  await expect(f.store.admit(proof,randomUUID(),{schema:"saturn.browser-tree-job.v1",jobId:randomUUID(),items:[f.file("first"),last]})).rejects.toThrow("mismatch");expect(f.transaction).not.toHaveBeenCalled();
 });
 it("rejects a forged or other-runtime proof before SQL or metadata disclosure",async()=>{
  const f=fixture(),other=fixture(),proof=await other.issuer.ownerSession({},randomUUID());
  await expect(f.store.inspect(proof,randomUUID(),randomUUID())).rejects.toThrow("browser_tree_authority_invalid");
  await expect(f.store.cancelBeforeExecution({proof:"saturn.browser-tree-authority.v1"},randomUUID(),randomUUID())).rejects.toThrow("browser_tree_authority_invalid");expect(f.transaction).not.toHaveBeenCalled();
 });
 it("enforces the configured file bound before any directory or quota reservation",async()=>{
  const f=fixture(1),proof=await f.issuer.dropSession({});
  await expect(f.store.admit(proof,randomUUID(),{schema:"saturn.browser-tree-job.v1",jobId:randomUUID(),items:[{kind:"directory",itemId:randomUUID(),parentItemId:null,relativePath:"empty"},f.file("larger")]})).rejects.toThrow("browser_tree_file_too_large");expect(f.transaction).not.toHaveBeenCalled();
 });
 it("refuses malformed durable tree and job identities",async()=>{
  const f=fixture(),proof=await f.issuer.ownerSession({},randomUUID());
  await expect(f.store.admit(proof,"wrong",{})).rejects.toThrow("browser_tree_identity_invalid");
  await expect(f.store.inspect(proof,randomUUID(),"wrong")).rejects.toThrow("browser_tree_identity_invalid");expect(f.transaction).not.toHaveBeenCalled();
 });
});
