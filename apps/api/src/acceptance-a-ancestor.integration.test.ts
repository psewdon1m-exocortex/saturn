import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import {fixtureManifest} from './stage3-chat-a.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
import {Database} from '@saturn/database';
import {migrate} from '../../../packages/database/src/migrate.js';
import {LocalStorageAdapter,RuntimeStorageManager} from '@saturn/storage';
import {FileService,PostgresFileRepository,ROOT_RESOURCE_ID} from '@saturn/file-core';
import {GuardedRuntime} from '../../../packages/sync/src/guarded-runtime.js';

const evidence=process.env.ACCEPTANCE_A_EVIDENCE;
const endpoint=process.env.ACCEPTANCE_A_DATABASE_URL;
if(!evidence||!endpoint)throw Error('Owned ACCEPTANCE_A_EVIDENCE and ACCEPTANCE_A_DATABASE_URL required');
const url=new URL(endpoint);
if(url.hostname!=='127.0.0.1'||!url.port)throw Error('Owned loopback PostgreSQL is required');
const name='ra20261020_rc01_a_'+randomUUID().replaceAll('-','');url.pathname='/'+name;
let db:Database,runtime:GuardedRuntime;
const initialized:{db?:Database;runtime?:GuardedRuntime}={};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const records:unknown[]=[];
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
beforeAll(async()=>{
 const owned=await fixtureManifest();
 if(owned.databaseUrl!==endpoint)throw Error('Ancestor endpoint differs from the owned PostgreSQL fixture');
 await fs.mkdir(evidence,{recursive:true});
 const admin=new Database(endpoint,{max:1});try{
  await admin.withSql(sql=>sql.unsafe('CREATE DATABASE '+name));
  if(process.env.ACCEPTANCE_A_PLAN==='hash')await admin.withSql(sql=>sql.unsafe('ALTER DATABASE '+name+' SET enable_nestloop=off; ALTER DATABASE '+name+' SET enable_mergejoin=off'));
 }finally{await admin.close();}
 await migrate(url.toString());db=new Database(url.toString(),{max:10,maintenanceBarrier:true});initialized.db=db;
 const raw=new LocalStorageAdapter(path.join(evidence,name,'storage'));await raw.initialize();
 const credential=path.join(evidence,name,'credential');await fs.writeFile(credential,'isolated-test-fixture');
 const config={host:'local-fixture',port:22,username:'qa',root:'/data',hostFingerprint:'SHA256:'+'A'.repeat(43),authMode:'password_file' as const,passwordFile:credential,operationTimeoutMs:30000,healthTimeoutMs:5000,maxConnections:4,requireFsync:true};
 const manager=new RuntimeStorageManager(config,path.join(evidence,name,'runtime'),()=>raw);await manager.initialize();
 runtime=await GuardedRuntime.create({database:db,storage:manager,device:{pepper:'acceptance-a-disposable-pepper-123456789012345678',options:{enabled:true,publicOrigin:'https://fixture.invalid',uploadChunkMaxBytes:8388608,propfindMaxItems:100,deleteMaxItems:500,deleteWindowMs:10000}}});
 initialized.runtime=runtime;await runtime.legacyFiles.initializeStorage();
 await fs.writeFile(path.join(evidence,'fixture.json'),JSON.stringify({name,pgMajor:18,maintenanceBarrier:true,max:10,factory:'GuardedRuntime.create',registeredRoots:0,physical:'local-fsync',endpoint:url.host,pid:process.pid,created:new Date().toISOString()},null,2));
},90000);
afterAll(async()=>{await fs.writeFile(path.join(evidence,'observations.json'),JSON.stringify(records,null,2));await initialized.runtime?.close();await initialized.db?.close();});
async function verify(rootId:string){
 const rows=await db.withSql(sql=>sql<{id:string;size_bytes:string;expected:string}[]>`
 WITH RECURSIVE tree AS(SELECT id,parent_id,type,size_bytes FROM resources WHERE id=${rootId}
 UNION ALL SELECT r.id,r.parent_id,r.type,r.size_bytes FROM resources r JOIN tree t ON r.parent_id=t.id WHERE r.status='active')
 SELECT t.id,t.size_bytes,COALESCE((SELECT sum(c.size_bytes) FROM resources c WHERE c.parent_id=t.id AND c.status='active'),0)::text AS expected FROM tree t WHERE t.type='folder' ORDER BY t.id`);
 records.push({rootId,rows,at:new Date().toISOString()});
 expect(rows.filter(r=>r.size_bytes!==r.expected)).toEqual([]);return rows;
}
it('T01 original CATALOG parallel4: 10 directories and 90 real 1KiB files have exact ancestor sums',async()=>{
 const service=runtime.legacyFiles,storage=runtime.legacyStorage,root=await service.createFolder(ROOT_RESOURCE_ID,'T01-'+randomUUID());
 let next=0;const manifest:unknown[]=[];
 await Promise.all(Array.from({length:4},async()=>{while(next<10){const n=next++,folder=await service.createFolder(root.id,'directory-'+String(n));
  for(let member=0;member<9;member++){
   const bytes=Buffer.alloc(1024,n*9+member),storagePath=folder.storagePath+'/file-'+String(member)+'.bin',sha256=digest(bytes);
   await storage.write(storagePath,Readable.from([bytes]),{offset:0,create:true,exclusive:true});
   const r=await service.adoptExistingFile({rootId:root.id,storagePath,sizeBytes:1024,sha256,mimeType:'application/octet-stream'});
   const read=await storage.openRead(storagePath),chunks:Buffer[]=[];for await(const chunk of fixtureChunks(read))chunks.push(Buffer.from(chunk));await read.storageClosed;
   expect(digest(Buffer.concat(chunks))).toBe(sha256);manifest.push({id:r.id,versionId:r.currentVersionId,storagePath,sha256,sizeBytes:1024});
  }
 }}));
 await fs.writeFile(path.join(evidence,'T01-manifest.json'),JSON.stringify(manifest,null,2));expect(manifest).toHaveLength(90);
 await verify(root.id);expect((await service.getResource(root.id)).sizeBytes).toBe(92160);
},90000);

