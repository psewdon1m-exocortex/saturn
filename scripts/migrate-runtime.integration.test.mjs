import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';

// Explicit owned fixture only: never discover or fall back to a working DB.
const fixtureFile=process.env.SATURN_MIGRATION_TEST_FIXTURE;
if(!fixtureFile)throw Error('SATURN_MIGRATION_TEST_FIXTURE is required for this isolated integration suite');
const fixture=JSON.parse((await fs.readFile(fixtureFile,'utf8')).replace(/^\uFEFF/,''));
const run=process.env.SATURN_MIGRATION_TEST_RUN;
const target=process.env.SATURN_MIGRATION_TEST_SCRIPT;
if(!run||!/^[a-z0-9-]{1,40}$/.test(run)||!target||!path.isAbsolute(target))throw Error('Explicit run identity and absolute script snapshot required');
const owned=path.resolve(fixture.artifactRoot),output=path.join(owned,run);
if(!path.resolve(target).startsWith(owned+path.sep)||!fixture.databaseUrl.startsWith('postgres://postgres@127.0.0.1:55431/')||fixture.sftp.host!=='127.0.0.1'||fixture.sftp.port!==55432)throw Error('Owned loopback fixture identity mismatch');
await fs.mkdir(output);
const library=relative=>import(pathToFileURL(path.join(fixture.frozenLibraries,relative)).href);
const {Database,migrate}=await library('packages/database/dist/index.js');
const {SftpStorageAdapter,migrateStorageLayout}=await library('packages/storage/dist/index.js');
const {encodeOwnerAccessKey}=await library('packages/config/dist/index.js');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const scriptSha=sha(await fs.readFile(target));
const secret=await fs.readFile(fixture.sftp.passwordFile,'utf8');
const results=[];
const json=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n');
async function save(){await json(path.join(output,'results.json'),{run,target,scriptSha,fixtureFile,method:'Actual owned PostgreSQL + SFTP physical temporary directories; custom ordinary SQL only',results});}
await save();

