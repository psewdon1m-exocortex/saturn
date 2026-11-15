import { fixtureValue } from './test-values.fixture.js';
import {expect,it} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {migrate,rollback} from '@saturn/database';
import {backendFixture,migrations,evidence,uid} from './stage3-chat-a.fixture.js';

it('metadata migration is repeatable, refuses a live backend and restores exact function owner/ACL on down',async()=>{
 const f=await backendFixture('targeted-metadata-migration',112);
 // Qualify the exact 0119 metadata transition, separately from current-head upgrades.
 const selected=path.join(f.directory,'metadata-through-0119');await fs.mkdir(selected);
 for(const file of await fs.readdir(migrations))if(/^\d{4}_.*\.(up|down)\.sql$/.test(file)&&Number(file.slice(0,4))<=119)
  await fs.copyFile(path.join(migrations,file),path.join(selected,file));
 const definition=()=>f.admin.withSql(sql=>sql`SELECT pg_get_functiondef(p.oid) AS definition,p.proowner::text,p.proacl::text FROM pg_proc p WHERE p.oid='sync_backend_command(text,jsonb,jsonb)'::regprocedure`);
 try{
  const before=await definition();
  expect(await migrate(f.url,selected)).toBe(1);expect(await migrate(f.url,selected)).toBe(0);
  const after=await definition();expect(fixtureValue(after[0]).proowner).toBe(fixtureValue(before[0]).proowner);expect(fixtureValue(after[0]).proacl).toBe(fixtureValue(before[0]).proacl);
  await f.executor.start();await expect(rollback(f.url,selected)).rejects.toThrow('backend must be stopped');
  const identity={backendIdentity:f.backendIdentity,generation:f.generation,ownerId:uid(),fencingToken:uid()};
  const acquire=(id:string,kind:string,priority='foreground')=>f.command('read-acquire',identity,{id,kind,priority}) as Promise<{acquired:boolean}>;
  const ids:string[]=[];
  for(let n=0;n<127;n++){const id=uid();ids.push(id);await acquire(id,'content');}
  await expect(acquire(uid(),'content')).rejects.toThrow('capacity');
  const metadata=uid();ids.push(metadata);expect(await acquire(metadata,'metadata')).toEqual({acquired:true});
  await expect(acquire(uid(),'metadata','scrub')).rejects.toThrow('invalid_input');
  await expect(f.command('read-acquire',{...identity,generation:uid()},{id:metadata,kind:'metadata',priority:'foreground'})).rejects.toThrow('binding_invalid');
  for(const id of ids)await f.command('read-release',identity,{id});
  await f.executor.close();expect(await rollback(f.url,selected)).toBe('0119_backend_metadata_admission');
  expect(await definition()).toEqual(before);
  expect(await f.admin.withSql(sql=>sql`SELECT column_name FROM information_schema.columns WHERE table_name='sync_backend_read_slots' AND column_name='kind'`)).toHaveLength(0);
  expect(await migrate(f.url,selected)).toBe(1);expect(await migrate(f.url,selected)).toBe(0);
  await evidence('targeted-metadata-migration','result',{status:'PASS',up:1,repeat:0,downRestoresExactFunctionOwnerAcl:true,liveDownRefused:true,contentQueue:127,totalQueue:128,identityKindGuards:true});
 }finally{await f.close();}
},30000);
