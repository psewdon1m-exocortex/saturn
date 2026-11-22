import { AsyncLocalStorage } from 'node:async_hooks';
import { expect,vi } from 'vitest';
import type { FileService } from '@saturn/file-core';
import type { CatalogUploadDatabaseCoordinator,PreparedCatalogUpload } from '../../../packages/file-core/src/catalog-upload-database.js';
import type { activeFixture } from './stage3-chat-a.fixture.js';
type Fixture=Awaited<ReturnType<typeof activeFixture>>;
interface CompletionClient {database:CatalogUploadDatabaseCoordinator;files:FileService}
/** One declared ready publication set, after every member's real byte verification.
 * Early capability checks and all actual SQL/storage calls retain their behavior;
 * only the caller's post-verification arrival is held. Product tail timers stay real. */
export async function readySmallPublications(f:Fixture,c:CompletionClient,members:readonly {prepared:PreparedCatalogUpload;bytes:Buffer}[]){
  expect(members.length>=2&&members.length<=4).toBe(true);
  const flow=new AsyncLocalStorage<string>(),verified=new Set<string>(),arrived=new Set<string>();
  const read=f.executor.openRead.bind(f.executor),writeVerified=f.executor.writeVerifiedOnce.bind(f.executor),supports=c.database.supportsPublicationGroups.bind(c.database);
  let release=()=>{},expired=false;const gate=new Promise<void>(resolve=>{release=resolve;});
  const timer=setTimeout(()=>{expired=true;release();},5000);
  const reads=vi.spyOn(f.executor,'openRead').mockImplementation(async(p,options)=>{
    const stream=await read(p,options),original=flow.getStore();
    if(original===p&&options===undefined)stream.once('end',()=>{verified.add(p);});
    return stream;
  });
  const writes=vi.spyOn(f.executor,'writeVerifiedOnce').mockImplementation(async(...args)=>{
    const result=await writeVerified(...args);if(flow.getStore()===args[1])verified.add(args[1]);return result;
  });
  const capabilities=vi.spyOn(c.database,'supportsPublicationGroups').mockImplementation(async()=>{
    const actual=await supports(),original=flow.getStore();
    if(!original||!verified.has(original)||arrived.has(original))return actual;
    if(!actual)throw Error('Publication-group fixture capability unavailable');
    arrived.add(original);if(arrived.size===members.length){clearTimeout(timer);release();}
    await gate;if(expired)throw Error('Real verified originals did not reach the ready publication barrier');return actual;
  });
  try{
    const results=await Promise.allSettled(members.map(m=>flow.run(m.prepared.execution.tempPath,()=>c.files.completeSmallCatalogUpload(m.prepared,f.proof,m.bytes))));
    expect(arrived.size).toBe(members.length);expect(expired).toBe(false);return results;
  }finally{clearTimeout(timer);release();reads.mockRestore();writes.mockRestore();capabilities.mockRestore();flow.disable();}
}
export function publishedSmallGroup(results:Awaited<ReturnType<typeof readySmallPublications>>){
  return results.map(result=>{if(result.status==='rejected')throw result.reason;return result.value;});
}
