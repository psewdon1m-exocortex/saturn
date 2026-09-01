import { Catch, HttpException, Injectable, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { BackupServiceError } from "@saturn/backup-ingest";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

@Catch()
@Injectable()
export class BackupApiExceptionFilter implements ExceptionFilter {
  readonly logger = new Logger(BackupApiExceptionFilter.name);
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof HttpException) { reply.status(exception.getStatus()).send(exception.getResponse()); return; }
    if (exception instanceof ZodError) { reply.status(400).send({ code: "invalid_request" }); return; }
    if (exception instanceof BackupServiceError) {
      const status = exception.code === "unauthorized" ? 401 : exception.code === "not_found" ? 404 : exception.code === "quota" ? 413 : exception.code === "conflict" ? 409 : exception.code === "disabled" ? 503 : 400;
      reply.status(status).send({ code: status === 404 ? "not_found" : exception.code }); return;
    }
    if (exception instanceof Error && /invalid|Content-Length|Idempotency-Key/i.test(exception.message)) { reply.status(400).send({ code: "invalid_request" }); return; }
    if (exception instanceof Error) this.logger.error(exception.message, exception.stack);
    reply.status(500).send({ code: "internal_error" });
  }
}
