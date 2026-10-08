import { Catch, HttpException, Injectable, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { ShareServiceError, ShareThumbnailError } from "@saturn/shares";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";
import { TransferTaskControlError } from "./transfer-monitor.service.js";

@Catch()
@Injectable()
export class ShareApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      reply.status(exception.getStatus()).send(typeof response === "string" ? { message: response } : response);
      return;
    }
    if (exception instanceof ZodError) {
      reply.status(400).send({ code: "invalid_request", issues: exception.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
      return;
    }
    if (exception instanceof TransferTaskControlError) {
      reply.status(409).send({ code: "transfer_cancelled" });
      return;
    }
    if (exception instanceof ShareServiceError) {
      const status = exception.code === "not_found" ? 404
        : exception.code === "rate_limited" ? 429
          : exception.code === "locked" || exception.code === "denied" ? 401
            : exception.code === "package_limit" ? 413
              : exception.code === "package_unavailable" ? 409 : 400;
      reply.status(status).send({ code: exception.code === "locked" ? "share_locked" : exception.code === "not_found" ? "not_found" : "share_denied" });
      return;
    }
    if (exception instanceof ShareThumbnailError) {
      const status = exception.code === "unsupported" ? 404 : exception.code === "too_large" ? 413 : 422;
      reply.status(status).send({ code: "thumbnail_unavailable" });
      return;
    }
    reply.status(400).send({ code: "invalid_request" });
  }
}
