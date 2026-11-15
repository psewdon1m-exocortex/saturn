import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { encodeSyncJson } from "../../../packages/contracts/src/sync-protocol.js";
import { parseSyncDeletePlan,parseSyncMutationInput, parseSyncNamespacePolicy } from "../../../packages/contracts/src/sync-extensions.js";
import type { GuardedRuntimeScope } from "../../../packages/sync/src/guarded-runtime.js";
import { guardedMetadataParser, syncRetryHint } from "./guarded-metadata-http.js";

const binding = z.object({ protocol: z.literal("neptune-sync/1"), descriptor_schema: z.literal("saturn.current-namespace.v1"), server_identity: z.string(), root_id: z.uuid(), server_epoch: z.uuid(), policy_version: z.string(), binding_version: z.uuid() }).strict();
async function fail(reply: FastifyReply, error: unknown) {
  const code = error instanceof z.ZodError ? "invalid_input" : error && typeof error === "object" && "code" in error ? String(error.code) : "sync_internal_error";
  const retry = syncRetryHint(code);
  if (retry) return await reply.code(retry.status).header("Retry-After", String(retry.seconds)).send({ code, retry_after_ms: retry.seconds * 1000 });
  const status = ["unauthorized", "authority_invalid"].includes(code) ? 401 : ["forbidden", "authorization_changed"].includes(code) ? 403
    : code === "precondition_failed" ? 412 : code === "unsupported" ? 404 : code === "unsupported_encoding" ? 415
      : ["page_limit", "upload_too_large", "FST_ERR_CTP_BODY_TOO_LARGE"].includes(code) ? 413
        : ["invalid_input", "invalid_name", "invalid_json", "invalid_contract"].includes(code) ? 400
          : ["binding_mismatch", "binding_invalid", "policy_mismatch", "codec_mismatch", "operation_reused", "operation_unknown", "reconciliation_required", "membership_changed", "directory_not_empty", "approval_stale"].includes(code) ? 409 : 500;
  return await reply.code(status).header("Cache-Control", "no-store").send({ code: status === 500 ? "sync_internal_error" : code });
}
export const guardedSyncMutationHttp: FastifyPluginAsync<{ root: (id: string) => Promise<GuardedRuntimeScope | undefined> }> = (app, options) => {
  app.setErrorHandler((error, _request, reply) => fail(reply, error));
  guardedMetadataParser(app, 4 * 1024 * 1024, async request => (await options.root((request.params as { rootId: string }).rootId))?.extensions?.includes("metadata-gzip-v1") === true);
  const scope = async (id: string, b: z.infer<typeof binding>, authorization: string | undefined) => {
    const root = await options.root(id);
    if (!root?.mutations || !root.extensions?.includes("namespace-mutations-v1")) throw Object.assign(new Error("unsupported"), { code: "unsupported" });
    if (id !== b.root_id || (Object.keys(b) as (keyof typeof b)[]).some(k => b[k] !== root.binding[k])) throw Object.assign(new Error("binding_mismatch"), { code: "binding_mismatch" });
    return { root, mutations: root.mutations, proof: await root.authority.device(authorization, id) };
  };
  for (const command of ["execute", "status"] as const) app.post<{ Params: { rootId: string } }>(`/sync/v1/roots/:rootId/mutations/${command}`, async (request, reply) => {
    try {
      const body = z.object({ binding, namespace: z.unknown(), input: z.unknown() }).strict().parse(request.body);
      const { mutations, proof } = await scope(request.params.rootId, body.binding, request.headers.authorization);
      const input = parseSyncMutationInput(body.input), namespace = parseSyncNamespacePolicy(body.namespace);
      if (input.rootId !== body.binding.root_id) throw Object.assign(new Error("invalid_input"), { code: "invalid_input" });
      return await reply.header("Content-Type", "application/json").header("Cache-Control", "no-store").send(Buffer.from(encodeSyncJson(await mutations[command](input, namespace, proof))));
    } catch (error) { return await fail(reply, error); }
  });
  app.post<{Params:{rootId:string}}>('/sync/v1/roots/:rootId/delete-plans/approve',async(request,reply)=>{
    try{
      const body=z.object({binding,namespace:z.unknown(),plan:z.unknown()}).strict().parse(request.body);
      const {mutations,proof}=await scope(request.params.rootId,body.binding,request.headers.authorization);
      return await reply.header('Cache-Control','no-store').send(await mutations.approveDeletePlan(body.binding.root_id,body.binding.server_epoch,body.binding.binding_version,parseSyncDeletePlan(body.plan),parseSyncNamespacePolicy(body.namespace),proof));
    }catch(error){return await fail(reply,error);}
  });
  app.post<{Params:{rootId:string}}>("/sync/v1/roots/:rootId/mutations/batch",async(request,reply)=>{
    try{
      const body=z.object({binding,namespace:z.unknown(),items:z.array(z.object({ref:z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),input:z.unknown()}).strict()).min(1).max(500)}).strict().parse(request.body);
      const namespace=parseSyncNamespacePolicy(body.namespace),items=body.items.map(item=>({ref:item.ref,input:parseSyncMutationInput(item.input)}));
      if(new Set(items.map(i=>i.ref)).size!==items.length||new Set(items.map(i=>i.input.operationId)).size!==items.length||items.some(i=>i.input.rootId!==body.binding.root_id))throw Object.assign(new Error('invalid_input'),{code:'invalid_input'});
      const {mutations,proof}=await scope(request.params.rootId,body.binding,request.headers.authorization);
      const outcomes=[];
      for(const item of items){
        try{outcomes.push({ref:item.ref,outcome:await mutations.execute(item.input,namespace,proof)});}catch(error){
          const code=error&&typeof error==='object'&&'code'in error?String(error.code):'sync_internal_error';
          outcomes.push({ref:item.ref,code:/^[a-z_]{1,64}$/.test(code)?code:'sync_internal_error'});
        }
      }
      return await reply.header('Cache-Control','no-store').send({outcomes});
    }catch(error){return await fail(reply,error);}
  });
  app.post<{ Params: { rootId: string } }>("/sync/v1/roots/:rootId/content/lookup", async (request, reply) => {
    try {
      const body = z.object({ binding, sizeBytes: z.string(), sha256: z.string() }).strict().parse(request.body);
      const { root, mutations, proof } = await scope(request.params.rootId, body.binding, request.headers.authorization);
      if (!root.extensions?.includes("clone-content-v1")) return await reply.code(404).send({ code: "unsupported" });
      return await reply.header("Cache-Control", "no-store").send(await mutations.lookup(body.binding.root_id, body.binding.server_epoch, body.binding.binding_version, body.sizeBytes, body.sha256, proof));
    } catch (error) { return await fail(reply, error); }
  });
  return Promise.resolve();
};
