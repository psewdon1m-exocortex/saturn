// Disposable child process used only by the targeted A03 tests.
import {requireDefined} from "../../../packages/contracts/src/require-defined.js";
import {z} from "zod";
import fs from "node:fs/promises";
import { Database } from "@saturn/database";
import { LocalStorageAdapter } from "@saturn/storage";
import { DurableBackendExecutor, type BackendCommand } from "../../../packages/storage/src/durable-backend-executor.js";
const c = z.object({directory:z.string(),url:z.string(),backendIdentity:z.string(),generation:z.string(),phase:z.string(),rootId:z.string().optional(),taskId:z.string().optional()}).parse(JSON.parse(await fs.readFile(requireDefined(process.argv[2]), "utf8")));
if (!c.directory.includes("stage3_") || !new URL(c.url).pathname.startsWith("/stage3_")) throw Error("owned fixture required");
// An owned test gate allows native PID/Created/exe/argv/parent qualification
// before the helper opens SQL or storage. Missing admission expires naturally.
async function admitted(){
  const nonce=process.env.STAGE3_FIXTURE_START_GATE;if(!nonce)return true;
  return await new Promise<boolean>(resolve=>{
    const timer=setTimeout(()=>{process.off("message",receive);if(process.connected)process.disconnect?.();resolve(false);},15000);
    const receive=(message:unknown)=>{if(message&&typeof message==="object"&&"kind" in message&&"nonce" in message&&message.kind==="owned-start"&&message.nonce===nonce){clearTimeout(timer);process.off("message",receive);resolve(true);}};
    process.on("message",receive);process.send?.({event:"owned-ready",nonce,pid:process.pid});
  });
}
if(await admitted()){
const db = new Database(c.url, { max: 2 }), raw = new LocalStorageAdapter(c.directory);
const command: BackendCommand = async (name, identity, payload) => requireDefined((await db.withSql(sql => sql<{ value: unknown }[]>`SELECT sync_backend_command(${name},${JSON.stringify(identity)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`))[0]).value;
const executor = new DurableBackendExecutor(raw, command, c.backendIdentity, c.generation);
const stopState={stopping:false};const stopWaiters=new Set<()=>void>();
process.on("message",(message:unknown)=>{if(message&&typeof message==="object"&&"kind" in message&&"nonce" in message&&message.kind==="owned-stop"&&message.nonce===process.env.STAGE3_FIXTURE_START_GATE){stopState.stopping=true;for(const stop of stopWaiters)stop();}});
const hold = () => new Promise<void>((_resolve,reject) => { const timer=setInterval(() => undefined, 1000);const stop=()=>{clearInterval(timer);stopWaiters.delete(stop);reject(Error("owned_cooperative_stop"));};stopWaiters.add(stop);if(stopState.stopping)stop(); });
const mkdir = raw.mkdir.bind(raw);
raw.mkdir = async p => {
  if (c.phase === "after") await mkdir(p);
  process.send?.({ event: "effect", pid: process.pid, identity: executor.identity, phase: c.phase });
  await hold();
};
try {
if (["retention-queued", "retention-effect", "retention-done"].includes(c.phase)) {
  const remove = raw.delete.bind(raw);
  if (c.phase === "retention-effect") raw.delete = async p => { await remove(p); process.send?.({ event: c.phase, pid: process.pid, identity: executor.identity }); await hold(); };
  if (c.phase === "retention-queued") await command("acquire", executor.identity, {}); else await executor.start();
  await db.withSql(sql => sql<Record<string, unknown>[]>`SELECT sync_retention_command(${requireDefined(c.rootId)}::uuid,${JSON.stringify(executor.identity)}::text::jsonb)`);
  if (c.phase !== "retention-effect") process.send?.({ event: c.phase, pid: process.pid, identity: executor.identity });
  await hold();
} else if (c.phase === "retention") {
  const result = requireDefined((await db.withSql(sql => sql<Record<string, unknown>[]>`SELECT sync_retention_command(${requireDefined(c.rootId)}::uuid,${JSON.stringify(executor.identity)}::text::jsonb) AS value`))[0]).value;
  process.send?.({ event: "retention", pid: process.pid, result }); await db.close(); if(process.connected)process.disconnect?.();
} else if (c.phase === "reads") {
  await executor.start(); const reads = [await executor.openRead("bytes"), await executor.openRead("bytes")];
  process.send?.({ event: "reads", pid: process.pid, identity: executor.identity });
  await new Promise<void>(resolve => process.once("message", () => resolve()));
  for (const stream of reads) stream.destroy();
  await executor.close(); await db.close(); if(process.connected)process.disconnect?.();
} else if (c.phase === "queued") {
  await command("submit", executor.identity, { id: c.taskId, command: "mkdir", body: { path: "effect" }, reservedBytes: "0" });
  process.send?.({ event: "queued", pid: process.pid, identity: executor.identity }); await hold();
} else { await executor.start(); await executor.mkdir("effect"); }

} catch(error) { if(!stopState.stopping)throw error; } finally { if(stopState.stopping){await executor.close();await db.close();if(process.connected)process.disconnect?.();} }

}
