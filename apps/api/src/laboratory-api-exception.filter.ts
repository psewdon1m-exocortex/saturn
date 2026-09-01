import { Catch, HttpException, Injectable, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { LaboratoryServiceError } from "@saturn/laboratory";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

@Catch()
@Injectable()
export class LaboratoryApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof HttpException) { reply.status(exception.getStatus()).send(exception.getResponse()); return; }
    if (exception instanceof ZodError) { reply.status(400).send({ code: "invalid_request" }); return; }
    if (exception instanceof LaboratoryServiceError) {
      if (exception.code === "range") reply.header("Content-Range", `bytes */${String(exception.sizeBytes ?? 0)}`).status(416).send({ code: "range_not_satisfiable" });
      else {
        const status = exception.code === "not_found" ? 404 : exception.code === "unauthorized" ? 403 : exception.code === "conflict" ? 409 : exception.code === "limit" ? 429 : exception.code === "disabled" ? 503 : 400;
        reply.status(status).send({ code: exception.code });
      }
      return;
    }
    if (exception instanceof Error && /constraint|duplicate|unique/i.test(exception.message)) { reply.status(409).send({ code: "conflict" }); return; }
    reply.status(400).send({ code: "invalid_request" });
  }
}
