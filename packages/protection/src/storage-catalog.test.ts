import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStorageAdapter } from "@saturn/storage";
import { ROOT_RESOURCE_ID, SYNC_RESOURCE_ID } from "@saturn/file-core";
import { buildCatalogPlan, scanStorageCatalog, type CatalogResource } from "./storage-catalog.js";

const directories: string[]=[];
afterEach(async()=>{ for(const directory of directories.splice(0)) await fs.rm(directory,{recursive:true,force:true}); });
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
function resource(id:string,storagePath:string,type:"file"|"folder",overrides:Partial<CatalogResource>={}):CatalogResource {
  return {id,parentId:storagePath.includes('/')?SYNC_RESOURCE_ID:ROOT_RESOURCE_ID,name:storagePath.split('/').at(-1)??'root',storagePath,type,
    status:'active',sizeBytes:0,sha256:null,currentVersionId:null,retentionClass:'general',securityClassification:'internal',updatedAt:new Date(0).toISOString(),...overrides};
}
async function fixture(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'saturn-catalog-'));directories.push(directory);
  const storage=new LocalStorageAdapter(directory);await storage.initialize();await storage.mkdir('sync');
  return storage;
}
describe('read-only storage catalog analysis',()=>{
  it('finds added, same-size changed and missing files without moving unknown bytes',async()=>{
    const storage=await fixture();
    await storage.mkdir('_system');await storage.write('_system/private.bin',Readable.from('hidden'),{offset:0,create:true});
    await storage.write('sync/known.txt',Readable.from('abd'),{offset:0,create:true});
    await storage.write('sync/new.txt',Readable.from('new'),{offset:0,create:true});
    const rename=vi.spyOn(storage,'rename');const remove=vi.spyOn(storage,'delete');const write=vi.spyOn(storage,'write');
    const inventory=await scanStorageCatalog(storage,async()=>undefined);
    const plan=buildCatalogPlan([
      resource(ROOT_RESOURCE_ID,'','folder',{parentId:null,sizeBytes:6}),resource(SYNC_RESOURCE_ID,'sync','folder',{sizeBytes:6}),
      resource('known','sync/known.txt','file',{sizeBytes:3,sha256:digest('abc')}),
      resource('missing','sync/gone.txt','file',{sizeBytes:3,sha256:digest('old')}),
    ],inventory);
    expect(plan.counts).toEqual({added:1,changed:1,missing:1,blocked:0});
    expect(plan.changes.find(change=>change.storagePath==='sync/known.txt')?.reason).toBe('content_changed');
    expect(inventory.entries.some(entry=>entry.storagePath.startsWith('_system'))).toBe(false);
    expect(rename).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
    expect(await storage.exists('sync/new.txt')).toBe(true);
  });
  it('reports root files and pending resource collisions as blocked',async()=>{
    const storage=await fixture();await storage.write('root.txt',Readable.from('root'),{offset:0,create:true});
    await storage.write('sync/pending.txt',Readable.from('pending'),{offset:0,create:true});
    const plan=buildCatalogPlan([resource('pending','sync/pending.txt','file',{status:'pending'})],await scanStorageCatalog(storage,async()=>undefined));
    expect(plan.counts.blocked).toBe(2);
    expect(await storage.exists('root.txt')).toBe(true);
  });
  it('rejects a file changed during hashing and leaves the catalog untouched',async()=>{
    const storage=await fixture();await storage.write('sync/changing.txt',Readable.from('abc'),{offset:0,create:true});
    const read=storage.openRead.bind(storage);
    vi.spyOn(storage,'openRead').mockImplementation(async name=>{
      await storage.write(name,Readable.from('longer'),{offset:0,create:false,truncate:true});return read(name);
    });
    await expect(scanStorageCatalog(storage,async()=>undefined)).rejects.toThrow('storage_changed_during_analysis');
  });
  it('prevents traversal paths returned by an adapter from being read',async()=>{
    const storage=await fixture();
    vi.spyOn(storage,'list').mockResolvedValue({entries:[{path:'../outside',name:'outside',type:'file',size:1,modifiedAt:new Date()}]});
    const read=vi.spyOn(storage,'openRead');const plan=await scanStorageCatalog(storage,async()=>undefined);
    expect(plan.blocked[0]?.reason).toBe('unsupported_or_conflicting_path');expect(read).not.toHaveBeenCalled();
  });
  it('blocks immutable changes and a missing protected root',()=>{
    const original=resource('immutable','sync/public.txt','file',{sizeBytes:3,sha256:digest('abc'),retentionClass:'laboratory_immutable'});
    const plan=buildCatalogPlan([resource(SYNC_RESOURCE_ID,'sync','folder'),original],{entries:[{
      storagePath:original.storagePath,name:original.name,type:'file',sizeBytes:3,sha256:digest('abd'),modifiedAt:new Date(0).toISOString(),
    }],blocked:[]});
    expect(plan.counts.blocked).toBe(2);
    expect(plan.changes.map(change=>change.reason)).toEqual(expect.arrayContaining(['protected_root_missing','immutable_resource_changed']));
  });
});
