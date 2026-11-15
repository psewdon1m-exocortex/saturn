import type { FastifyPluginAsync } from "fastify";
import type { Database } from "@saturn/database";
import { guardedSyncCapabilitiesHttp } from "./guarded-sync-capabilities-http.js";
import type { GuardedRuntime } from "../../../packages/sync/src/guarded-runtime.js";
import { guardedSyncHttp } from "./guarded-sync-http.js";
import { guardedSyncUploadHttp } from "./guarded-sync-upload-http.js";
import { guardedSyncFolderHttp } from "./guarded-sync-folder-http.js";
import { guardedSyncSmallBatchHttp } from "./guarded-sync-small-batch-http.js";
import { guardedSyncMutationHttp } from "./guarded-sync-mutation-http.js";
import { guardedSyncStreamHttp } from "./guarded-sync-stream-http.js";

/** Ordinary bootstrap adapter. The factory performs deployment qualification;
 * routes never register/enroll roots or turn a request label into authority. */
export const guardedSyncRuntimeHttp: FastifyPluginAsync<{ runtime: GuardedRuntime; database: Database }> = async (app, options) => {
  // Keep the same maintenance boundary as ordinary DAV/data routes, including
  // physical transfer calls. The injected shared DB and writer DB use the same
  // maintenance advisory key; no HTTP/SFTP is executed in a catalog-clock TX.
  app.addHook("onRoute", route => {
    const original = route.handler;
    route.handler = function (request, reply) {
      return options.database.withSharedMaintenance(async () => await original.call(this, request, reply));
    };
  });
  const root = (id: string) => options.runtime.scope(id);
  await app.register(guardedSyncHttp, { root });
  await app.register(guardedSyncUploadHttp, { root });
  await app.register(guardedSyncFolderHttp, { root });
  await app.register(guardedSyncMutationHttp, { root });
  await app.register(guardedSyncStreamHttp, { root });
  const batchRequests={active:0};
  await app.register(guardedSyncSmallBatchHttp, { requests:batchRequests,root: async id => {
    const scope = await root(id);
    return scope?.batches ? { ...scope, batches: scope.batches } : undefined;
  } });
  await app.register(guardedSyncSmallBatchHttp,{requests:batchRequests,executionJobs:true,root:async id=>{
    const scope=await root(id);return scope?.batches?{...scope,batches:scope.batches}:undefined;
  }});
  app.get<{Params:{rootId:string}}>("/sync/v1/roots/:rootId/diagnostics",async(request,reply)=>{
    try{
      if(!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(request.params.rootId))return await reply.code(400).send({code:'invalid_input'});
      const result=await options.runtime.rootDiagnostics(request.params.rootId,request.headers.authorization);
      return await reply.code(result?200:404).header('Cache-Control','no-store').send(result??{code:'unsupported'});
    }catch(error){const code=error&&typeof error==='object'&&'code'in error?String(error.code):'sync_internal_error';return reply.code(['authority_invalid','unauthorized'].includes(code)?401:500).send({code:code==='authority_invalid'||code==='unauthorized'?code:'sync_internal_error'});}
  });
  await app.register(guardedSyncCapabilitiesHttp, {
    capabilities: (id, authorization) => options.runtime.capabilities(id, authorization),
    smallExecutionJobCapabilities:(id,authorization,pipeline,singleRequest)=>options.runtime.smallExecutionJobCapabilities(id,authorization,pipeline,singleRequest),
    smallBatchCapabilities: (id, authorization) => options.runtime.smallBatchCapabilities(id, authorization),
  });
};
