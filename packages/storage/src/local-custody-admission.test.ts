import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {afterEach,expect,it,vi} from 'vitest';
import {inspectLocalCustody,LocalCustodyStorageAdapter} from './local-custody.js';

const owned:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const directory of owned.splice(0))await fs.rm(directory,{recursive:true,force:true});});
async function fixture(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'saturn-n01-custody-'));owned.push(directory);
 const parent=path.join(directory,'data'),control=path.join(directory,'control'),root=path.join(parent,'backend'),custodyFile=path.join(control,'receipt.json');
 await fs.mkdir(root,{recursive:true,mode:0o700});await fs.mkdir(control,{mode:0o700});
 const proof=await inspectLocalCustody(root,'n01-'+randomUUID(),randomUUID());
 await fs.writeFile(custodyFile,JSON.stringify(proof),{mode:0o600,flag:'wx'});
 return {directory,parent,control,root,custodyFile,proof,adapter:new LocalCustodyStorageAdapter({backend:'local',root,custodyFile})};
}
it('bounds duplicate common-ancestor work without caching it across admissions',async()=>{
 const f=await fixture(),lstat=vi.spyOn(fs,'lstat');
 await f.adapter.custody();
 expect(lstat.mock.calls.filter(([p])=>p===f.directory)).toHaveLength(1);
 lstat.mockClear();await f.adapter.custody();
 expect(lstat.mock.calls.filter(([p])=>p===f.directory)).toHaveLength(1);
});
it.each(['parent','control'] as const)('refuses a replaced %s ancestor on the next operation',async which=>{
 const f=await fixture();await f.adapter.custody();
 const original=f[which],moved=path.join(f.directory,'moved-'+which);
 await fs.rename(original,moved);await fs.symlink(moved,original,process.platform==='win32'?'junction':'dir');
 await expect(f.adapter.write('unexpected',Readable.from(['no']),{offset:0,create:true,exclusive:true})).rejects.toThrow('custody_invalid');
 expect(await fs.readdir(which==='parent'?path.join(moved,'backend'):f.root)).toEqual([]);
});
it('reads and rejects a changed generation on the next admission',async()=>{
 const f=await fixture();await f.adapter.custody();
 await fs.writeFile(f.custodyFile,JSON.stringify({...f.proof,generation:randomUUID()}));
 await expect(f.adapter.statFs()).rejects.toThrow('custody_invalid');
});
it('refuses a hard-linked custody receipt without touching backend bytes',async()=>{
 const f=await fixture();await fs.link(f.custodyFile,path.join(f.control,'alias.json'));
 await expect(f.adapter.write('unexpected',Readable.from(['no']),{offset:0,create:true,exclusive:true})).rejects.toThrow('custody_invalid');
 expect(await fs.readdir(f.root)).toEqual([]);
});
it('refuses the changed final receipt field after a valid admission',async()=>{
 const f=await fixture();await f.adapter.custody();
 await fs.writeFile(f.custodyFile,JSON.stringify({...f.proof,birthtimeNs:'1'}));
 await expect(f.adapter.custody()).rejects.toThrow('custody_invalid');
});
