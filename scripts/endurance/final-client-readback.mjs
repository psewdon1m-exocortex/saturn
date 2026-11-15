// Read-only final scrub of retained real-client fixture catalogs and backend bytes.
// This supplements, and does not replace, each scenario's input-manifest proof.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const root='C:/.projects/exocortex',base=root+'/.audit/2026-10-15/endurance-6h';
const read=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
const current=await read(base+'/current.json');
assert.equal(current.active,null,'Drain the admitted cycle first');
assert.equal(current.deadline,'2026-10-15T05:17:32.103Z','Preserve the frozen six-hour boundary');
assert(Date.now()>=Date.parse(current.deadline),'Final readback requires the original deadline');
assert.equal(current.runId,'f3f55c75-dcd4-4354-adae-7e781f98cf54');
const manifest=await read(base+'/private/sync-fixture.json');
const exec=promisify(execFile);
const [container]=JSON.parse((await exec('docker',['inspect',manifest.containerId],{windowsHide:true})).stdout);
assert.equal(container.Id,manifest.containerId);
assert.equal(container.Created,manifest.created);
assert.equal(container.Config.Labels['exocortex.sync-performance.run'],current.runId);
assert.equal(manifest.runId,current.runId);
assert(container.State.Running);
const databaseUrl=new URL(manifest.databaseUrl);
assert.equal(databaseUrl.hostname,'127.0.0.1');
assert.equal(container.NetworkSettings.Ports['5432/tcp'][0].HostPort,databaseUrl.port);
const require=createRequire(root+'/saturn/packages/database/package.json');
const postgres=require('postgres');
const fixtures=new Map();
for(const cycle of await fs.readdir(base+'/cycles')) {
  if(!/^cycle-\d+$/.test(cycle))continue;
  const lane=path.join(base,'cycles',cycle,'SYNC');
  for(const attempt of await fs.readdir(lane).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
    if(!/^attempt-\d+$/.test(attempt))continue;
    for(const kind of ['windows','pluto']) {
      const directory=path.join(lane,attempt,'completion-'+kind);
      for(const file of await fs.readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
        if(!/^fixture-[a-f0-9]{32}\.json$/.test(file))continue;
        const evidence=path.join(directory,file),f=await read(evidence);
        assert.match(f.name,/^stage3_[a-f0-9]{32}$/);
        assert.equal(f.runId,current.runId);assert.equal(f.containerId,manifest.containerId);
        assert.equal(path.resolve(f.directory),path.resolve(manifest.fixtureDirectory,f.name));
        const previous=fixtures.get(f.name);
        if(previous)assert.equal(path.resolve(previous.directory),path.resolve(f.directory));
        else fixtures.set(f.name,{...f,kind,evidence});
      }
    }
  }
}
assert(fixtures.size>0,'No retained client fixtures');
const report={runId:current.runId,startedAt:new Date().toISOString(),status:'RUNNING',
  scope:'All active resource files and all active file_versions in every retained completion-windows/pluto database. Exact backend SHA/size compared with its frozen catalog. Scenario input manifests, expected deletions and failed-original recovery remain separate evidence; this scrub does not infer them.',
  expectedDatabases:fixtures.size,databases:[],failures:[],verifiedReferences:0,uniquePhysicalReads:0,bytes:0};
