import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {before,after,test} from 'node:test';

const fixtureFile=process.env.D013_FIXTURE,run=process.env.D013_RUN,entry=process.env.D013_CORE_ENTRY;
if(!fixtureFile||!run||!/^[a-z0-9-]{1,30}$/.test(run)||!entry)throw Error('Explicit owned D013 fixture/run/immutable entry required');
/** @param {unknown} value @param {string} label */
function object(value,label){if(value===null||(typeof value!=='object'&&typeof value!=='function')||Array.isArray(value))throw Error('Invalid '+label);return /** @type {Record<string,unknown>} */(value);}
/** @param {unknown} value @param {string} label */
function text(value,label){if(typeof value!=='string'||!value)throw Error('Invalid '+label);return value;}
/** @param {unknown} value @param {string} label */
function callable(value,label){if(typeof value!=='function')throw Error('Missing callable '+label);return value;}
/** @param {unknown} value @param {string} label */
function integer(value,label){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('Invalid '+label);return value;}
/** @param {unknown} value */
function strings(value){if(!Array.isArray(value))throw Error('Expected string list');return value.map((/** @type {unknown} */ item)=>text(item,'list item'));}
/** @param {Record<string,unknown>} module @param {string} key @param {unknown[]} args */
function construct(module,key,args){
 /** @type {unknown} */
 const value=Reflect.construct(callable(module[key],key),args);
 return object(value,key);
}
/** @param {unknown} target @param {string} key @param {unknown[]} args */
async function invoke(target,key,args){
 const receiver=object(target,key);
 /** @type {unknown} */
 const value=Reflect.apply(callable(receiver[key],key),target,args);
 return await value;
}
/** @param {unknown} fn @param {unknown[]} args */
function apply(fn,args){
 /** @type {unknown} */
 const value=Reflect.apply(callable(fn,'export'),undefined,args);
 return value;
}
/** @param {URL} url */
async function moduleAt(url){
 /** @type {unknown} */
 const loaded=await import(url.href);
 return object(loaded,'module exports');
}
/** @param {unknown} value */
function fixtureShape(value){const row=object(value,'fixture');const fixture={artifactRoot:text(row.artifactRoot,'artifactRoot'),libraries:text(row.libraries,'libraries'),databaseUrl:text(row.databaseUrl,'databaseUrl'),templateDatabase:text(row.templateDatabase,'templateDatabase'),containerId:text(row.containerId,'containerId')};if(!/^[a-z_][a-z0-9_]{0,62}$/.test(fixture.templateDatabase))throw Error('Invalid template database identifier');return fixture;}
/** @type {unknown} */const fixtureValue=JSON.parse((await fs.readFile(fixtureFile,'utf8')).replace(/^\uFEFF/,''));
const fixture=fixtureShape(fixtureValue);
if(!path.resolve(entry).startsWith(path.resolve(fixture.artifactRoot)+path.sep))throw Error('D013 snapshot identity mismatch');
const databaseModule=await moduleAt(pathToFileURL(path.join(fixture.libraries,'packages/database/dist/index.js')));
const storageModule=await moduleAt(pathToFileURL(path.join(fixture.libraries,'packages/storage/dist/index.js')));
const core=await moduleAt(pathToFileURL(entry));
const ROOT_RESOURCE_ID=text(core.ROOT_RESOURCE_ID,'ROOT_RESOURCE_ID'),VERSION_RETENTION=object(core.VERSION_RETENTION,'VERSION_RETENTION');
const NativeDate=globalThis.Date;
/** @param {Uint8Array} bytes */
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
const directory=path.join(fixture.artifactRoot,run),name='ra20261020_rc01_a_d013_'+randomUUID().replaceAll('-','');
const endpoint=new URL(fixture.databaseUrl);endpoint.pathname='/'+name;
/** @type {unknown[]} */const observations=[];
/** @type {Record<string,unknown>|undefined} */
let db;
/** @type {Record<string,unknown>|undefined} */
let storage;
/** @type {Record<string,unknown>|undefined} */
let service;
/** @type {string|undefined} */let parent;
/** @param {string} file @param {unknown} value */
async function json(file,value){
 /** @type {unknown} */
 const serialized=JSON.stringify(value,null,2);
 if(typeof serialized!=='string')throw Error('Missing JSON observation');
 await fs.writeFile(file,serialized+'\n');
}
before(async()=>{
 await fs.mkdir(directory);
 await json(path.join(directory,'OWNERSHIP.json'),{at:new NativeDate().toISOString(),pid:process.pid,database:name,template:fixture.templateDatabase,containerId:fixture.containerId,entry,entrySha256:sha(await fs.readFile(entry)),physicalRoot:path.join(directory,'storage'),method:'Ordinary own database clone; no migration/role/grant/qualification SQL'});
 const admin=construct(databaseModule,'Database',[fixture.databaseUrl,{max:1}]);
 try{await invoke(admin,'withSql',[(/** @type {unknown} */ sql)=>invoke(sql,'unsafe',['CREATE DATABASE '+name+' TEMPLATE '+fixture.templateDatabase])]);}finally{await invoke(admin,'close',[]);}
 db=construct(databaseModule,'Database',[endpoint.toString(),{max:2}]);storage=construct(storageModule,'LocalStorageAdapter',[path.join(directory,'storage')]);await invoke(storage,'initialize',[]);
 service=construct(core,'FileService',[construct(core,'PostgresFileRepository',[db]),storage]);await invoke(service,'initializeStorage',[]);parent=text(object(await invoke(service,'createFolder',[ROOT_RESOURCE_ID,'D013-'+run]),'parent').id,'parent id');
});
after(async()=>{globalThis.Date=NativeDate;await json(path.join(directory,'observations.json'),{run,entry,entrySha256:sha(await fs.readFile(entry)),observations});if(db!==undefined)await invoke(db,'close',[]);if(storage!==undefined)await invoke(storage,'close',[]);});
/** @param {string} name @param {Buffer} bytes */
async function upload(name,bytes){const u=object(await invoke(service,'createUpload',[{parentId:text(parent,'parent id'),filename:name,expectedSize:bytes.length,expectedSha256:sha(bytes),idempotencyKey:'D013-'+randomUUID()}]),'upload');await invoke(service,'appendUpload',[text(u.id,'upload id'),0,bytes.length,Readable.from([bytes])]);return u;}
/** @param {number} skew @param {()=>Promise<unknown>} action */
async function appClock(skew,action){
 // Only no-argument application Date construction is injected. Date.now()
 // stays real for locks/UUIDs; explicit PG timestamp decoding stays unchanged.
 globalThis.Date=new Proxy(NativeDate,{apply(){throw new TypeError('Date construction requires new');},construct(target,args,newTarget){
  /** @type {unknown} */
  const value=Reflect.construct(target,args.length?args:[NativeDate.now()+skew],newTarget);
  if(!(value instanceof NativeDate))throw Error('Invalid native Date construction');
  return value;
 }});
 try{return await action();}finally{globalThis.Date=NativeDate;}
}
/** @param {unknown} value */
function rowList(value){if(!Array.isArray(value))throw Error('Expected SQL rows');return value.map((/** @type {unknown} */ row)=>object(row,'SQL row'));}
/** @param {unknown} sql */
function sqlTag(sql){
 const tag=callable(sql,'SQL tag');
 /** @param {TemplateStringsArray} parts @param {...unknown} values */
 async function query(parts,...values){return rowList(await apply(tag,[parts,...values]));}
 return query;
}
/** @param {(sql:ReturnType<typeof sqlTag>)=>Promise<Record<string,unknown>[]>} action */
async function sqlRows(action){return rowList(await invoke(db,'withSql',[(/** @type {unknown} */ sql)=>action(sqlTag(sql))]));}
/** @param {string} id */
async function rawRows(id){const rows=await sqlRows(sql=>sql`SELECT id,archived_at::text AS archived_at,purge_after::text AS purge_after,state FROM file_versions WHERE resource_id=${id} ORDER BY id`);for(const row of rows){text(row.id,'version id');text(row.state,'version state');if(row.archived_at!==null)text(row.archived_at,'archived_at');if(row.purge_after!==null)text(row.purge_after,'purge_after');}return rows;}
/** @param {unknown} storagePath */
async function bytesAt(storagePath){
 const stream=await invoke(storage,'openRead',[text(storagePath,'storagePath')]);
 if(!(stream instanceof Readable))throw Error('Invalid storage read stream');
 const closed=object(stream,'storage stream').storageClosed;
 if(!(closed instanceof Promise))throw Error('Missing storage close proof');
 /** @type {Buffer[]} */
 const chunks=[];
 for await(const chunk of stream){
  /** @type {unknown} */
  const value=chunk;
  if(!(value instanceof Uint8Array))throw Error('Invalid storage byte chunk');
  chunks.push(Buffer.from(value));
 }
 await closed;
 return Buffer.concat(chunks);
}
/** @param {unknown} value */
function resource(value){const row=object(value,'resource');text(row.id,'resource id');text(row.currentVersionId,'currentVersionId');text(row.storagePath,'resource storagePath');return row;}
/** @type {Promise<void>[]} */const registeredTests=[];
for(const retentionClass of ['general','mastermind_markdown','mastermind_attachment','keepass','laboratory_immutable']){
 for(const operation of ['overwrite','restore'])for(const skew of [-31*86400000,120000]){
  registeredTests.push(test(`${operation} ${retentionClass} app clock offset ${String(skew)} keeps exact archive age and replay`,async()=>{
   const label=retentionClass+'-'+operation+'-'+(skew<0?'behind':'ahead'),filename=label+'.bin';
   const firstBytes=Buffer.from('retained original '+label),nextBytes=Buffer.from('replacement '+label);
   const original=resource(object(await invoke(service,'completeUpload',[(await upload(filename,firstBytes)).id]),'completed upload').resource),originalId=text(original.id,'original id'),originalVersionId=text(original.currentVersionId,'original version id');
   await sqlRows(sql=>sql`UPDATE resources SET retention_class=${retentionClass} WHERE id=${originalId}`); // synthetic own metadata classification, not policy/schema SQL
   const replacement=await upload(filename,nextBytes);/** @type {string} */let archivedId;/** @type {Record<string,unknown>} */let completed;/** @type {()=>Promise<unknown>} */let replay;
   if(operation==='overwrite'){
    archivedId=originalVersionId;completed=resource(object(await appClock(skew,()=>invoke(service,'completeUpload',[replacement.id])),'completed upload').resource);
    replay=()=>invoke(service,'completeUpload',[replacement.id]);
   }else{
    const second=resource(object(await invoke(service,'completeUpload',[replacement.id]),'completed upload').resource);archivedId=text(second.currentVersionId,'second version id');
    const input={idempotencyKey:'D013-restore-'+randomUUID()};
    completed=resource(await appClock(skew,()=>invoke(service,'restoreVersion',[originalId,originalVersionId,input])));
    replay=()=>invoke(service,'restoreVersion',[originalId,originalVersionId,input]);
   }
   const archived=object(await invoke(service,'getVersion',[originalId,archivedId]),'archived version'),current=object(await invoke(service,'getVersion',[originalId,text(completed.currentVersionId,'completed version id')]),'current version');
   const ages=await sqlRows(sql=>sql`SELECT (extract(epoch FROM (purge_after-archived_at))*1000)::text AS age_ms FROM file_versions WHERE id=${archivedId}`);assert.equal(ages.length,1);const age=ages[0];if(age===undefined)throw Error('Missing SQL age row');const sqlAge=age.age_ms;if(sqlAge!==null&&typeof sqlAge!=='string')throw Error('Invalid SQL age value');
   const beforeReplay=JSON.stringify(await rawRows(originalId));await replay();const afterReplay=JSON.stringify(await rawRows(originalId));
   const policy=object(VERSION_RETENTION[retentionClass],'retention policy'),minimumAgeMs=integer(policy.minimumAgeMs,'minimumAgeMs'),maximumCount=integer(policy.maximumCount,'maximumCount');if(typeof policy.automaticPurge!=='boolean')throw Error('Invalid automaticPurge');let eligibleBeforeMinimum=false,eligibleAtMinimum=false;
   if(policy.automaticPurge){
    const archivedAt=archived.archivedAt;if(!(archivedAt instanceof NativeDate))throw Error('Invalid archived timestamp');const archivedVersionId=text(archived.id,'archived version id'),currentVersionId=text(current.id,'current version id');
    /** @type {Record<string,unknown>[]} */
    const ranked=[...Array.from({length:maximumCount},(_,i)=>({...current,id:i===0?currentVersionId:'recorded-newer-'+String(i)})),archived];
    eligibleBeforeMinimum=strings(apply(core.eligibleVersionIds,[ranked,retentionClass,new NativeDate(archivedAt.getTime()+minimumAgeMs-1),currentVersionId])).includes(archivedVersionId);
    eligibleAtMinimum=strings(apply(core.eligibleVersionIds,[ranked,retentionClass,new NativeDate(archivedAt.getTime()+minimumAgeMs),currentVersionId])).includes(archivedVersionId);
   }
   const archivedBytes=await bytesAt(archived.storagePath),activeBytes=await bytesAt(completed.storagePath);
   const record={label,operation,retentionClass,appNewDateOffsetMs:skew,dateNowClockChanged:false,archive:archived,sqlAgeMs:sqlAge,minimumAgeMs,eligibleBeforeMinimum,eligibleAtMinimum,replayUnchanged:beforeReplay===afterReplay,archivedSha256:sha(archivedBytes),activeSha256:sha(activeBytes),currentHasNoDeadline:current.purgeAfter===undefined&&current.archivedAt===undefined};
   observations.push(record);await json(path.join(directory,label+'.json'),record);
   assert.equal(record.replayUnchanged,true);assert.equal(record.currentHasNoDeadline,true);
   assert.equal(sha(archivedBytes),sha(operation==='overwrite'?firstBytes:nextBytes));assert.equal(sha(activeBytes),sha(operation==='overwrite'?nextBytes:firstBytes));
   if(policy.automaticPurge){assert.equal(Number(sqlAge),minimumAgeMs,'deadline is exactly minimumAgeMs after actual PG archived_at');assert.equal(eligibleBeforeMinimum,false,'minimum age must not expire early');assert.equal(eligibleAtMinimum,true);}
   else{assert.equal(sqlAge,null);assert.equal(archived.purgeAfter,undefined);}
  }));
 }
}
await Promise.all(registeredTests);