async function provision(label,layout='v3'){
 const identity=randomUUID().replaceAll('-',''),databaseName='ra20261020_rc01_a_s02_'+identity;
 const directory=path.join(output,label),physical=path.join(fixture.sftp.physicalRoot,identity);
 await fs.mkdir(directory);await fs.mkdir(path.join(directory,'private'));
 const owner={created:new Date().toISOString(),databaseName,physical,directory,sftpContainer:fixture.sftp.containerId,postgresContainer:fixture.postgresContainer,remoteRoot:'upload/'+identity,processes:[],proxies:[]};
 await json(path.join(directory,'OWNERSHIP.json'),owner); // before DB/filesystem operations
 await fs.mkdir(physical);
 const base=new Database(fixture.databaseUrl,{max:1});
 try{await base.withSql(sql=>sql.unsafe('CREATE DATABASE '+databaseName));}finally{await base.close();}
 const url=new URL(fixture.databaseUrl);url.pathname='/'+databaseName;
 const storageConfig={host:fixture.sftp.host,port:fixture.sftp.port,username:fixture.sftp.username,root:owner.remoteRoot,hostFingerprint:fixture.sftp.hostFingerprint,authMode:'password_file',passwordFile:fixture.sftp.passwordFile,operationTimeoutMs:10000,healthTimeoutMs:2500,maxConnections:2,requireFsync:true};
 const storage=new SftpStorageAdapter(storageConfig);
 const bytes=Buffer.from('ordinary migration payload '+identity);
 try{
  if(layout!=='empty'){
   await migrateStorageLayout(storage,'up');if(layout==='v2')await migrateStorageLayout(storage,'down');
   await storage.write((layout==='v2'?'drop point':'# drop point')+'/payload.bin',Readable.from([bytes]),{offset:0,create:true,exclusive:true});
  }
 }finally{await storage.close();}
 const runtime=path.join(directory,'runtime'),migrationDir=path.join(runtime,'api/node_modules/@saturn/database/migrations');await fs.mkdir(migrationDir,{recursive:true});
 const trace=path.join(directory,'runtime-trace.jsonl');
 const traceCode=`const trace=async event=>fs.appendFile(${JSON.stringify(trace)},JSON.stringify({...event,at:new Date().toISOString()})+'\\n');`;
 for(const module of ['config','database','storage']){
  const pkg=path.join(runtime,'api/node_modules/@saturn',module);await fs.mkdir(path.join(pkg,'dist'),{recursive:true});await json(path.join(pkg,'package.json'),{type:'module'});
  const real=pathToFileURL(path.join(fixture.frozenLibraries,'packages',module,'dist/index.js')).href;
  let source=`export * from ${JSON.stringify(real)};\n`;
  if(module==='storage')source=`import fs from 'node:fs/promises';import {SftpStorageAdapter as Real,migrateStorageLayout as layout} from ${JSON.stringify(real)};${traceCode}
export class SftpStorageAdapter extends Real {async close(){try{return await super.close();}finally{await trace({event:'storage-close'});}}}
export async function migrateStorageLayout(storage,direction){await trace({event:'layout-call',direction});const result=await layout(storage,direction);await trace({event:'layout-result',direction,result});return result;}
`;
  await fs.writeFile(path.join(pkg,'dist/index.js'),source);
 }
 const env={NODE_ENV:'test',LOG_LEVEL:'silent',DATABASE_URL:url.toString(),PUBLIC_ORIGIN:'http://127.0.0.1:55432',VAULT_RUNTIME_ROOT:runtime,
 STORAGE_BACKEND:'sftp',STORAGE_HOST:'127.0.0.1',STORAGE_PORT:'55432',STORAGE_USER:storageConfig.username,STORAGE_ROOT:storageConfig.root,STORAGE_HOST_FINGERPRINT:storageConfig.hostFingerprint,STORAGE_AUTH_MODE:'password_file',STORAGE_PASSWORD_FILE:storageConfig.passwordFile,STORAGE_PRIVATE_KEY_FILE:'',
 STORAGE_OPERATION_TIMEOUT_MS:'10000',STORAGE_HEALTH_TIMEOUT_MS:'2500',READINESS_TIMEOUT_MS:'3000',STORAGE_MAX_CONNECTIONS:'2',STORAGE_REQUIRE_FSYNC:'true',STORAGE_RUNTIME_CONFIG_DIR:path.join(directory,'storage-runtime'),
 KERNEL_URL:'',KERNEL_TOKEN_FILE:'',DROP_BUFFER_DIRECTORY:path.join(directory,'drop'),RECOVERY_SPOOL_DIR:path.join(directory,'spool'),RECOVERY_ARCHIVE_DIR:path.join(directory,'archive'),ARCHIVE_SPOOL_DIR:path.join(directory,'archive-spool')};
 for(const key of ['OWNER_BOOTSTRAP_TOKEN_FILE','AUTH_PEPPER_FILE','DEVICE_PEPPER_FILE','DROP_PEPPER_FILE','SHARE_PEPPER_FILE','BACKUP_PEPPER_FILE','LABORATORY_PEPPER_FILE']){
  const file=path.join(directory,'private',key);await fs.writeFile(file,key==='OWNER_BOOTSTRAP_TOKEN_FILE'?encodeOwnerAccessKey(randomUUID()):randomUUID()+randomUUID(),{mode:0o600});env[key]=file;
 }
 const db=new Database(url.toString(),{max:1});
 return {label,directory,physical,owner,db,url:url.toString(),storageConfig,bytes,migrationDir,env,trace,
  async close(){await db.close();}};
}
async function files(f,late=false){
 await fs.writeFile(path.join(f.migrationDir,'0001_ordinary.up.sql'),`CREATE TABLE fixture_catalog(id integer PRIMARY KEY,storage_path text NOT NULL);INSERT INTO fixture_catalog VALUES(1,'# drop point/payload.bin');`);
 await fs.writeFile(path.join(f.migrationDir,'0001_ordinary.down.sql'),'DROP TABLE fixture_catalog;');
 if(late){await fs.writeFile(path.join(f.migrationDir,'0002_ordinary_dependency.up.sql'),"INSERT INTO fixture_resume_gate(mark) VALUES('completed');");await fs.writeFile(path.join(f.migrationDir,'0002_ordinary_dependency.down.sql'),"DELETE FROM fixture_resume_gate WHERE mark='completed';");}
}
async function invoke(f,tag='first',override={}){
 const child=spawn(process.execPath,[target],{cwd:f.directory,windowsHide:true,env:{...process.env,...f.env,...override},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
 f.owner.processes.push({pid:child.pid,spawnedAt:new Date().toISOString(),executable:process.execPath,script:target,scriptSha,tag});await json(path.join(f.directory,'OWNERSHIP.json'),f.owner);
 const timeout=setTimeout(()=>child.kill(),30000);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}).finally(()=>clearTimeout(timeout));
 stdout=stdout.replaceAll(secret,'[redacted]');stderr=stderr.replaceAll(secret,'[redacted]');
 await fs.writeFile(path.join(f.directory,tag+'.stdout.log'),stdout);await fs.writeFile(path.join(f.directory,tag+'.stderr.log'),stderr);
 const value={tag,exitCode:code,stdout,stderr};await json(path.join(f.directory,tag+'.exit.json'),{tag,exitCode:code,scriptSha});return value;
}
async function observe(f,tag){
 const ledger=await f.db.withSql(async sql=>{
  if(!(await sql`SELECT to_regclass('public._vault_migrations') AS table_name`)[0].table_name)return [];
  return sql`SELECT name FROM _vault_migrations ORDER BY name`;
 });
 let marker;try{marker=JSON.parse(await fs.readFile(path.join(f.physical,'_system/storage-layout-v3.json'),'utf8'));}catch(error){marker={error:error.code};}
 const trace=await fs.readFile(f.trace,'utf8').then(t=>t.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(()=>[]);
 const catalog=await f.db.withSql(async sql=>{if(!(await sql`SELECT to_regclass('public.fixture_catalog') AS table_name`)[0].table_name)return [];return sql`SELECT id,storage_path FROM fixture_catalog ORDER BY id`;});
 const value={tag,ledger,catalog,marker,trace,expectedPhysicalPayload:await fs.readFile(path.join(f.physical,'# drop point/payload.bin')).then(b=>({sha256:sha(b),bytes:b.length})).catch(e=>({error:e.code}))};
 await json(path.join(f.directory,tag+'.oracle.json'),value);return value;
}
async function verifyReadback(f){const s=new SftpStorageAdapter(f.storageConfig);try{const stream=await s.openRead('# drop point/payload.bin'),chunks=[];for await(const bytes of stream)chunks.push(Buffer.from(bytes));await stream.storageClosed;assert.equal(sha(Buffer.concat(chunks)),sha(f.bytes));}finally{await s.close();}}
function failureOracle(f,result,state,{noOp=false,commits=1}={}){
 assert.notEqual(result.exitCode,0);assert.match(result.stderr,/fixture_resume_gate|CONNECTION|connection|closed|terminated/i);
 assert.equal(state.ledger.length,commits,'completed SQL files and ledger remain committed');
 assert.deepEqual(Array.from(state.catalog,row=>({id:row.id,storage_path:row.storage_path})),[{id:1,storage_path:'# drop point/payload.bin'}],'committed ordinary row agrees with retained physical target');
 assert.equal(state.marker.version,3,'SQL failure must not downgrade physical layout');
 assert.equal(state.expectedPhysicalPayload.sha256,sha(f.bytes));
 assert.equal(state.trace.filter(x=>x.event==='layout-call'&&x.direction==='down').length,0,'no automatic physical down after SQL failure');
 assert.equal(state.trace.filter(x=>x.event==='storage-close').length,1,'storage closed on error');
 if(noOp)assert.deepEqual(state.trace.find(x=>x.event==='layout-result'&&x.direction==='up').result.actions,[]);
 assert.match(result.stderr,/migration_failed_state_preserved/);
}
function successful(result){const line=result.stdout.trim().split(/\r?\n/).findLast(line=>line.startsWith('{"direction":"up"'));assert.ok(line,'terminal migration JSON exists despite PostgreSQL notices');return JSON.parse(line);}
async function retry(f){await f.db.withSql(sql=>sql`CREATE TABLE fixture_resume_gate(mark text)`);const result=await invoke(f,'retry');assert.equal(result.exitCode,0,result.stderr);assert.equal(successful(result).applied,1);const state=await observe(f,'retry');assert.equal(state.marker.version,3);assert.equal(state.ledger.length,2);assert.equal((await f.db.withSql(sql=>sql`SELECT count(*)::int AS n FROM fixture_catalog`))[0].n,1);await verifyReadback(f);}

async function loseCommitAcknowledgement(f){
 const sockets=new Set(),events=[];let dropped=false;
 const server=net.createServer(client=>{
  const upstream=net.connect(55431,'127.0.0.1');sockets.add(client);sockets.add(upstream);let buffer=Buffer.alloc(0);
  client.on('data',bytes=>upstream.write(bytes));client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
  upstream.on('data',bytes=>{
   buffer=Buffer.concat([buffer,bytes]);if(buffer.length>4194304){client.destroy();upstream.destroy();return;}
   while(buffer.length>=5){const length=buffer.readInt32BE(1);if(length<4||length>4194300){client.destroy();upstream.destroy();return;}if(buffer.length<length+1)return;
    const frame=buffer.subarray(0,length+1);buffer=buffer.subarray(length+1);
    if(!dropped&&frame[0]===67&&frame.subarray(5).toString('utf8').startsWith('COMMIT')){
     dropped=true;events.push({at:new Date().toISOString(),event:'actual-server-COMMIT-completion-observed-and-not-forwarded'});client.destroy();upstream.destroy();return;
    }
    client.write(frame);
   }
  });
  client.on('close',()=>{sockets.delete(client);upstream.destroy();});upstream.on('close',()=>{sockets.delete(upstream);client.destroy();});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();f.owner.proxies.push({host:'127.0.0.1',port:address.port,target:'127.0.0.1:55431',purpose:'one suppressed COMMIT ACK',created:new Date().toISOString()});await json(path.join(f.directory,'OWNERSHIP.json'),f.owner);
 return {url:f.url.replace(':55431/',':'+address.port+'/'),events,get dropped(){return dropped;},async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await json(path.join(f.directory,'commit-ack-fault.json'),{dropped,events});}};
}
async function scenario(label,action){let f;const record={label,started:new Date().toISOString()};try{f=await action.fixture();record.directory=f.directory;await action.run(f);record.status='PASS';}catch(error){record.status='FAIL';record.error=String(error);throw error;}finally{await f?.close();record.finished=new Date().toISOString();results.push(record);await save();}}

test('existing v3 no-op plus SQL failure preserves storage and ledger, then resumes same originals',async()=>scenario('existing-v3',{fixture:()=>provision('existing-v3'),run:async f=>{await files(f);await migrate(f.url,f.migrationDir);await files(f,true);const result=await invoke(f),state=await observe(f,'first');failureOracle(f,result,state,{noOp:true});await verifyReadback(f);await retry(f);}}));
test('early SQL commit plus later failure preserves v3 physical paths and resumes the same ledger',async()=>scenario('partial-chain',{fixture:()=>provision('partial-chain','v2'),run:async f=>{await files(f,true);const result=await invoke(f),state=await observe(f,'first');failureOracle(f,result,state);assert.ok(state.trace.find(x=>x.event==='layout-result'&&x.direction==='up').result.actions.length);await verifyReadback(f);await retry(f);}}));
test('uncertain COMMIT acknowledgement preserves actual committed ledger and storage without automatic down',async()=>scenario('commit-unknown',{fixture:()=>provision('commit-unknown'),run:async f=>{await files(f);const proxy=await loseCommitAcknowledgement(f);let result;try{result=await invoke(f,'first',{DATABASE_URL:proxy.url});}finally{await proxy.close();}assert.equal(proxy.dropped,true,'actual PostgreSQL COMMIT ACK suppressed');const state=await observe(f,'first');failureOracle(f,result,state,{noOp:true});await verifyReadback(f);const again=await invoke(f,'retry');assert.equal(again.exitCode,0,again.stderr);assert.equal(successful(again).applied,0);assert.equal((await observe(f,'retry')).ledger.length,1);await verifyReadback(f);}}));
test('first install succeeds and no-op retry preserves ledger and newly stored bytes',async()=>scenario('first-install',{fixture:()=>provision('first-install','empty'),run:async f=>{await files(f);const first=await invoke(f);assert.equal(first.exitCode,0,first.stderr);assert.equal(successful(first).applied,1);const storage=new SftpStorageAdapter(f.storageConfig);try{await storage.write('# drop point/payload.bin',Readable.from([f.bytes]),{offset:0,create:true,exclusive:true});}finally{await storage.close();}const again=await invoke(f,'retry');assert.equal(again.exitCode,0,again.stderr);assert.equal(successful(again).applied,0);const state=await observe(f,'retry');assert.equal(state.marker.version,3);assert.equal(state.ledger.length,1);assert.equal(state.trace.filter(x=>x.event==='storage-close').length,2);await verifyReadback(f);}}));
test('ordinary successful v2 up migrates once and closes storage',async()=>scenario('successful-up',{fixture:()=>provision('successful-up','v2'),run:async f=>{await files(f);const first=await invoke(f);assert.equal(first.exitCode,0,first.stderr);assert.equal(successful(first).applied,1);const state=await observe(f,'first');assert.equal(state.marker.version,3);assert.equal(state.ledger.length,1);assert.equal(state.trace.filter(x=>x.event==='storage-close').length,1);await verifyReadback(f);}}));
test('physical preflight failure does not start SQL migration and still closes storage',async()=>scenario('physical-preflight',{fixture:()=>provision('physical-preflight'),run:async f=>{await files(f);await fs.mkdir(path.join(f.physical,'drop point'));await fs.writeFile(path.join(f.physical,'drop point','collision.bin'),'fixture collision');const first=await invoke(f);assert.notEqual(first.exitCode,0);const state=await observe(f,'first');assert.equal(state.ledger.length,0);assert.equal(state.trace.filter(x=>x.event==='storage-close').length,1);assert.equal(state.expectedPhysicalPayload.sha256,sha(f.bytes));}}));
