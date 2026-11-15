import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {CatalogRootAdmission} from './catalog-root-admission.js';
function gate(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};}

it('starts four private SQL callbacks together and retains the root until all settle',async()=>{
  const admission=new CatalogRootAdmission(),root=randomUUID(),started=gate(),held=gate();let active=0;
  const calls=Array.from({length:4},(_,n)=>admission.runSqlBatch(root,async()=>{if(++active===4)started.release();await held.promise;return n;}));
  await started.promise;
  const physical=vi.fn(async()=>undefined),next=admission.run(root,physical);await Promise.resolve();expect(physical).not.toHaveBeenCalled();
  held.release();expect(await Promise.all(calls)).toEqual([0,1,2,3]);await next;expect(physical).toHaveBeenCalledOnce();
});
it('one failed SQL original cannot release another active callback or hide its result',async()=>{
  const admission=new CatalogRootAdmission(),root=randomUUID(),started=gate(),held=gate();
  const bad=admission.runSqlBatch(root,async()=>{throw Error('original failure');});
  const observed=expect(bad).rejects.toThrow('original failure');
  const good=admission.runSqlBatch(root,async()=>{started.release();await held.promise;return 'kept';});
  await started.promise;const physical=vi.fn(async()=>undefined),next=admission.run(root,physical);await Promise.resolve();expect(physical).not.toHaveBeenCalled();
  held.release();await observed;expect(await good).toBe('kept');await next;
});
it('close rejects every queued SQL original and drain joins the active root',async()=>{
  const admission=new CatalogRootAdmission(),root=randomUUID(),held=gate(),started=gate();
  const active=admission.run(root,async()=>{started.release();await held.promise;});await started.promise;
  const callback=vi.fn(async()=>undefined),pending=Array.from({length:4},()=>expect(admission.runSqlBatch(root,callback)).rejects.toMatchObject({code:'cancelled'}));
  admission.close();await Promise.all(pending);expect(callback).not.toHaveBeenCalled();
  let drained=false;const drain=admission.drain().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);
  held.release();await active;await drain;expect(drained).toBe(true);
});
