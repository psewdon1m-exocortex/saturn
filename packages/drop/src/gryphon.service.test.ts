import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GryphonCommandService, GryphonNotificationSink, type GryphonCommandEnvelope } from "./gryphon.service.js";
import type { DropService } from "./drop.service.js";

afterEach(() => vi.unstubAllGlobals());

function envelope(command: string): GryphonCommandEnvelope {
  return {
    schema: "exocortex.telegram.command.v1",
    eventId: "bot:update-1",
    correlationId: "request-1",
    connectionId: "connection-1",
    serviceId: "saturn",
    actor: { telegramUserId: "42", chatId: "42", chatType: "private" },
    command,
    arguments: {},
  };
}

describe("Gryphon Saturn adapter", () => {
  it("issues a Drop code for the identity verified by Gryphon", async () => {
    const issueDropCodeForGryphon = vi.fn().mockResolvedValue({ code: "ABCD-EFGH", expiresAt: new Date("2026-09-08T18:10:00.000Z") });
    const service = new GryphonCommandService({ issueDropCodeForGryphon } as unknown as DropService);
    const result = await service.handle(envelope("drop"));
    expect(issueDropCodeForGryphon).toHaveBeenCalledWith({ userId: "42", chatId: "42" });
    expect(result.actions[0]?.text).toContain("ABCD-EFGH");
  });

  it("returns neutral callback actions for the Saturn menu", async () => {
    const service = new GryphonCommandService({} as DropService);
    const result = await service.handle(envelope("start"));
    expect(result.actions[0]?.buttons?.flat().map((button) => button.command)).toEqual(["drop", "status", "revoke"]);
  });

  it("rejects a command outside a private chat", async () => {
    const service = new GryphonCommandService({} as DropService);
    await expect(service.handle({ ...envelope("status"), actor: { telegramUserId: "42", chatId: "-42", chatType: "group" } }))
      .rejects.toThrow("private chat");
  });

  it("revokes identity-scoped Drop access when a Gryphon binding is removed", async () => {
    const revokeGryphonAccess = vi.fn().mockResolvedValue({ sessions: 2, challenges: 1 });
    const service = new GryphonCommandService({ revokeGryphonAccess } as unknown as DropService);
    const result = await service.handle(envelope("binding_revoked"));
    expect(revokeGryphonAccess).toHaveBeenCalledWith({ userId: "42", chatId: "42" });
    expect(result.actions[0]?.text).toContain("2 session(s), 1 code(s)");
  });

  it("uses the upload ID as the completion-notification idempotency key", async () => {
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\saturn-gryphon-${randomUUID()}`
      : path.join(os.tmpdir(), `saturn-gryphon-${randomUUID()}.sock`);
    let captured: { readonly authorization: string | undefined; readonly body: unknown } = { authorization: undefined, body: undefined };
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        captured = { authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
        response.writeHead(202).end();
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try {
      const sink = new GryphonNotificationSink(socketPath, "service-token-value", 1_000);
      await sink.uploadCompleted({ userId: "42", chatId: "42" }, "upload-123", "notes.txt", 64);
      expect(captured).toEqual({
        authorization: "Bearer service-token-value",
        body: {
          text: "Saturn Drop completed: notes.txt (64 bytes).",
          idempotencyKey: "drop-upload-completed:upload-123",
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
