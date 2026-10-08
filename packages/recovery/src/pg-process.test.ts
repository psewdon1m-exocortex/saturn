import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { PostgresCommandToolchain } from "./postgres-toolchain.js";
import type { Database } from "@saturn/database";

it.each(["dump", "restore", "idle", "cancel"])("bounds and reaps a stalled %s subprocess", async mode => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"saturn-pg-deadline-"));
  try {
    const helper=path.join(dir,"stall.mjs"), pidFile=path.join(dir,"child.pid"), dump=path.join(dir,"dump");
    await fs.writeFile(helper,"import fs from 'node:fs';fs.writeFileSync(process.argv[2],String(process.pid));process.stdin.resume();setInterval(()=>{},1000);");
    const tool=new PostgresCommandToolchain({ databaseUrl:"postgres://fixture@localhost/fixture",database:{} as Database,
      pgDumpExecutable:process.execPath,pgRestoreExecutable:process.execPath,pgDumpPrefixArgs:[helper,pidFile],pgRestorePrefixArgs:[helper,pidFile],
      maximumDumpBytes:1024,commandTimeoutMs:mode==="idle"?2000:500,dumpIdleTimeoutMs:mode==="idle"?400:2000 });
    const controller=new AbortController();
    if(mode==="restore") await fs.writeFile(dump,"fixture input");
    const start=Date.now();
    const pending=mode==="restore"?tool.restoreDump(dump,"clean",controller.signal):tool.createDump(dump,controller.signal);
    const failed=expect(pending).rejects.toThrow(mode==="cancel"?"cancelled":mode==="idle"?"progress":"deadline");
    if(mode==="cancel") {
      for(let i=0;i<30;i++){try{await fs.access(pidFile);break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
      controller.abort();
    }
    await failed;
    expect(Date.now()-start).toBeLessThan(2500);
    const pid=Number(await fs.readFile(pidFile,"utf8"));
    expect(()=>process.kill(pid,0)).toThrow();
    if(mode!=="restore") await expect(fs.access(dump)).rejects.toThrow();
  } finally {await fs.rm(dir,{recursive:true,force:true});}
},5000);

it("observes failed spawn and pipe errors without an unhandled EPIPE", async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"saturn-pg-start-"));
  try {
    const tool=new PostgresCommandToolchain({databaseUrl:"postgres://fixture@localhost/fixture",database:{} as Database,pgRestoreExecutable:path.join(dir,"missing"),maximumDumpBytes:1024,commandTimeoutMs:500});
    const input=path.join(dir,"input");await fs.writeFile(input,"valuable");
    await expect(tool.restoreDump(input,"clean")).rejects.toThrow();
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
