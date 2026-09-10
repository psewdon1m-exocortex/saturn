import type { FastifyReply, FastifyRequest } from "fastify";
import type { TransferMonitorService } from "./transfer-monitor.service.js";

export async function awaitTransferRunnable(
  transfers: TransferMonitorService,
  id: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const abort = new AbortController();
  const requestAborted = () => abort.abort();
  const responseClosed = () => { if (!reply.raw.writableFinished) abort.abort(); };
  request.raw.once("aborted", requestAborted);
  reply.raw.once("close", responseClosed);
  if (request.raw.destroyed || (reply.raw.destroyed && !reply.raw.writableFinished)) abort.abort();
  try { await transfers.awaitRunnable(id, abort.signal); }
  finally {
    request.raw.off("aborted", requestAborted);
    reply.raw.off("close", responseClosed);
  }
}
