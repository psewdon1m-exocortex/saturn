import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {prepareDevelopmentEnvironment,resolveDevelopmentPaths} from "./prepare-dev.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const inside=(parent,file)=>{const relative=path.relative(parent,path.resolve(file));return relative===""||!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative);};

test("default and legacy namespaced development paths preserve the existing contract",()=>{
 const normal=resolveDevelopmentPaths();
 assert.equal(normal.secretDirectory,path.join(root,".secrets"));
 assert.equal(normal.scopedTemporaryDirectory,path.join(root,".tmp"));
 assert.equal(normal.sftpDataDirectory,path.join(root,"data","sftp"));
 assert.equal(normal.postgresPasswordFile,path.join(root,".secrets","dev-postgres-password"));
 assert.equal(normal.ownerTokenFile,path.join(root,".secrets","dev-owner-bootstrap-token"));
 const named=resolveDevelopmentPaths({runtimeNamespace:"own-example"});
 assert.equal(named.secretDirectory,normal.secretDirectory);
 assert.equal(named.scopedTemporaryDirectory,path.join(root,".tmp","own-example"));
 assert.equal(named.sftpDataDirectory,path.join(root,".tmp","own-example","sftp-data"));
 assert.equal(named.composeFile,undefined);
});

test("isolated preparation writes only its owned root and resolves every mutable input there",async()=>{
 const isolatedRoot=await fs.mkdtemp(path.join(os.tmpdir(),"stage13-path-fixture-"));
 const namespace="stage13-fixture-"+path.basename(isolatedRoot).split("-").at(-1).toLowerCase();
 await fs.writeFile(path.join(isolatedRoot,".exocortex-isolation.json"),JSON.stringify({schema:"exocortex.local-isolation.v1",namespace}));
 const writes=[];const originals=new Map();
 for(const name of ["mkdir","writeFile"]){originals.set(name,fs[name]);fs[name]=async(file,...args)=>{assert.equal(inside(isolatedRoot,file),true,"mutable operation escaped isolatedRoot");writes.push(path.resolve(file));return originals.get(name)(file,...args);};}
 const execute=(command,args)=>{
  if(command==="icacls.exe"){assert.equal(inside(isolatedRoot,args[0]),true);return "fixture-only ACL command";}
  assert.match(command,/ssh-keygen(?:\.exe)?$/);
  if(args.includes("-l"))return "256 SHA256:"+"A".repeat(43)+" fixture (ED25519)";
  const file=args[args.indexOf("-f")+1];assert.equal(inside(isolatedRoot,file),true);
  fsSync.writeFileSync(file,"fixture-only-key-not-used-by-a-service\n");fsSync.writeFileSync(file+".pub","ssh-ed25519 fixture-only\n");return "";
 };
 try{
  const prepared=await prepareDevelopmentEnvironment({isolatedRoot,runtimeNamespace:namespace,postgresPort:15432,sftpPort:12222,execute});
  assert.ok(writes.length>10);
  for(const value of Object.values(prepared.paths))if(typeof value==="string"&&path.isAbsolute(value))assert.equal(inside(isolatedRoot,value),true);
  for(const [key,value]of Object.entries(prepared.environment))if(key.endsWith("_FILE")&&value!==""||["DROP_BUFFER_DIRECTORY","STORAGE_RUNTIME_CONFIG_DIR","RECOVERY_SPOOL_DIR","RECOVERY_ARCHIVE_DIR","ARCHIVE_SPOOL_DIR","DEV_SFTP_CONFIG_DIR","DEV_SFTP_DATA_DIR"].includes(key))assert.equal(inside(isolatedRoot,value),true,key+" escaped own root");
  const dump=JSON.parse(prepared.environment.PG_DUMP_PREFIX_ARGS);
  assert.equal(dump[dump.indexOf("-f")+1],path.join(isolatedRoot,"dependencies.compose.json"));
  assert.equal(dump[dump.indexOf("-p")+1],namespace);
  assert.equal(new URL(prepared.environment.DATABASE_URL).port,"15432");
  assert.ok(new URL(prepared.environment.DATABASE_URL).password.length>=32);
  assert.equal(writes.some(file=>inside(path.join(root,".secrets"),file)||inside(path.join(root,".tmp"),file)||inside(path.join(root,"data"),file)),false);
 }finally{for(const[name,original]of originals)fs[name]=original;await fs.rm(isolatedRoot,{recursive:true,force:true});}
});

test("an unrelated isolation owner is refused before any mutable operation",async()=>{
 const isolatedRoot=await fs.mkdtemp(path.join(os.tmpdir(),"stage13-owner-fixture-"));
 await fs.writeFile(path.join(isolatedRoot,".exocortex-isolation.json"),JSON.stringify({schema:"exocortex.local-isolation.v1",namespace:"someone-else"}));
 try{
  await assert.rejects(prepareDevelopmentEnvironment({isolatedRoot,runtimeNamespace:"stage13-expected"}),/owner mismatch/);
  assert.deepEqual(await fs.readdir(isolatedRoot),[".exocortex-isolation.json"]);
  assert.throws(()=>resolveDevelopmentPaths({isolatedRoot:path.parse(isolatedRoot).root,runtimeNamespace:"stage13-expected"}),/invalid/);
 }finally{await fs.rm(isolatedRoot,{recursive:true,force:true});}
});
