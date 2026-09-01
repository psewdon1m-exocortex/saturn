import type { TelegramProvider } from "./types.js";

interface TelegramEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
}

export class TelegramProviderError extends Error {
  constructor() {
    super("Telegram provider request failed");
  }
}

export class TelegramHttpProvider implements TelegramProvider {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(input: { readonly token: string; readonly baseUrl?: string; readonly timeoutMs?: number }) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(input.token)) throw new Error("Telegram bot token is invalid");
    const base = new URL(input.baseUrl ?? "https://api.telegram.org/");
    if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
    this.#token = input.token;
    this.#baseUrl = base.toString();
    this.#timeoutMs = input.timeoutMs ?? 10_000;
  }

  async #request<T>(method: string, body: Readonly<Record<string, unknown>>): Promise<T> {
    try {
      const response = await fetch(new URL(`./bot${this.#token}/${method}`, this.#baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      const envelope = await response.json() as TelegramEnvelope<T>;
      if (!response.ok || !envelope.ok || envelope.result === undefined) throw new TelegramProviderError();
      return envelope.result;
    } catch (error) {
      throw error instanceof TelegramProviderError ? error : new TelegramProviderError();
    }
  }

  async getMe(): Promise<{ readonly id: string; readonly isBot: boolean; readonly username?: string }> {
    const result = await this.#request<{ readonly id: number; readonly is_bot: boolean; readonly username?: string }>("getMe", {});
    return { id: String(result.id), isBot: result.is_bot, ...(result.username === undefined ? {} : { username: result.username }) };
  }

  async setWebhook(input: { readonly url: string; readonly secretToken: string; readonly maxConnections: number }): Promise<void> {
    await this.#request<boolean>("setWebhook", {
      url: input.url,
      secret_token: input.secretToken,
      allowed_updates: ["message"],
      max_connections: input.maxConnections,
      drop_pending_updates: false,
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.#request<Record<string, unknown>>("sendMessage", { chat_id: chatId, text });
  }
}