const out=base+'/final-client-readback.json';let saves=Promise.resolve();
await fs.mkdir(base+'/final-client-catalogs',{recursive:true});
function save(){const body=JSON.stringify(report,null,2);saves=saves.then(async()=>{await fs.writeFile(out+'.tmp',body);await fs.rename(out+'.tmp',out);});return saves;}
async function backendPath(storageRoot,storagePath){
  assert.equal(typeof storagePath,'string');assert(storagePath.length>0);
  assert(!storagePath.startsWith('/')&&!/^[A-Za-z]:/.test(storagePath)&&!/[\\\x00-\x1f]/.test(storagePath));
  const segments=storagePath.split('/');assert(segments.every(x=>x&&x!=='.'&&x!=='..'));
  const absolute=path.resolve(storageRoot,...segments);
  assert(absolute.startsWith(storageRoot+path.sep),'Path escaped storage root');
  const real=await fs.realpath(absolute);assert(real.startsWith(storageRoot+path.sep),'Symlink escaped storage root');
  return real;
}
await save();
for(const fixture of fixtures.values()) {
  const detail={name:fixture.name,kind:fixture.kind,evidence:fixture.evidence,status:'RUNNING',verified:0,uniqueReads:0,bytes:0,failures:[]};report.databases.push(detail);
  const url=new URL(databaseUrl);url.pathname='/'+fixture.name;
  // All statements, including future accidental writes, are fenced by read-only mode.
  const sql=postgres(url.toString(),{max:1,connect_timeout:15,connection:{default_transaction_read_only:'on',statement_timeout:30000,application_name:'endurance-final-readback'}});
  try {
    const snapshot=await sql.begin('isolation level repeatable read read only',async tx=>({
      resources:await tx`SELECT id,storage_path,sha256,size_bytes,current_version_id FROM resources WHERE type='file' AND status='active' ORDER BY id`,
      versions:await tx`SELECT id,resource_id,state,storage_path,sha256,size_bytes FROM file_versions ORDER BY id`
    }));
    detail.catalogSha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    detail.catalogEvidence=base+'/final-client-catalogs/'+fixture.name+'.json';
    await fs.writeFile(detail.catalogEvidence,JSON.stringify(snapshot,null,2));
    detail.activeResources=snapshot.resources.length;detail.versionStates={};
    for(const v of snapshot.versions)detail.versionStates[v.state]=(detail.versionStates[v.state]??0)+1;
    const versions=new Map(snapshot.versions.map(v=>[v.id,v]));
    for(const r of snapshot.resources){const v=versions.get(r.current_version_id);assert(v&&v.state==='active','Current resource version missing/inactive: '+r.id);assert.equal(v.resource_id,r.id);assert.equal(v.sha256,r.sha256);assert.equal(String(v.size_bytes),String(r.size_bytes));}
    const storageRoot=await fs.realpath(path.join(fixture.directory,'storage'));
    assert(storageRoot.startsWith(path.resolve(manifest.fixtureDirectory)+path.sep));
    const references=[...snapshot.resources.map(r=>({...r,kind:'resource'})),...snapshot.versions.filter(v=>v.state==='active').map(v=>({...v,kind:'version'}))];
    detail.expectedReferences=references.length;
    const physical=new Map();let next=0;
    await Promise.all(Array.from({length:4},async()=>{while(next<references.length){const row=references[next++];try{
      assert.match(row.sha256,/^[a-f0-9]{64}$/);assert(Number.isSafeInteger(Number(row.size_bytes))&&Number(row.size_bytes)>=0);
      const key=row.storage_path;let operation=physical.get(key);
      if(!operation){operation=(async()=>{const actual=await backendPath(storageRoot,key);const hash=createHash('sha256');let size=0;for await(const chunk of createReadStream(actual)){hash.update(chunk);size+=chunk.length;}detail.uniqueReads++;detail.bytes+=size;report.uniquePhysicalReads++;report.bytes+=size;return{sha256:hash.digest('hex'),size};})();physical.set(key,operation);}
      const actual=await operation;assert.equal(actual.sha256,row.sha256);assert.equal(String(actual.size),String(row.size_bytes));detail.verified++;report.verifiedReferences++;
    }catch(error){const failure={kind:row.kind,id:row.id,storagePath:row.storage_path,error:String(error)};detail.failures.push(failure);report.failures.push({database:fixture.name,...failure});}
    if((detail.verified+detail.failures.length)%512===0){await save();console.log(JSON.stringify({database:fixture.name,verified:detail.verified,total:references.length,failures:detail.failures.length}));}
    }}));
    detail.status=detail.failures.length===0&&detail.verified===references.length?'PASS':'FAIL';
  }catch(error){detail.status='FAIL';detail.error=String(error);report.failures.push({database:fixture.name,error:String(error)});}
  finally{await sql.end({timeout:5});detail.finishedAt=new Date().toISOString();await save();}
}
report.status=report.failures.length===0&&report.databases.every(d=>d.status==='PASS')?'PASS':'FAIL';report.finishedAt=new Date().toISOString();await save();
console.log(JSON.stringify({status:report.status,databases:report.databases.length,verifiedReferences:report.verifiedReferences,bytes:report.bytes,failures:report.failures.length}));
if(report.status!=='PASS')process.exitCode=1;
