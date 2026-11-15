import { describe, expect, it, vi } from "vitest";
import type { ArgumentsHost } from "@nestjs/common";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

describe("inactive resource HTTP refusal", () => {
  it("returns a bounded policy refusal for managed backup mutation", () => {
    const message = "Managed backup artifacts are immutable; use the backup retention policy";
    const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    new SaturnApiExceptionFilter().catch(new Error(message), { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ArgumentsHost);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ statusCode: 403, code: "backup_artifact_immutable", message });
  });
  it.each(["Resource is not an active file", "Resource is not an active folder", "Upload parent is not active"])("returns a client refusal for %s", message => {
    const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    new SaturnApiExceptionFilter().catch(new Error(message), { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ArgumentsHost);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({statusCode:400,code:"invalid_request",message});
  });
});
