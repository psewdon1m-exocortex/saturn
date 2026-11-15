import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile), root='C:/.projects/exocortex', repo=root+'/saturn';
const out=root+'/.audit/2026-10-15/endurance-6h';
const current=JSON.parse((await fs.readFile(out+'/current.json','utf8')).replace(/^\uFEFF/,''));
if(current.status!=='PREPARING')throw Error('Preparation only');
const privateDir=out+'/private';await fs.mkdir(privateDir,{recursive:true});
const port=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function command(exe,args,env=process.env){return exec(exe,args,{cwd:repo,env,windowsHide:true,maxBuffer:16*1024*1024,timeout:180000});}
let source=await fs.readFile(repo+'/scripts/prepare-dev.mjs','utf8');
source=source.replace('const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',`const vaultRoot = ${JSON.stringify(repo)};`)
 .replace('const secretDirectory = path.join(vaultRoot, ".secrets");',`const secretDirectory = ${JSON.stringify(privateDir+'/secrets')};`)
 .replace('const temporaryDirectory = path.join(vaultRoot, ".tmp");',`const temporaryDirectory = ${JSON.stringify(privateDir+'/temp')};`);
await fs.writeFile(out+'/prepare-owned-env.mjs',source);
const prepared=await(await import(pathToFileURL(out+'/prepare-owned-env.mjs'))).prepareDevelopmentEnvironment({postgresPort:await port(),sftpPort:await port(),runtimeNamespace:'live'});
const env={...prepared.environment,API_PORT:String(await port()),WORKER_PORT:String(await port())};
env.PUBLIC_ORIGIN='http://127.0.0.1:'+await port();
const dataKeys=['DROP_BUFFER_DIRECTORY','STORAGE_RUNTIME_CONFIG_DIR','RECOVERY_SPOOL_DIR','RECOVERY_ARCHIVE_DIR','ARCHIVE_SPOOL_DIR'];
for(const key of dataKeys){env[key]=privateDir+'/data/'+key.toLowerCase();await fs.mkdir(env[key],{recursive:true});}
env.LOG_LEVEL='warn';env.RECOVERY_BACKUP_INTERVAL_MS='86400000';
const project='endurance-'+current.runId.slice(0,8), config=privateDir+'/temp/live/sftp';
const pgImage='postgres:18.1-alpine@sha256:aa6eb304ddb6dd26df23d05db4e5cb05af8951cda3e0dc57731b771e0ef4ab29';
const sftpImage='atmoz/sftp:alpine@sha256:81fa92512bf8ead4849f33c1c153907b86d32d77704d1c62a9c70b4316ae9e50';
const labels={'exocortex.endurance.run':current.runId};
const syncPort=await port();
const compose={name:project,services:{
 postgres:{image:pgImage,environment:{POSTGRES_DB:'vault',POSTGRES_USER:'vault',POSTGRES_PASSWORD_FILE:'/run/secrets/postgres_password'},secrets:['postgres_password'],ports:[`127.0.0.1:${env.DEV_POSTGRES_BIND_PORT}:5432`],volumes:['postgres:/var/lib/postgresql'],cpus:2,mem_limit:'4g',labels,healthcheck:{test:['CMD-SHELL','pg_isready -U vault -d vault'],interval:'2s',timeout:'3s',retries:40}},
 sftp:{image:sftpImage,entrypoint:['/bin/sh','/bootstrap/entrypoint.sh'],ports:[`127.0.0.1:${env.DEV_SFTP_BIND_PORT}:22`],volumes:[`${config}/users.conf:/etc/sftp/users.conf:ro`,`${repo}/infra/dev/sftp-entrypoint.sh:/bootstrap/entrypoint.sh:ro`,`${config}/ssh_host_ed25519_key:/hostkeys/ssh_host_ed25519_key:ro`,`${config}/dev_client_ed25519.pub:/home/vault/.ssh/keys/dev_client_ed25519.pub:ro`,'storage:/home/vault/gateway'],cpus:2,mem_limit:'1g',labels,healthcheck:{test:['CMD-SHELL','pgrep sshd >/dev/null'],interval:'2s',timeout:'3s',retries:40}},
 syncpg:{image:pgImage,environment:{POSTGRES_DB:'postgres',POSTGRES_USER:'postgres',POSTGRES_HOST_AUTH_METHOD:'trust'},ports:[`127.0.0.1:${syncPort}:5432`],volumes:['syncpg:/var/lib/postgresql'],cpus:1,mem_limit:536870912,labels:{...labels,'exocortex.sync-performance.run':current.runId},healthcheck:{test:['CMD-SHELL','pg_isready -U postgres'],interval:'2s',timeout:'3s',retries:40}}
},volumes:{postgres:{labels},storage:{labels},syncpg:{labels}},secrets:{postgres_password:{file:privateDir+'/secrets/dev-postgres-password'}}};
const composeFile=out+'/compose.json';await fs.writeFile(composeFile,JSON.stringify(compose,null,2));
const result=await command('docker',['compose','-f',composeFile,'-p',project,'up','-d','--wait']);await fs.writeFile(out+'/compose-up.log',result.stdout+'\n'+result.stderr);
await command('docker',['compose','-f',composeFile,'-p',project,'exec','-T','sftp','chown','1001:1001','/home/vault/gateway']);
const id=(await command('docker',['compose','-f',composeFile,'-p',project,'ps','-q','syncpg'])).stdout.trim();
const [container]=JSON.parse((await command('docker',['inspect',id])).stdout);
const fixtureDir=privateDir+'/guarded-fixtures';await fs.mkdir(fixtureDir,{recursive:true});
await fs.writeFile(privateDir+'/sync-fixture.json',JSON.stringify({containerId:container.Id,runId:current.runId,databaseUrl:`postgres://postgres@127.0.0.1:${syncPort}/postgres`,fixtureDirectory:fixtureDir,created:container.Created},null,2));
env.PG_DUMP_PREFIX_ARGS=JSON.stringify(['compose','-f',composeFile,'-p',project,'exec','-T','postgres','pg_dump']);
env.PG_RESTORE_PREFIX_ARGS=JSON.stringify(['compose','-f',composeFile,'-p',project,'exec','-T','postgres','pg_restore']);
await fs.writeFile(privateDir+'/environment.json',JSON.stringify(env,null,2));
const migration=await command(process.execPath,[repo+'/node_modules/pnpm/bin/pnpm.cjs','--filter','@saturn/database','migrate'],{...process.env,...env});await fs.writeFile(out+'/migrate.log',migration.stdout+'\n'+migration.stderr);
await fs.writeFile(out+'/fixture-ready.json',JSON.stringify({at:new Date().toISOString(),runId:current.runId,project,composeFile,apiOrigin:'http://127.0.0.1:'+env.API_PORT,publicOrigin:env.PUBLIC_ORIGIN,workerOrigin:'http://127.0.0.1:'+env.WORKER_PORT,syncFixture:privateDir+'/sync-fixture.json'},null,2));
console.log('PASS isolated containers and migrations');
