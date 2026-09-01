import { createHash, timingSafeEqual } from "node:crypto";
import type { DropNotificationSink, DropRepository, TelegramIdentity, TelegramProvider, TelegramUpdate } from "./types.js";
import type { DropService } from "./drop.service.js";

function secretEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

export class TelegramSupervisor {
  readonly #enabled: boolean;
  readonly #provider: TelegramProvider;
  readonly #publicOrigin: string;
  readonly #webhookSecret: string;
  readonly #maxConnections: number;
  #state: "disabled" | "starting" | "ready" | "degraded" = "disabled";
  #botIdentity: { readonly id: string; readonly username?: string } | undefined;

  constructor(input: { readonly enabled: boolean; readonly provider: TelegramProvider; readonly publicOrigin: string; readonly webhookSecret: string; readonly maxConnections: number }) {
    this.#enabled = input.enabled;
    this.#provider = input.provider;
    this.#publicOrigin = input.publicOrigin;
    this.#webhookSecret = input.webhookSecret;
    this.#maxConnections = input.maxConnections;
  }

  async initialize(): Promise<void> {
    if (!this.#enabled) { this.#state = "disabled"; return; }
    this.#state = "starting";
    try {
      const bot = await this.#provider.getMe();
      if (!bot.isBot) throw new Error("Telegram provider identity is not a bot");
      await this.#provider.setWebhook({
        url: new URL("/internal/telegram/webhook", this.#publicOrigin).toString(),
        secretToken: this.#webhookSecret,
        maxConnections: this.#maxConnections,
      });
      this.#botIdentity = { id: bot.id, ...(bot.username === undefined ? {} : { username: bot.username }) };
      this.#state = "ready";
    } catch {
      this.#state = "degraded";
    }
  }

  isReady(): boolean { return this.#state === "ready"; }
  status(): { readonly state: "disabled" | "starting" | "ready" | "degraded"; readonly bot?: { readonly id: string; readonly username?: string } } {
    return { state: this.#state, ...(this.#botIdentity === undefined ? {} : { bot: this.#botIdentity }) };
  }
}

export class TelegramNotifier implements DropNotificationSink {
  readonly #drop: DropService;
  readonly #provider: TelegramProvider;
  readonly #supervisor: TelegramSupervisor;

  constructor(drop: DropService, provider: TelegramProvider, supervisor: TelegramSupervisor) {
    this.#drop = drop;
    this.#provider = provider;
    this.#supervisor = supervisor;
  }

  async securityAlert(): Promise<void> {
    const binding = await this.#drop.getBinding();
    if (binding !== undefined && this.#supervisor.isReady()) await this.#provider.sendMessage(binding.chatId, "Saturn alert: Drop code attempts reached the configured limit.");
  }

  async uploadCompleted(identity: TelegramIdentity, filename: string, sizeBytes: number): Promise<void> {
    if (this.#supervisor.isReady()) await this.#provider.sendMessage(identity.chatId, `Saturn Drop completed: ${filename} (${String(sizeBytes)} bytes).`);
  }
}

export class TelegramWebhookService {
  readonly #drop: DropService;
  readonly #repository: DropRepository;
  readonly #provider: TelegramProvider;
  readonly #supervisor: TelegramSupervisor;
  readonly #webhookSecret: string;

  constructor(input: { readonly drop: DropService; readonly repository: DropRepository; readonly provider: TelegramProvider; readonly supervisor: TelegramSupervisor; readonly webhookSecret: string }) {
    this.#drop = input.drop;
    this.#repository = input.repository;
    this.#provider = input.provider;
    this.#supervisor = input.supervisor;
    this.#webhookSecret = input.webhookSecret;
  }

  verifySecret(candidate: string): boolean {
    return candidate.length > 0 && secretEqual(candidate, this.#webhookSecret);
  }

  async process(update: TelegramUpdate, now = new Date()): Promise<{ readonly state: "completed" | "duplicate" | "busy" }> {
    if (!this.#supervisor.isReady()) throw new Error("Telegram integration is not ready");
    const identity = this.#identity(update);
    const claim = await this.#repository.claimTelegramUpdate(update.updateId, identity?.userId, now);
    if (claim === "duplicate") return { state: "duplicate" };
    if (claim === "busy") return { state: "busy" };
    try {
      if (identity === undefined || update.message?.text === undefined) {
        await this.#repository.completeTelegramUpdate(update.updateId, now);
        return { state: "completed" };
      }
      const [rawCommand = "", argument = ""] = update.message.text.trim().split(/\s+/, 2);
      const command = rawCommand.toLowerCase().split("@")[0];
      let response: string;
      if (command === "/link") {
        try {
          await this.#drop.linkTelegram(argument, identity, now);
          response = "Saturn Telegram identity linked. Use /drop to receive an upload code.";
        } catch (error) {
          const existing = claim === "retry" ? await this.#drop.getBinding() : undefined;
          if (existing?.userId === identity.userId && existing.chatId === identity.chatId) response = "Saturn Telegram identity is linked.";
          else throw error;
        }
      } else if (command === "/drop" || command === "/revoke") {
        const current = await this.#drop.getBinding();
        if (current?.userId !== identity.userId || current.chatId !== identity.chatId) {
          response = "Saturn: this Telegram identity is not authorized.";
        } else if (command === "/drop") {
        const challenge = await this.#drop.issueDropCode(identity, now);
        response = `Saturn Drop code: ${challenge.code}\nExpires: ${challenge.expiresAt.toISOString()}\nEnter it only at the Saturn /drop page.`;
        } else {
          const revoked = await this.#drop.revokeAccess(identity, now);
          response = `Saturn Drop access revoked: ${String(revoked.sessions)} session(s), ${String(revoked.challenges)} code(s).`;
        }
      } else if (command === "/status") {
        const current = await this.#drop.getBinding();
        response = current?.userId === identity.userId && current.chatId === identity.chatId
          ? "Saturn status: identity bound; Drop access is available."
          : "Saturn status: this identity is not bound.";
      } else {
        response = "Saturn commands: /link CODE, /drop, /revoke, /status.";
      }
      await this.#provider.sendMessage(identity.chatId, response);
      await this.#repository.completeTelegramUpdate(update.updateId, new Date());
      return { state: "completed" };
    } catch (error) {
      await this.#repository.failTelegramUpdate(update.updateId, "command_failed", new Date()).catch(() => undefined);
      throw error;
    }
  }

  #identity(update: TelegramUpdate): TelegramIdentity | undefined {
    const message = update.message;
    const from = message?.from;
    if (message === undefined || from === undefined || from.isBot || message.chatType !== "private") return undefined;
    return { userId: from.userId, chatId: message.chatId, ...(from.displayName === undefined ? {} : { displayName: from.displayName }) };
  }
}
