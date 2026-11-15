import Fastify from "fastify";
import { expect, it } from "vitest";
import { guardedSyncCapabilitiesHttp } from "./guarded-sync-capabilities-http.js";
const root = "00112233-4455-6677-8899-aabbccddeeff";
it("registers both probes, preserves opt-out, authentication and qualification errors", async () => {
  const app = Fastify();
  await app.register(guardedSyncCapabilitiesHttp, {
    capabilities: async () => ({ schema: "base" }),
    smallBatchCapabilities: async (_id, auth) => {
      if (!auth) throw Object.assign(Error("authority_invalid"), { code: "authority_invalid" });
      if (auth === "changed") throw Object.assign(Error("binding_invalid"), { code: "binding_invalid" });
      return auth === "qualified" ? { schema: "batch" } : undefined;
    },
  });
  try {
    expect((await app.inject(`/sync/v1/roots/${root}/capabilities`)).json()).toEqual({ schema: "base" });
    const url = `/sync/v1/roots/${root}/small-batches/capabilities`;
    expect((await app.inject(url)).statusCode).toBe(401);
    for (const [authorization, code] of [["qualified", 200], ["disabled", 404], ["changed", 409]] as const) {
      const r = await app.inject({ url, headers: { authorization } }); expect(r.statusCode).toBe(code); expect(r.headers["cache-control"]).toBe("no-store");
    }
    expect((await app.inject("/sync/v1/roots/invalid/small-batches/capabilities")).statusCode).toBe(400);
  } finally { await app.close(); }
});
it('advertises no authority during an owned publication and keeps real reconciliation failures closed',async()=>{
  const app=Fastify();let code='publication_pending';
  await app.register(guardedSyncCapabilitiesHttp,{capabilities:async()=>{throw Object.assign(Error(code),{code});},smallBatchCapabilities:async()=>undefined});
  try{
    const pending=await app.inject(`/sync/v1/roots/${root}/capabilities`);
    expect(pending.statusCode).toBe(503);expect(pending.headers['retry-after']).toBe('2');expect(pending.json()).toEqual({code:'publication_pending',retry_after_ms:2000});
    code='reconciliation_required';const fenced=await app.inject(`/sync/v1/roots/${root}/capabilities`);
    expect(fenced.statusCode).toBe(409);expect(fenced.headers['retry-after']).toBeUndefined();
    code='authority_invalid';expect((await app.inject(`/sync/v1/roots/${root}/capabilities`)).statusCode).toBe(401);
  }finally{await app.close();}
});
