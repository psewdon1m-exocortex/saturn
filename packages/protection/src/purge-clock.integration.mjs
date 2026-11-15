import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {before,after,test} from 'node:test';


/** @typedef {import('@saturn/database').Database} DatabaseClient */
/** @typedef {import('@saturn/storage').LocalStorageAdapter} LocalStorage */
/** @typedef {import('@saturn/file-core').Resource} Resource */
/** @typedef {import('@saturn/file-core').RetentionClass} RetentionClass */
/** @typedef {import('./purge.service.js').PurgeCandidate} PurgeCandidate */
/** @typedef {import('./purge.service.js').PurgeRepository} PurgeRepository */
/** @typedef {{artifactRoot:string,libraries:string,databaseUrl:string,templateDatabase:string,containerId:string,fileCore:string}} Fixture */
/** @typedef {{retention?:RetentionClass,count?:number,current?:boolean,young?:boolean,early?:boolean,futureArchive?:boolean,lateDeadline?:boolean,noArchived?:boolean,noDeadline?:boolean,infiniteArchived?:boolean,infiniteDeadline?:boolean,badChronology?:boolean,noCurrent?:boolean,pinned?:boolean}} VersionOptions */
/** @typedef {{id:string,resource_id:string,storage_path:string,sha256:string,size_bytes:number,mime_type:string,reason:string,state:string,created_at:string,archived_at:string|null,purge_after:string|null}} VersionRow */
/** @typedef {{label:string,anchor:number,resourceId:string,childId?:string,payloads:{path:string,sha256:string}[],candidate:PurgeCandidate,versions?:VersionRow[],policy?:import('@saturn/file-core').VersionRetentionPolicy}} CaseFixture */
/** @typedef {{actionCalls?:number}} PurgeStats */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isRecord(value){return typeof value==='object'&&value!==null&&!Array.isArray(value);}
/** @param {unknown} value @returns {value is unknown[]} */
function isArray(value){return Array.isArray(value);}
/** @param {unknown} value @returns {Fixture} */
function readFixture(value){
 assert(isRecord(value),'D014 fixture must be an object');
 const {artifactRoot,libraries,databaseUrl,templateDatabase,containerId,fileCore}=value;
 assert(typeof artifactRoot==='string'&&typeof libraries==='string'&&typeof databaseUrl==='string'&&typeof templateDatabase==='string'&&typeof containerId==='string'&&typeof fileCore==='string','D014 fixture requires string authority fields');
 return {artifactRoot,libraries,databaseUrl,templateDatabase,containerId,fileCore};
}
/** @param {unknown} value @param {readonly string[]} methods */
function hasConstructorMethods(value,methods){
 if(typeof value!=='function')return false;
 /** @type {unknown} */ const prototype=value.prototype;
 return isRecord(prototype)&&methods.every(name=>typeof prototype[name]==='function');
}
/** @param {unknown} value @returns {value is Pick<typeof import('@saturn/database'),'Database'>} */
function isDatabaseModule(value){return isRecord(value)&&hasConstructorMethods(value.Database,['withSql','transaction','close']);}
/** @param {unknown} value @returns {value is Pick<typeof import('@saturn/storage'),'LocalStorageAdapter'|'ensureStorageDirectory'>} */
function isStorageModule(value){return isRecord(value)&&hasConstructorMethods(value.LocalStorageAdapter,['initialize','openRead','write','exists','delete','close'])&&typeof value.ensureStorageDirectory==='function';}
/** @param {unknown} value @returns {value is Pick<typeof import('@saturn/file-core'),'FileService'|'PostgresFileRepository'|'ROOT_RESOURCE_ID'|'VERSION_RETENTION'>} */
function isFileModule(value){
 if(!isRecord(value)||!hasConstructorMethods(value.FileService,['initializeStorage','createFolder'])||typeof value.PostgresFileRepository!=='function'||value.ROOT_RESOURCE_ID!=='00000000-0000-7000-8000-000000000001'||!isRecord(value.VERSION_RETENTION))return false;
 const retentionMap=value.VERSION_RETENTION;
 return ['general','mastermind_markdown','mastermind_attachment','keepass','laboratory_immutable'].every(name=>{
  const policy=retentionMap[name];return isRecord(policy)&&typeof policy.maximumCount==='number'&&typeof policy.minimumAgeMs==='number'&&typeof policy.automaticPurge==='boolean';
 });
}
/** @param {unknown} value @returns {value is Pick<typeof import('./purge.service.js'),'PostgresPurgeRepository'|'PurgeService'>} */
function isPurgeModule(value){return isRecord(value)&&hasConstructorMethods(value.PostgresPurgeRepository,['listCandidates','withCandidate','markPurged'])&&hasConstructorMethods(value.PurgeService,['run']);}
/** @param {string} file @returns {Promise<unknown>} */
async function imp(file){
 /** @type {unknown} */
 const loaded=await import(pathToFileURL(file).href);
 return loaded;
}
/** @param {unknown} value @returns {Record<string,unknown>} */
function firstRow(value){assert(isArray(value)&&isRecord(value[0]),'D014 SQL requires a first object row');return value[0];}
/** @param {unknown} value */
function anchorTime(value){const row=firstRow(value);assert(row.at instanceof Date,'D014 SQL clock must be a Date');return row.at.getTime();}
/** @param {unknown} value @returns {{row:Record<string,unknown>}[]} */
function objectRows(value){assert(isArray(value),'D014 snapshot requires rows');return value.map(item=>{assert(isRecord(item)&&isRecord(item.row),'D014 snapshot requires JSON object rows');return {row:item.row};});}
/** @param {unknown} value */
function metadataSnapshot(value){
 assert(isRecord(value)&&isArray(value.locks),'D014 snapshot requires metadata/lock rows');
 return {resources:objectRows(value.resources),versions:objectRows(value.versions),operations:objectRows(value.operations),pins:objectRows(value.pins),locks:value.locks};
}
/** @param {unknown} value */
function errorText(value){
 if(value instanceof Error)return value.toString();
 if(typeof value==='string')return value;
 if(value===null)return 'null';
 if(value===undefined)return 'undefined';
 if(typeof value==='number'||typeof value==='boolean'||typeof value==='bigint'||typeof value==='symbol')return String(value);
 return JSON.stringify(value);
}

