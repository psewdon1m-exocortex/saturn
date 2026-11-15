// Disposable CLI child: qualify the OS tuple before importing the real CLI.
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {z} from "zod";
import {requireDefined} from "../../../packages/contracts/src/require-defined.js";
const input=requireDefined(process.argv[2]),c=z.object({schema:z.literal("saturn.test-owned-lifecycle-command.v1"),action:z.enum(["inspect","migrate-plan","checkpoint","backup","adopt","pause","resume","rollback-plan"]),lifecycleConfig:z.string(),artifact:z.string().optional(),fault:z.enum(["before-progress","after-progress","after-receipt"]).optional(),containerId:z.string().regex(/^[a-f0-9]{64}$/)}).parse(JSON.parse(await fs.readFile(input,"utf8")));
const root=path.dirname(input);
if(!/^stage3_[a-f0-9]{32}$/.test(path.basename(root))||path.dirname(path.resolve(c.lifecycleConfig))!==root||c.artifact&&!path.resolve(c.artifact).startsWith(root+path.sep)||c.fault&&c.action!=="adopt")throw Error("owned_lifecycle_command_scope_required");
async function admitted(){const nonce=process.env.STAGE3_FIXTURE_START_GATE;if(!nonce)throw Error("owned_lifecycle_gate_required");return await new Promise<boolean>(resolve=>{const timer=setTimeout(()=>{process.off("message",receive);if(process.connected)process.disconnect?.();resolve(false);},15000);const receive=(message:unknown)=>{if(message&&typeof message==="object"&&"kind" in message&&"nonce" in message&&message.kind==="owned-start"&&message.nonce===nonce){clearTimeout(timer);process.off("message",receive);resolve(true);}};process.on("message",receive);process.send?.({event:"owned-ready",nonce,pid:process.pid});});}
if(await admitted()){
 const script=new URL("../../../scripts/sync-lifecycle.mts",import.meta.url);process.env.STAGE3_PG_CONTAINER=c.containerId;
 process.argv=[process.execPath,fileURLToPath(script),c.action,c.lifecycleConfig,...(c.artifact?[c.artifact]:[])];
 if(c.fault){process.env.STAGE3_CHAT_A_FAULT=c.fault;await import(new URL("./stage3-chat-a.lifecycle-fault.mts",import.meta.url).href);}
 await import(script.href);
 // The real CLI owns its async work and normal exit, as when invoked directly.
 if(process.connected)process.disconnect?.();
}
