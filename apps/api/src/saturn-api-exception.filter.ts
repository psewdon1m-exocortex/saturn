import { Catch, HttpException, Injectable, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

function safeError(error: Error): { readonly statusCode: number; readonly code: string; readonly message: string } {
  const message = error.message;
  if (/interrupted.*recovery|requiring recovery|restore guard/i.test(message)) return { statusCode: 503, code: "recovery_required", message: "Recovery must complete before accessing this resource" };
  if (/^unauthorized$/i.test(message)) return { statusCode: 401, code: "unauthorized", message: "Authentication failed" };
  if (/^forbidden$/i.test(message)) return { statusCode: 403, code: "forbidden", message: "Operation is not permitted" };
  if (/^rate_limited$/i.test(message)) return { statusCode: 429, code: "rate_limited", message: "Request rate limit exceeded" };
  if (/^conflict$/i.test(message)) return { statusCode: 409, code: "conflict", message: "Operation conflicts with current state" };
  if (/^not_found$/i.test(message)) return { statusCode: 404, code: "not_found", message: "Resource not found" };
  if (/^precondition_failed$/i.test(message)) return { statusCode: 412, code: "precondition_failed", message: "Resource changed; refresh its metadata" };
  if (/^precondition_required$/i.test(message)) return { statusCode: 428, code: "precondition_required", message: "A resource precondition is required" };
  if (/^limit$/i.test(message)) return { statusCode: 413, code: "limit", message: "Request exceeds the permitted limit" };
  if (/not found|missing/i.test(message)) return { statusCode: 404, code: "not_found", message };
  if (/locked/i.test(message)) return { statusCode: 423, code: "locked", message };
  if (/already|exists|offset mismatch|concurrently|in progress|reconciliation|cancelled|not paused|not controllable|client disconnected/i.test(message)) {
    return { statusCode: 409, code: "conflict", message };
  }
  if (/duplicate|unique constraint/i.test(message)) return { statusCode: 409, code: "identity_conflict", message: "An active Neptune identity already owns this project/server pair or mirror root" };
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