it('T02 original DIR-T: 64 concurrent branches by depth16 without ancestor deadlock',async()=>{
 const service=runtime.legacyFiles,root=await service.createFolder(ROOT_RESOURCE_ID,'T02-'+randomUUID());
 let parents=Array(64).fill(root.id) as string[];
 for(let depth=0;depth<16;depth++){
  const settled=await Promise.allSettled(parents.map((parent,n)=>service.createFolder(parent,depth===0?'c-'+String(n):'level-'+String(depth))));
  const errors=settled.filter(r=>r.status==='rejected');records.push({depth,settled:settled.length,errors:errors.map(r=>String(r.reason))});
  expect(errors).toEqual([]);parents=settled.map(r=>{if(r.status!=='fulfilled')throw r.reason;return r.value.id;});
 }
 const rows=await verify(root.id);expect(rows).toHaveLength(1025);
 expect((await new PostgresFileRepository(db).getResource(root.id))?.sizeBytes).toBe(0);
},120000);

it('T01 controlled lock overlap: 20 seeded independent publication groups never lose an ancestor delta',async()=>{
 const service=runtime.legacyFiles,storage=runtime.legacyStorage;
 for(let seed=0;seed<20;seed++){
  const root=await service.createFolder(ROOT_RESOURCE_ID,'T01-controlled-'+String(seed)+'-'+randomUUID());
  const folders=[];for(let n=0;n<4;n++)folders.push(await service.createFolder(root.id,'d-'+String(n)));
  const inputs=[];for(const [n,folder]of folders.entries()){
   const bytes=Buffer.alloc(1024,seed*4+n),storagePath=folder.storagePath+'/file.bin';
   await storage.write(storagePath,Readable.from([bytes]),{offset:0,create:true,exclusive:true});
   inputs.push({rootId:root.id,storagePath,sizeBytes:1024,sha256:digest(bytes),mimeType:'application/octet-stream'});
  }
  let ready!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{ready=r;}),hold=new Promise<void>(r=>{release=r;});
  const blocker=db.transaction(async sql=>{await sql`SELECT id FROM resources WHERE id=${root.id} FOR NO KEY UPDATE`;ready();await hold;});
  await entered;const work=Promise.allSettled(inputs.map(input=>service.adoptExistingFile(input)));
  let waiting=0;try{
   const until=Date.now()+5000;do{waiting=Number(fixtureValue((await db.withSql(sql=>sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=${name} AND wait_event_type='Lock'`))[0]).n);if(waiting>=4)break;await delay(10);}while(Date.now()<until);
  }finally{release();await blocker;}
  const results=await work;records.push({seed,waiting,results:results.map(r=>r.status==='fulfilled'?{id:r.value.id}:String(r.reason))});
  expect(waiting).toBeGreaterThanOrEqual(4);expect(results.filter(r=>r.status==='rejected')).toEqual([]);
  await verify(root.id);expect((await service.getResource(root.id)).sizeBytes).toBe(4096);
 }
},120000);

it('T02 pins ancestor membership across 20 parent-move races and preserves a refused original',async()=>{
 for(let seed=0;seed<20;seed++){
 const service=runtime.legacyFiles,storage=runtime.legacyStorage;
 const a=await service.createFolder(ROOT_RESOURCE_ID,'membership-a-'+randomUUID()),b=await service.createFolder(ROOT_RESOURCE_ID,'membership-b-'+randomUUID());
 const parent=await service.createFolder(a.id,'moving-parent'),bytes=Buffer.alloc(1024,seed),storagePath=parent.storagePath+'/pending.bin';
 await storage.write(storagePath,Readable.from([bytes]),{offset:0,create:true,exclusive:true});
 const sibling=new Database(url.toString(),{max:4,maintenanceBarrier:true,maintenanceScope:db}),repository=new PostgresFileRepository(sibling),other=new FileService(repository,storage);
 const moveKey=randomUUID();
 let ready!:()=>void,release!:()=>void,armed=true;const entered=new Promise<void>(r=>{ready=r;}),hold=new Promise<void>(r=>{release=r;});
 const transaction=db.transaction.bind(db);
 const spy=vi.spyOn(db,'transaction').mockImplementation(action=>transaction(async sql=>{
  const observed=new Proxy(sql,{apply(target,thisArg,args){
   const value:unknown=Reflect.apply(target,thisArg,args);
   if(armed&&Array.isArray(args[0])&&args[0].join('').includes('SELECT DISTINCT id, cycle FROM ancestors')){
    armed=false;return Promise.resolve(value).then(async rows=>{ready();await hold;return rows;});
   }
   return value;
  }});return action(observed);
 }));
 let move:Promise<unknown>|undefined;
 try{
  const publication=service.adoptExistingFile({rootId:a.id,storagePath,sizeBytes:1024,sha256:digest(bytes),mimeType:'application/octet-stream'});
  await Promise.race([entered,delay(10000).then(()=>{throw Error('Discovery barrier not reached');})]);
  move=other.moveResource(parent.id,{parentId:b.id,idempotencyKey:moveKey});
  await delay(100);const during=await sibling.withSql(sql=>sql<{parent_id:string}[]>`SELECT parent_id FROM resources WHERE id=${parent.id}`);
  records.push({seed,membershipDuringDiscovery: fixtureValue(during[0]).parent_id,expected:a.id});
  release();const outcomes=await Promise.allSettled([publication,move]),published=await publication,moved=fixtureValue(outcomes[1]);
  // The publisher may invalidate the mover's earlier tree snapshot. The
  // production CAS guard must retain that refused original, not move stale data.
  if(moved.status==='rejected'){
   expect(moved.reason).toMatchObject({message:'precondition_failed'});
   const original=fixtureValue(await repository.getOperation('mutation:'+moveKey));
   expect(original).toMatchObject({state:'failed_final',errorCode:'precondition_failed'});
   expect(await service.getResource(parent.id)).toMatchObject({id:parent.id,parentId:a.id,storagePath:parent.storagePath});
   await expect(other.moveResource(parent.id,{parentId:b.id,idempotencyKey:moveKey})).rejects.toThrow('precondition_failed');
   expect(await repository.getOperation('mutation:'+moveKey)).toEqual(original);
   expect((await service.getResource(a.id)).sizeBytes).toBe(1024);expect((await service.getResource(b.id)).sizeBytes).toBe(0);
   records.push({seed,moveOriginal:original.id,outcome:'SAFE_PRECONDITION_REFUSAL',originalUnchangedOnReplay:true});
  }else{
   expect((await service.getResource(a.id)).sizeBytes).toBe(0);expect((await service.getResource(b.id)).sizeBytes).toBe(1024);
   records.push({seed,outcome:'MOVED_AFTER_PUBLICATION'});
  }
  expect(fixtureValue(during[0]).parent_id).toBe(a.id);
  const current=await service.getResource(published.id),read=await storage.openRead(current.storagePath),chunks:Buffer[]=[];
  for await(const chunk of fixtureChunks(read))chunks.push(Buffer.from(chunk));await read.storageClosed;
  expect(Buffer.concat(chunks)).toEqual(bytes);expect(current.currentVersionId).toBe(published.currentVersionId);
  await verify(a.id);await verify(b.id);
 }finally{release();await move?.catch(()=>undefined);spy.mockRestore();await sibling.close();}
 }
},90000);
