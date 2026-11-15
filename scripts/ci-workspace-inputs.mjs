// Disposable source-CI inputs. Never adopts a development or production stand.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {createIsolation,OwnedDocker} from './stage13-runtime.mjs';
import {runCommand} from './stage13-command.mjs';
import {redactEvidence} from './ci-workspace-accounting.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const nodeImage='node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43';
const pgImage='postgres:18.1-alpine@sha256:aa6eb304ddb6dd26df23d05db4e5cb05af8951cda3e0dc57731b771e0ef4ab29';
const sftpImage='atmoz/sftp:alpine@sha256:81fa92512bf8ead4849f33c1c153907b86d32d77704d1c62a9c70b4316ae9e50';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const shellLiteral=value=>"'"+value.replaceAll("'", "'\"'\"'")+"'";
const put=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const args=process.argv.slice(2);
const postgresSuite=args.length===1&&args[0]==='--postgres-suite';
assert(postgresSuite||args.length>=2&&args[0]==='--','Use -- COMMAND ARGS, or --postgres-suite');
assert.equal(process.platform,'linux','Automatic CI input provisioning requires Linux; Windows qualification uses explicitly owned native inputs');
const isolated=createIsolation({namespace:'saturn-ci-'+randomBytes(8).toString('hex')});
fs.chmodSync(isolated.root,0o700);
const owner=new OwnedDocker({...isolated,cwd:repo,docker:process.env.DOCKER_BIN});
owner.budgets.wallClockMs=90*60_000;owner.persist();
const root=isolated.root,namespace=isolated.namespace,secrets=[],fixtureDirectory=path.join(root,'fixtures'),evidence=path.join(root,'evidence');
for(const dir of [fixtureDirectory,evidence,path.join(root,'ancestor'),path.join(root,'completion')])fs.mkdirSync(dir,{mode:0o700});
let k4Id,k4Stop,child,closure,problem;
const command=(exe,argv,env=process.env,timeout=180000)=>runCommand(exe,argv,{root,cwd:repo,env,encoding:'utf8',timeout});
try{
  const password=randomBytes(24).toString('hex');secrets.push(password);
  const pgEnv=path.join(root,'postgres.env');fs.writeFileSync(pgEnv,'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD='+password+'\nPOSTGRES_DB=postgres\n',{flag:'wx',mode:0o600});
  const pgId=owner.createRun(['-d','--name',namespace+'-postgres','--memory','512m','--cpus','1','--pids-limit','256','-p','127.0.0.1::5432','--env-file',pgEnv,'--label','exocortex.sync-performance.run='+namespace,pgImage,'postgres','-c','shared_preload_libraries=pg_stat_statements','-c','pg_stat_statements.track=all'],process.env).stdout.trim();
  let ready=false;for(let n=0;n<120;n++){if(owner.cli(['exec',pgId,'pg_isready','-U','postgres','-d','postgres'],{allowFailure:true}).status===0){ready=true;break;}await pause(250);}assert(ready,'Own PostgreSQL did not become ready');
  const pg=owner.checked('container',pgId).observed,pgPort=pg.NetworkSettings.Ports['5432/tcp'];assert.equal(pgPort.length,1);assert.equal(pgPort[0].HostIp,'127.0.0.1');
  const url='postgresql://postgres:'+password+'@127.0.0.1:'+pgPort[0].HostPort+'/postgres';
  const fixtureFile=path.join(root,'postgres.private.json');
  put(fixtureFile,{containerId:pg.Id,created:pg.Created,runId:namespace,databaseUrl:url,fixtureDirectory,resourceBudget:{nanoCpus:1e9,memoryBytes:536870912}});
  owner.cli(['exec',pgId,'psql','-XAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c','CREATE DATABASE saturn_ci']);
  const base=new URL(url);base.pathname='/saturn_ci';
  const environment={...process.env,STAGE3_CHAT_A_FIXTURE:fixtureFile,STAGE3_CHAT_A_EVIDENCE:evidence,ACCEPTANCE_A_DATABASE_URL:url,ACCEPTANCE_A_EVIDENCE:path.join(root,'ancestor'),COMPLETION_EVIDENCE:path.join(root,'completion'),STAGE3_CHAT_A_PERFORMANCE:'isolated',SATURN_CATALOG_INTEGRATION:'1',SATURN_CI_INPUTS_MANAGED:'1'};
  for(const name of ['DATABASE_URL','PIPELINE_TEST_DATABASE_URL','STORAGE_SETTINGS_TEST_DATABASE_URL','PLUTO_TEST_DATABASE_URL','DEVICE_TEST_DATABASE_URL','POLICY_TEST_DATABASE_URL','SATURN_HOST_RECOVERY_TEST_DATABASE_URL'])environment[name]=base.toString();

  const host=path.join(evidence,'linux-host');fs.mkdirSync(host,{mode:0o755});
  const sources=['apps/api/src/stage3-chat-a.verifier-linux.mts','packages/contracts/src/storage-verifier.ts','packages/contracts/src/sync-protocol.ts','packages/contracts/src/require-defined.ts','packages/storage/src/storage-verifier.client.ts',...['authority','index','main','secure-files','server','verifier'].map(name=>'packages/storage-verifier/src/'+name+'.ts')];
  const hashes=[];
  for(const name of sources){const source=path.join(repo,name),bytes=fs.readFileSync(source),target=path.join(host,name.replace(/\.mts$/,'.mjs').replace(/\.ts$/,'.js'));fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o755});
    const compiled=ts.transpileModule(bytes.toString('utf8'),{fileName:name,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});fs.writeFileSync(target,compiled.outputText,{flag:'wx',mode:0o644});hashes.push({file:source,sha256:hash(bytes)});}
  put(path.join(host,'source-hashes.json'),hashes);fs.writeFileSync(path.join(host,'package.json'),'{"type":"module"}\n',{flag:'wx',mode:0o644});
  const output=path.join(host,'result.json');fs.writeFileSync(output,'{}\n',{flag:'wx',mode:0o666});
  fs.chmodSync(output,0o666); // The unprivileged K4 UID writes this dedicated result mount.
  const control=path.join(root,'k4-control');fs.mkdirSync(control,{mode:0o755});const nonce=randomBytes(20).toString('hex');k4Stop={file:path.join(control,'stop'),nonce};
  const loop="import fs from 'node:fs';for(;;){if(fs.existsSync('/control/stop')){if(fs.readFileSync('/control/stop','utf8')!=="+JSON.stringify(nonce)+")throw Error('Wrong own stop authority');break;}await new Promise(r=>setTimeout(r,100));}\n";
  fs.writeFileSync(path.join(host,'control.mjs'),loop,{flag:'wx',mode:0o644});
  const k4Args=['-d','--name',namespace+'-k4','--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','256m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777','--label','exocortex.sync-performance.run='+namespace,'-w','/work'];
  for(const name of ['apps','packages','package.json','control.mjs'])k4Args.push('-v',path.join(host,name)+':/work/'+name+':ro');
  k4Args.push('-v',output+':/work/result.json','-v',control+':/control:ro','--entrypoint','/usr/local/bin/node',nodeImage,'/work/control.mjs');
  k4Id=owner.createRun(k4Args,process.env).stdout.trim();const k4=owner.checked('container',k4Id).observed;
  put(path.join(host,'fixture.json'),{containerId:k4.Id,created:k4.Created,runId:namespace,image:k4.Image});fs.chmodSync(path.join(host,'fixture.json'),0o644);

  const keys=path.join(root,'hostkeys');fs.mkdirSync(keys,{mode:0o700});const key=path.join(keys,'ssh_host_ed25519_key');
  const generated=command('ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);assert.equal(generated.status,0,'Own SFTP key generation failed');
  const publicKey=fs.readFileSync(key+'.pub','utf8').trim().split(/\s+/)[1];const fingerprint='SHA256:'+createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('base64').replace(/=+$/,'');
  const sftpPassword=randomBytes(20).toString('hex');secrets.push(sftpPassword);const passwordFile=path.join(root,'sftp.password'),users=path.join(root,'users.conf'),bootstrap=path.join(root,'sftp-bootstrap.sh');
  fs.writeFileSync(passwordFile,sftpPassword,{flag:'wx',mode:0o600});fs.writeFileSync(users,'vault:'+sftpPassword+':1001:1001:gateway\n',{flag:'wx',mode:0o600});
  fs.writeFileSync(bootstrap,'#!/bin/sh\nset -eu\nmkdir -p /home/vault/gateway\nchown 1001:1001 /home/vault/gateway\ncp /hostkeys/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key\nchmod 0600 /etc/ssh/ssh_host_ed25519_key\nexec /entrypoint\n',{flag:'wx',mode:0o644});
  const sftpScope='source-ci-native-sftp',sftpId=owner.createRun(['-d','--name',namespace+'-sftp','--memory','256m','--cpus','1','--pids-limit','128','--label','exocortex.release.run='+namespace,'--label','exocortex.functional.scope='+sftpScope,'-p','127.0.0.1::22','-v',keys+':/hostkeys:ro','-v',users+':/etc/sftp/users.conf:ro','-v',bootstrap+':/input/bootstrap.sh:ro','--entrypoint','sh',sftpImage,'/input/bootstrap.sh'],process.env).stdout.trim();
  ready=false;for(let n=0;n<100;n++){assert(owner.checked('container',sftpId).observed.State.Running,'Own SFTP stopped during startup');const logs=owner.cli(['logs',sftpId],{allowFailure:true});if((logs.stdout+logs.stderr).includes('Server listening')){ready=true;break;}await pause(200);}assert(ready,'Own SFTP did not become ready');
  const sf=owner.checked('container',sftpId).observed,port=sf.NetworkSettings.Ports['22/tcp'];assert.equal(port.length,1);assert.equal(port[0].HostIp,'127.0.0.1');
  const sftpFile=path.join(root,'sftp.private.json');put(sftpFile,{containerId:sf.Id,created:sf.Created,runId:namespace,image:sf.Image,functionalScope:sftpScope,storage:{host:'127.0.0.1',port:Number(port[0].HostPort),username:'vault',root:'gateway',hostFingerprint:fingerprint,authMode:'password_file',passwordFile,operationTimeoutMs:30000,healthTimeoutMs:5000,maxConnections:4,requireFsync:true}});environment.STAGE3_CHAT_A_SFTP=sftpFile;

  const wire=path.join(evidence,'A15','interop-input'),vectorRoot=path.join(repo,'scripts','fixtures','stage3-wire');fs.mkdirSync(wire,{recursive:true,mode:0o700});
  const index=JSON.parse(fs.readFileSync(path.join(vectorRoot,'manifest.json'),'utf8'));for(const [name,row] of Object.entries(index)){assert(/^[a-z0-9-]+\.json$/.test(name));const bytes=fs.readFileSync(path.join(vectorRoot,name));assert.equal(hash(bytes),row.sha256);assert.equal(bytes.length,row.bytes);fs.writeFileSync(path.join(wire,name),bytes,{flag:'wx',mode:0o600});}put(path.join(wire,'manifest.json'),index);

  const binding={fixtureFile,fixtureSha256:hash(fs.readFileSync(fixtureFile)),engine:owner.engine,identity:owner.objects.find(item=>item.kind==='container'&&item.identity.id===pgId).identity};const bindingFile=path.join(root,'dump-binding.private.json');put(bindingFile,binding);
  const pgdump=path.join(root,'pg_dump');const helper=path.join(repo,'scripts','ci-workspace-pgdump.mjs');
  const executable='#!/bin/sh\nexec '+[process.execPath,helper,bindingFile,hash(fs.readFileSync(bindingFile))].map(shellLiteral).join(' ')+' "$@"\n';
  fs.writeFileSync(pgdump,executable,{flag:'wx',mode:0o700});environment.STAGE3_CHAT_A_PG_DUMP=pgdump;
  const pnpm=path.join(repo,'node_modules','pnpm','bin','pnpm.cjs');
  const commands=postgresSuite?[[process.execPath,[pnpm,'--filter','@saturn/database','migrate']],[process.execPath,[pnpm,'-r','--workspace-concurrency=1','--filter','@saturn/database','--filter','@saturn/protection','--filter','@saturn/api','test','--maxWorkers=1']]]
    :args[1]==='pnpm'?[[process.execPath,[pnpm,...args.slice(2)]]]:[[args[1],args.slice(2)]];
  for(const [exe,argv] of commands){child=command(exe,argv,environment,80*60_000);if(child.status===null||child.signal||child.error){owner.pending=true;owner.persist();throw Error('CI child did not reach a known joined outcome');}if(child.status!==0){process.stderr.write(redactEvidence((child.stdout??'').slice(-10000)+'\n'+(child.stderr??'').slice(-10000),secrets));break;}}
}catch(error){problem=String(error.stack??error);process.stderr.write(redactEvidence(problem,secrets)+'\n');}
finally{
  if(k4Id&&!owner.pending){try{const item=owner.checked('container',k4Id);if(item.observed.State.Running){fs.writeFileSync(k4Stop.file,k4Stop.nonce,{flag:'wx',mode:0o644});let stopped=false;for(let n=0;n<100;n++){if(!owner.checked('container',k4Id).observed.State.Running){stopped=true;break;}await pause(100);}assert(stopped,'K4 control did not join');}assert.equal(owner.checked('container',k4Id).observed.State.ExitCode,0);}catch(error){owner.pending=true;owner.persist();problem??=String(error);}}
  closure=owner.close(!problem&&child?.status===0);
  const report={schema:'saturn.disposable-workspace-inputs.v1',at:new Date().toISOString(),namespace,root,childExit:child?.status??null,error:problem?redactEvidence(problem,secrets):undefined,closure,resources:owner.manifestPath,scope:'Own source-CI inputs only; native/manual/archival qualification is separately accounted, never invented.'};
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  const evidenceRoot=path.join(repo,'artifacts','verification','workspace-inputs');fs.mkdirSync(evidenceRoot,{recursive:true});put(path.join(evidenceRoot,namespace+'.json'),{...report,root:undefined,resources:undefined});
  console.log(JSON.stringify({sourceCiInputs:namespace,childExit:report.childExit,closure:closure.status,report:path.join(evidenceRoot,namespace+'.json')}));
}
process.exitCode=!problem&&child?.status===0&&closure?.status==='CLOSED'?0:1;
