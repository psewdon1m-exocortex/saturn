import type { FastifyPluginAsync } from "fastify";

/** Both probes are one composition unit. Providers must authenticate and
 * qualify the root before advertising an optional transport. */
export const guardedSyncCapabilitiesHttp: FastifyPluginAsync<{
  capabilities(rootId: string, authorization: string | undefined): Promise<unknown>;
  smallBatchCapabilities(rootId: string, authorization: string | undefined): Promise<unknown>;
  smallExecutionJobCapabilities?(rootId:string,authorization:string|undefined,pipeline?:boolean,singleRequest?:boolean):Promise<unknown>;
}> = (app, options) => {
  for (const mode of ['ordinary','batch','job','job-pipeline','job-single'] as const) app.get<{ Params: { rootId: string } }>("/sync/v1/roots/:rootId/"+(mode==='job-single'?'small-jobs/single-request-':mode==='job-pipeline'?'small-jobs/pipeline-':mode==='job'?'small-jobs/':mode==='batch'?'small-batches/':'')+'capabilities', async (request, reply) => {
    try {
      if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(request.params.rootId)) return await reply.code(400).send({ code: "invalid_input" });
      const batch=mode!=='ordinary';
      const capability = mode==='job'||mode==='job-pipeline'||mode==='job-single'?await options.smallExecutionJobCapabilities?.(request.params.rootId,request.headers.authorization,mode==='job-pipeline'||mode==='job-single',mode==='job-single'):batch ? await options.smallBatchCapabilities(request.params.rootId, request.headers.authorization)
        : await options.capabilities(request.params.rootId, request.headers.authorization);
      if (!capability) return await reply.code(404).header("Cache-Control", "no-store").send({ code: batch ? "batch_unavailable" : "legacy_root" });
      return await reply.header("Cache-Control", "no-store").send(capability);
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? String(e.code) : "sync_internal_error";
      if (code === 'publication_pending') return reply.code(503).header('Retry-After','2').header('Cache-Control','no-store').send({code,retry_after_ms:2000});
      const status = ["authority_invalid", "unauthorized"].includes(code) ? 401 : ["authorization_changed", "forbidden"].includes(code) ? 403
        : ["root_unqualified", "backend_generation_changed", "binding_invalid", "reconciliation_required"].includes(code) ? 409 : 500;
      return reply.code(status).header("Cache-Control", "no-store").send({ code: status === 500 ? "sync_internal_error" : code });
    }
  });
  return Promise.resolve();
};
