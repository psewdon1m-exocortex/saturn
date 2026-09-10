import { randomUUID } from "node:crypto";
import http from "node:http";
import type { DropNotificationSink, TelegramIdentity } from "./types.js";
import type { DropService } from "./drop.service.js";

export interface GryphonCommandEnvelope {
  readonly schema: "exocortex.telegram.command.v1";
  readonly eventId: string;
  readonly correlationId: string;
  readonly connectionId: string;
  readonly serviceId: "saturn";
  readonly actor: {
    readonly telegramUserId: string;
    readonly chatId: string;
    readonly chatType: string;
    readonly displayName?: string;
  };
  readonly command: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface GryphonCommandResponse {
  readonly schema: "exocortex.telegram.response.v1";
  readonly actions: readonly {
    readonly type: "send_message";
    readonly text: string;
    readonly buttons?: readonly (readonly {
      readonly text: string;
      readonly command: string;
      readonly arguments?: Readonly<Record<string, unknown>>;
    }[])[];
  }[];
}

function response(text: string, buttons?: GryphonCommandResponse["actions"][number]["buttons"]): GryphonCommandResponse {
  return { schema: "exocortex.telegram.response.v1", actions: [{ type: "send_message", text, ...(buttons === undefined ? {} : { buttons }) }] };
}

function identity(input: GryphonCommandEnvelope): TelegramIdentity {
  if (input.actor.chatType !== "private") throw new Error("Gryphon command requires a private chat");
  return {
    userId: input.actor.telegramUserId,
    chatId: input.actor.chatId,
    ...(input.actor.displayName === undefined ? {} : { displayName: input.actor.displayName }),
  };
}

export class GryphonCommandService {
  constructor(private readonly drop: DropService) {}

  async handle(input: GryphonCommandEnvelope): Promise<GryphonCommandResponse> {
    const actor = identity(input);
    if (input.command === "start" || input.command === "menu") {
      return response("Saturn is ready. Choose an action.", [[
        { text: "Create Drop code", command: "drop" },
        { text: "Status", command: "status" },
      ], [{ text: "Revoke Drop access", command: "revoke" }]]);
    }
    if (input.command === "drop") {
      const challenge = await this.drop.issueDropCodeForGryphon(actor);
      return response(`Saturn Drop code: ${challenge.code}\nExpires: ${challenge.expiresAt.toISOString()}\nEnter it only at the Saturn /drop page.`);
    }
    if (input.command === "revoke" || input.command === "binding_revoked") {
      const revoked = await this.drop.revokeGryphonAccess(actor);
      return response(`Saturn Drop access revoked: ${String(revoked.sessions)} session(s), ${String(revoked.challenges)} code(s).`);
    }
    if (input.command === "status") return response("Saturn status: Gryphon identity is linked; Drop access is available.");
    return response("Saturn commands: drop, revoke, status.");
  }
}

export class GryphonNotificationSink implements DropNotificationSink {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async #send(text: string, idempotencyKey: string = randomUUID()): Promise<void> {
    const payload = Buffer.from(JSON.stringify({ text, idempotencyKey }));
    await new Promise<void>((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        host: "gryphon.local",
        path: "/v1/service/notifications",
        method: "POST",
        timeout: this.timeoutMs,
        headers: {
          Host: "gryphon.local",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
        },
      }, (response) => {
        response.resume();
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) resolve();
          else reject(new Error(`Gryphon notification request failed with HTTP ${String(response.statusCode)}`));
        });
      });
      request.on("timeout", () => request.destroy(new Error("Gryphon notification request timed out")));
      request.on("error", reject);
      request.end(payload);
    });
  }

  securityAlert(): Promise<void> {
    return this.#send("Saturn alert: Drop code attempts reached the configured limit.");
  }

  uploadCompleted(_identity: TelegramIdentity, uploadId: string, filename: string, sizeBytes: number): Promise<void> {
    return this.#send(`Saturn Drop completed: ${filename} (${String(sizeBytes)} bytes).`, `drop-upload-completed:${uploadId}`);
  }
}
