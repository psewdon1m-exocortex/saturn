import { randomUUID } from "node:crypto";
import { expect,it } from "vitest";
import { namespaceDescriptor,namespaceTombstone,validateNamespaceChanges,validateNamespaceDescriptor,type NamespaceProjectionRow } from "./current-namespace.js";
const root=randomUUID();
const row=():NamespaceProjectionRow=>({id:randomUUID(),parent_id:root,name:"file",type:"file",size_bytes:"9007199254740993",sha256:"a".repeat(64),current_version_id:randomUUID(),metadata_version:randomUUID(),sync_availability:null,status:"active"});
it("keeps decimal precision and truthful legacy UNKNOWN; rejects unqualified and malformed descriptors",()=>{
  const value=row();expect(namespaceDescriptor(value,root)).toMatchObject({size_bytes:"9007199254740993",availability:"UNKNOWN"});
  expect(()=>namespaceDescriptor({...value,metadata_version:null},root)).toThrow("projection_unqualified");
  expect(()=>namespaceDescriptor({...value,status:"trashed"},root)).toThrow("projection_unqualified");
  for(const changed of [{size_bytes:"9223372036854775808"},{parent_id:value.id},{content_version_id:null,availability:"AVAILABLE" as const},{size_bytes:"01"},
    {name:"path/name"},{name:String.fromCharCode(0xd800)},{storage_path:"private-secret"}])
    expect(()=>validateNamespaceDescriptor({...namespaceDescriptor(value,root),...changed})).toThrow("invalid_input");
});
it("retains confirmed tombstone preimage and distinct deletion identity; UNKNOWN alone never establishes removal",()=>{
  const before=namespaceDescriptor(row(),root),event=namespaceTombstone(before,"confirmed.delete",{type:"fixture",id:"owned"},"confirmed_sql_namespace_removal");
  expect(event.before_version).toBe(before.version);expect(event.description).toEqual({...before,version:event.description.version});expect(event.description.version).not.toBe(before.version);
  expect(()=>validateNamespaceChanges([{...event,before_version:event.description.version}])).toThrow("invalid_input");
  expect(()=>validateNamespaceChanges([{...event,kind:"upsert"}])).toThrow("invalid_input");
});
