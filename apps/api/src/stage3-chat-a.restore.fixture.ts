import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {fixtureManifest} from "./stage3-chat-a.fixture.js";
import {captureFixtureDocker} from "./stage3-chat-a.fault-snapshot.fixture.js";
const sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
export async function restoreFixtureArchive(archive:string,expectedSHA:string,restoredName:string,directory:string){
 const fixture=await fixtureManifest(),source=path.resolve(directory),file=path.resolve(archive);
 if(!/^stage3_[a-f0-9]{32}$/.test(path.basename(source))||!source.startsWith(path.resolve(fixture.fixtureDirectory)+path.sep)||!file.startsWith(source+path.sep)||!/^stage3_restore_[a-f0-9]{32}$/.test(restoredName))throw Error("owned_restore_scope_required");
 for(let current=file;;current=path.dirname(current)){const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw Error("restore_input_reparse");if(current===source)break;}
 const before=await fs.lstat(file);if(!before.isFile()||before.nlink!==1||before.size>67108864)throw Error("restore_input_bound");const bytes=await fs.readFile(file),after=await fs.lstat(file);if(bytes.subarray(0,5).toString()!=="PGDMP"||sha(bytes)!==expectedSHA||after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error("restore_input_changed");
 const root=path.join(source,"restore-stdin-"+randomUUID());await fs.mkdir(root,{mode:0o700});const intent={schema:"saturn.test-owned-restore.v1",sourceDirectory:source,sourceDatabase:path.basename(source),restoredName,containerId:fixture.containerId,containerCreated:fixture.created,archive:file,archiveSHA256:expectedSHA,archiveBytes:bytes.length,inputMode:"stdin",createdAt:new Date().toISOString()};await fs.writeFile(path.join(root,"intent.json"),JSON.stringify(intent,null,2)+"\n",{flag:"wx",mode:0o600});
 await captureFixtureDocker(root,["exec",fixture.containerId,"createdb","-U","postgres",restoredName]);
 await captureFixtureDocker(root,["exec","-i",fixture.containerId,"pg_restore","-U","postgres","--no-owner","--exit-on-error","-d",restoredName],bytes);
 const receipt={...intent,finishedAt:new Date().toISOString(),createdbExit:0,pgRestoreExit:0,realArchive:true,containerRootfsWrites:0,SQLOnlyRestore:true,physicalRestoreClaim:false};const receiptFile=path.join(root,"receipt.json"),receiptBytes=Buffer.from(JSON.stringify(receipt,null,2)+"\n");await fs.writeFile(receiptFile,receiptBytes,{flag:"wx",mode:0o600});return {path:receiptFile,sha256:sha(receiptBytes),containerId:fixture.containerId,restoredName,inputMode:"stdin"};
}