const fixtureFile=process.env.D014_FIXTURE,run=process.env.D014_RUN,entry=process.env.D014_PURGE_ENTRY;
if(!fixtureFile||!run||!/^[a-z0-9-]{1,30}$/.test(run)||!entry)throw Error('Explicit own D014 fixture/run/immutable entry required');
/** @type {unknown} */ const fixtureJSON=JSON.parse((await fs.readFile(fixtureFile,'utf8')).replace(/^\uFEFF/,''));
const fixture=readFixture(fixtureJSON);
if(!path.resolve(entry).startsWith(path.resolve(fixture.artifactRoot)+path.sep)||new URL(fixture.databaseUrl).port!=='55431')throw Error('Owned D014 snapshot/database mismatch');
const databaseModule=await imp(path.join(fixture.libraries,'packages/database/dist/index.js'));assert(isDatabaseModule(databaseModule),'D014 database export contract');
const storageModule=await imp(path.join(fixture.libraries,'packages/storage/dist/index.js'));assert(isStorageModule(storageModule),'D014 storage export contract');
const fileModule=await imp(fixture.fileCore);assert(isFileModule(fileModule),'D014 file export contract');
const purgeModule=await imp(entry);assert(isPurgeModule(purgeModule),'D014 purge export contract');
const {Database}=databaseModule,{LocalStorageAdapter,ensureStorageDirectory}=storageModule,{FileService,PostgresFileRepository,ROOT_RESOURCE_ID,VERSION_RETENTION}=fileModule,{PostgresPurgeRepository,PurgeService}=purgeModule;
/** @param {Uint8Array} bytes */
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),day=86400000;
const directory=path.join(fixture.artifactRoot,run),database='ra20261020_rc01_a_d014_'+randomUUID().replaceAll('-','');
const endpoint=new URL(fixture.databaseUrl);endpoint.pathname='/'+database;
/** @type {unknown[]} */ const observations=[];
/** @type {DatabaseClient|undefined} */ let db;
/** @type {LocalStorage|undefined} */ let storage;
/** @type {Resource|undefined} */ let parent;
/** @type {import('./purge.service.js').PostgresPurgeRepository|undefined} */ let repository;
function databaseClient(){assert(db,'D014 before hook database required');return db;}
function storageClient(){assert(storage,'D014 before hook storage required');return storage;}
function parentResource(){assert(parent,'D014 before hook parent required');return parent;}
function purgeRepository(){assert(repository,'D014 before hook repository required');return repository;}
/** @param {string} file @param {unknown} value */
async function json(file,value){
 const encoded=JSON.stringify(value,null,2);
 await fs.writeFile(file,serializedText(encoded)+'\n');
}
/** @param {unknown} value @returns {string} */
function serializedText(value){assert(typeof value==='string','D014 JSON serialization must produce text');return value;}
before(async()=>{
 await fs.mkdir(directory);
 await json(path.join(directory,'OWNERSHIP.json'),{at:new Date().toISOString(),pid:process.pid,database,containerId:fixture.containerId,template:fixture.templateDatabase,entry,entrySha256:sha(await fs.readFile(entry)),root:path.join(directory,'storage'),method:'Synthetic own resource/version timestamp metadata and real new payloads; no system clock/role/schema/qualification changes'});
 const admin=new Database(fixture.databaseUrl,{max:1});try{await admin.withSql(sql=>sql.unsafe('CREATE DATABASE '+database+' TEMPLATE '+fixture.templateDatabase));}finally{await admin.close();}
 db=new Database(endpoint.toString(),{max:2});storage=new LocalStorageAdapter(path.join(directory,'storage'));await storageClient().initialize();
 const files=new FileService(new PostgresFileRepository(databaseClient()),storage);await files.initializeStorage();parent=await files.createFolder(ROOT_RESOURCE_ID,'D014-'+run);repository=new PostgresPurgeRepository(databaseClient());
});
after(async()=>{await json(path.join(directory,'observations.json'),{run,entry,entrySha256:sha(await fs.readFile(entry)),observations});await db?.close();await storage?.close();});
/** @param {string} file @param {Buffer} bytes */
async function write(file,bytes){const parts=file.split('/');for(let i=1;i<parts.length;i++)await ensureStorageDirectory(storageClient(),parts.slice(0,i).join('/'));await storageClient().write(file,Readable.from([bytes]),{offset:0,create:true,exclusive:true});}
/** @param {string} file */
async function hashFile(file){if(!await storageClient().exists(file))return null;const stream=await storageClient().openRead(file),chunks=[];for await(const raw of stream){
 /** @type {unknown} */
 const chunk=raw;
 assert(Buffer.isBuffer(chunk)||typeof chunk==='string'||chunk instanceof Uint8Array,'D014 read chunk');chunks.push(Buffer.from(chunk));
}await stream.storageClosed;return sha(Buffer.concat(chunks));}
/** @param {string} label @param {VersionOptions} options @returns {Promise<CaseFixture>} */
async function makeVersion(label,options={}){
 const retention=options.retention??'general',policy=VERSION_RETENTION[retention],count=options.count??(retention==='mastermind_markdown'?101:11);
 /** @type {unknown} */ const clockRows=await databaseClient().withSql(sql=>sql`SELECT clock_timestamp() AS at`);const anchor=anchorTime(clockRows);
 /** @type {VersionRow[]} */ const versions=[];
 const resourceId=randomUUID(),payloads=[],storagePath=parentResource().storagePath+'/'+label+'.bin';
 for(let i=0;i<count;i++){
  const id=randomUUID(),current=i===count-1,file=current?storagePath:`_system/versions/${resourceId}/${id}/payload.bin`;
  const bytes=Buffer.from('D014 new synthetic bytes '+label+' ordinal '+String(i));
  const created=new Date(anchor-60*day+i*1000).toISOString();
  const archived=current?null:new Date(anchor-40*day).toISOString(),deadline=current?null:new Date(anchor-10*day).toISOString();
  versions.push({id,resource_id:resourceId,storage_path:file,sha256:sha(bytes),size_bytes:bytes.length,mime_type:'application/octet-stream',reason:current?'initial':'overwrite',state:'active',created_at:created,archived_at:archived,purge_after:deadline});
  payloads.push({path:file,sha256:sha(bytes)});await write(file,bytes);
 }
 const lastVersion=versions.at(-1);assert(lastVersion,'D014 generated versions required');
 const candidate=options.current?lastVersion:versions[0];assert(candidate,'D014 selected version required');
 if(options.current){candidate.archived_at=new Date(anchor-40*day).toISOString();candidate.purge_after=new Date(anchor-day).toISOString();}
 if(options.young){candidate.archived_at=new Date(anchor-day).toISOString();candidate.purge_after=new Date(anchor+29*day).toISOString();}
 if(options.early){candidate.archived_at=new Date(anchor-day).toISOString();candidate.purge_after=new Date(anchor-day/2).toISOString();}
 if(options.futureArchive){candidate.archived_at=new Date(anchor+day).toISOString();candidate.purge_after=new Date(anchor-day).toISOString();}
 if(options.lateDeadline)candidate.purge_after=new Date(anchor+day).toISOString();
 if(options.noArchived)candidate.archived_at=null;
 if(options.noDeadline)candidate.purge_after=null;
 if(options.infiniteArchived)candidate.archived_at='-infinity';
 if(options.infiniteDeadline)candidate.purge_after='-infinity';
 if(options.badChronology)candidate.archived_at=new Date(anchor-61*day).toISOString();
 await databaseClient().transaction(async sql=>{
  await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,size_bytes,sha256,status,retention_class,security_classification) VALUES(${resourceId},'file',${parentResource().id},${label+'.bin'},${storagePath},${lastVersion.size_bytes},${lastVersion.sha256},'active',${retention},${options.pinned?'public':'internal'})`;
  await sql`INSERT INTO file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason,state,created_at,archived_at,purge_after)
    SELECT p.id,p.resource_id,p.storage_path,p.sha256,p.size_bytes,p.mime_type,p.reason,p.state,p.created_at,p.archived_at,p.purge_after
    FROM jsonb_to_recordset(${sql.json(versions)}) AS p(id uuid,resource_id uuid,storage_path text,sha256 text,size_bytes bigint,mime_type text,reason text,state text,created_at timestamptz,archived_at timestamptz,purge_after timestamptz)`;
  if(!options.noCurrent)await sql`UPDATE resources SET current_version_id=${lastVersion.id} WHERE id=${resourceId}`;
  if(options.pinned)await sql`INSERT INTO laboratory_assets(id,resource_id,mode,pinned_version_id,public_filename,label,disposition,state,created_at,updated_at) VALUES(${randomUUID()},${resourceId},'public_immutable',${candidate.id},'pin.bin','D014 own pin','attachment','active',clock_timestamp(),clock_timestamp())`;
 });
 /** @type {PurgeCandidate} */ const purgeCandidate={kind:'version',id:candidate.id,resourceId,storagePath:candidate.storage_path};
 return {label,anchor,resourceId,versions,payloads,candidate:purgeCandidate,policy};
}
/** @param {string} label @param {{young?:boolean,keepass?:boolean}} options @returns {Promise<CaseFixture>} */
async function makeTrash(label,{young=false,keepass=false}={}){
 /** @type {unknown} */ const clockRows=await databaseClient().withSql(sql=>sql`SELECT clock_timestamp() AS at`);
 const anchor=anchorTime(clockRows),resourceId=randomUUID(),childId=randomUUID(),versionId=randomUUID();
 assert(typeof run==='string','D014 original run authority required');
 const root='_system/trash/D014-'+run+'/'+resourceId,file=root+'/child.bin',bytes=Buffer.from('D014 own trash '+label);await write(file,bytes);
 await databaseClient().transaction(async sql=>{
  await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status,trashed_from_parent_id,trashed_from_name,purge_after,retention_class) VALUES(${resourceId},'folder',${parentResource().id},${label},${root},'trashed',${parentResource().id},${label},${new Date(anchor+(young?day:-day))},${keepass?'keepass':'general'})`;
  await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status,size_bytes,sha256) VALUES(${childId},'file',${resourceId},'child.bin',${file},'trashed',${bytes.length},${sha(bytes)})`;
  await sql`INSERT INTO file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason) VALUES(${versionId},${childId},${file},${sha(bytes)},${bytes.length},'application/octet-stream','initial')`;
  await sql`UPDATE resources SET current_version_id=${versionId} WHERE id=${childId}`;
 });
 return {label,anchor,resourceId,childId,payloads:[{path:file,sha256:sha(bytes)}],candidate:{kind:'trash',id:resourceId,resourceId,storagePath:root}};
}
/** @param {CaseFixture} f */
async function state(f){
 const ids=[f.resourceId,...(f.childId?[f.childId]:[])];
 const metadata=await databaseClient().withSql(async sql=>({resources:await sql`SELECT to_jsonb(r) AS row FROM resources r WHERE id=ANY(${ids}::uuid[]) ORDER BY id`,versions:await sql`SELECT to_jsonb(v) AS row FROM file_versions v WHERE resource_id=ANY(${ids}::uuid[]) ORDER BY id`,operations:await sql`SELECT to_jsonb(j) AS row FROM operation_journal j WHERE resource_id=ANY(${ids}::uuid[]) ORDER BY id`,pins:await sql`SELECT to_jsonb(a) AS row FROM laboratory_assets a WHERE resource_id=ANY(${ids}::uuid[]) ORDER BY id`,locks:await sql`SELECT lock_key FROM operation_locks WHERE lock_key=${'resource:'+f.resourceId}`}));
 const payloads=[];for(const p of f.payloads)payloads.push({path:p.path,sha256:await hashFile(p.path)});
 /** @type {unknown} */ const encodedMetadata=JSON.parse(JSON.stringify(metadata));
 return {metadata:metadataSnapshot(encodedMetadata),payloads};
}
/** @param {CaseFixture} f @param {PurgeStats} stats @returns {PurgeRepository} */
function scoped(f,stats={}){
 /** @type {PurgeRepository} */ const scopedRepository={listCandidates:async(now,limit)=>(await purgeRepository().listCandidates(now,limit)).filter(c=>c.resourceId===f.resourceId),markPurged:c=>purgeRepository().markPurged(c),withCandidate:(c,now,action)=>purgeRepository().withCandidate(c,now,async()=>{stats.actionCalls=(stats.actionCalls??0)+1;await action();})};
 return scopedRepository;
}
/** @param {string} label @param {Record<string,unknown>} value */
async function save(label,value){observations.push({label,...value});await json(path.join(directory,label+'.json'),value);}

/** @type {Promise<void>[]} */ const testRegistrations=[];
/** @type {[string,VersionOptions,number][]} */
const negatives=[
 ['future-caller-young',{young:true},365*day],['past-caller-young',{young:true},-365*day],
 ['early-legacy-deadline',{early:true},0],['future-caller-early-legacy',{early:true},365*day],
 ['missing-archived-at',{noArchived:true},365*day],['missing-deadline',{noDeadline:true},365*day],['both-timestamps-missing',{noArchived:true,noDeadline:true},365*day],
 ['infinite-archived-at',{infiniteArchived:true},365*day],['infinite-deadline',{infiniteDeadline:true},365*day],['invalid-archive-chronology',{badChronology:true},365*day],
 ['archive-in-future',{futureArchive:true},365*day],['later-explicit-deadline',{lateDeadline:true},365*day],
 ['current-protected',{current:true},365*day],['current-pointer-missing',{noCurrent:true},365*day],
 ['general-count-protected',{count:10},365*day],['markdown-count-protected',{retention:'mastermind_markdown',count:100},365*day],
 ['keepass-protected',{retention:'keepass',count:60},365*day],['immutable-protected',{retention:'laboratory_immutable'},365*day],['pin-protected',{pinned:true},365*day],
];
for(const [label,options,offset] of negatives)testRegistrations.push(test(label+' refuses listing and forced admission without mutation',async()=>{
 const f=await makeVersion(label,options),beforeState=await state(f),caller=new Date(f.anchor+offset);
 const listed=(await purgeRepository().listCandidates(caller,1000)).some(c=>c.id===f.candidate.id);let actionCalls=0;
 const admitted=await purgeRepository().withCandidate(f.candidate,caller,async()=>{actionCalls++;await storageClient().delete(f.candidate.storagePath);await purgeRepository().markPurged(f.candidate);});
 const afterState=await state(f);await save(label,{caller:caller.toISOString(),offset,listed,admitted,actionCalls,before:beforeState,after:afterState,bytesAndMetadataUnchanged:JSON.stringify(beforeState)===JSON.stringify(afterState)});
 assert.equal(listed,false,'DB clock and complete minimum archive age required for listing');assert.equal(admitted,false,'same protection required for forced admission');assert.equal(actionCalls,0);assert.deepEqual(afterState,beforeState);
}));
/** @type {[string,{young?:boolean,keepass?:boolean}][]} */
const trashNegatives=[['trash-future-caller',{young:true}],['trash-keepass',{keepass:true}]];
for(const [label,options] of trashNegatives)testRegistrations.push(test(label+' remains unchanged',async()=>{
 const f=await makeTrash(label,options),caller=new Date(f.anchor+365*day),beforeState=await state(f),listed=(await purgeRepository().listCandidates(caller,1000)).some(c=>c.id===f.candidate.id);let actionCalls=0;
 const admitted=await purgeRepository().withCandidate(f.candidate,caller,()=>{actionCalls++;return Promise.resolve();});const afterState=await state(f);await save(label,{listed,admitted,actionCalls,before:beforeState,after:afterState});assert.equal(listed,false);assert.equal(admitted,false);assert.equal(actionCalls,0);assert.deepEqual(afterState,beforeState);
}));
/** @type {RetentionClass[]} */ const eligibleRetentions=['general','mastermind_markdown','mastermind_attachment'];
for(const retention of eligibleRetentions)for(const direction of ['past','future'])testRegistrations.push(test('eligible '+retention+' is purged using DB time despite '+direction+' caller',async()=>{
 const label='eligible-'+retention+'-'+direction,f=await makeVersion(label,{retention}),caller=new Date(f.anchor+(direction==='past'?-365:365)*day),beforeState=await state(f);
 /** @type {PurgeStats} */
 const stats={};
 const listed=(await purgeRepository().listCandidates(caller,1000)).some(c=>c.id===f.candidate.id),result=await new PurgeService(scoped(f,stats),storageClient(),true).run(caller,1000),afterState=await state(f);
 await save(label,{caller:caller.toISOString(),listed,result,actionCalls:stats.actionCalls??0,before:beforeState,after:afterState});
 assert.equal(listed,true);assert.equal(result.purged,1);assert.equal(stats.actionCalls,1);assert.equal(await storageClient().exists(f.candidate.storagePath),false);
 /** @type {unknown} */ const targetRows=await databaseClient().withSql(sql=>sql`SELECT state FROM file_versions WHERE id=${f.candidate.id}`);const target=firstRow(targetRows);assert.equal(target.state,'expired');
 assert.equal(afterState.metadata.versions.filter(v=>v.row.state==='active').length,VERSION_RETENTION[retention].maximumCount);
 for(const p of f.payloads)if(p.path!==f.candidate.storagePath)assert.equal(await hashFile(p.path),p.sha256);
 assert.deepEqual(afterState.metadata.resources,beforeState.metadata.resources);
}));
testRegistrations.push(test('eligible old trash tree purges despite past caller',async()=>{
 const f=await makeTrash('eligible-old-trash'),caller=new Date(f.anchor-365*day),beforeState=await state(f),result=await new PurgeService(scoped(f),storageClient(),true).run(caller,1000),afterState=await state(f);
 await save(f.label,{result,before:beforeState,after:afterState});assert.equal(result.purged,1);assert.equal(await storageClient().exists(f.candidate.storagePath),false);assert.ok(afterState.metadata.resources.every(r=>r.row.status==='purged'));assert.ok(afterState.metadata.versions.every(v=>v.row.state==='expired'));
}));
for(const applied of [false,true])testRegistrations.push(test('started ordinary purge recovers original operation after delete response loss; applied='+String(applied),async()=>{
 const label='recover-'+String(applied),f=await makeVersion(label),originalDelete=storageClient().delete.bind(storage);let fault=true;
 storageClient().delete=async p=>{if(fault&&p===f.candidate.storagePath){fault=false;if(applied)await originalDelete(p);throw Error('D014 own delete response fault');}return originalDelete(p);};
 let error;try{await new PurgeService(scoped(f),storageClient(),true).run(new Date(f.anchor+365*day),1000);}catch(e){error=errorText(e);}finally{storageClient().delete=originalDelete;}
 const interrupted=await state(f),pending=interrupted.metadata.operations.find(v=>v.row.idempotency_key==='scheduled-purge:version:'+f.candidate.id);
 const result=await new PurgeService(scoped(f),storageClient(),true).run(new Date(f.anchor-365*day),1000),afterState=await state(f);
 await save(label,{error,applied,interrupted,result,after:afterState});assert.match(error??'',/D014 own delete response fault/);assert.equal(pending?.row.state,'storage_committing');assert.equal(result.purged,1);assert.equal(await storageClient().exists(f.candidate.storagePath),false);
 const done=afterState.metadata.operations.filter(v=>v.row.idempotency_key==='scheduled-purge:version:'+f.candidate.id);assert.equal(done.length,1);assert(done[0],'D014 recovered row required');assert.equal(done[0].row.state,'active');
 for(const p of f.payloads)if(p.path!==f.candidate.storagePath)assert.equal(await hashFile(p.path),p.sha256);
}));

// Join every registration only after preserving the complete registration order.
await Promise.all(testRegistrations);
