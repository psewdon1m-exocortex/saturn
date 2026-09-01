import { Catch, HttpException, Injectable, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

function safeError(error: Error): { readonly statusCode: number; readonly code: string; readonly message: string } {
  const message = error.message;
  if (/not found|missing/i.test(message)) return { statusCode: 404, code: "not_found", message };
  if (/locked/i.test(message)) return { statusCode: 423, code: "locked", message };
  if (/already|exists|offset mismatch|concurrently|in progress|reconciliation/i.test(message)) {
    return { statusCode: 409, code: "conflict", message };
  }
  if (/invalid|incomplete|cannot|not active|differs|checksum|Content-Length|reserved/i.test(message)) {
    return { statusCode: 400, code: "invalid_request", message };
  }
  return { statusCode: 500, code: "internal_error", message: "Request could not be completed" };
}

@Catch()
@Injectable()
export class SaturnApiExceptionFilter implements ExceptionFilter {
  readonly #logger = new Logger(SaturnApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      reply.status(exception.getStatus()).send(typeof response === "string" ? { message: response } : response);
      return;
    }
    if (exception instanceof ZodError) {
      reply.status(400).send({
        statusCode: 400,
        code: "invalid_request",
        issues: exception.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
      return;
    }
    if (exception instanceof Error) this.#logger.error(exception.message, exception.stack);
    const result = safeError(exception instanceof Error ? exception : new Error("Unknown request error"));
    reply.status(result.statusCode).send(result);
  }
}
