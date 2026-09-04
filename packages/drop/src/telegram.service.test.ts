import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { DropService } from "./drop.service.js";
import { TelegramHttpProvider, TelegramProviderError } from "./telegram-provider.js";
import { TelegramSupervisor, TelegramWebhookService } from "./telegram.service.js";
import type { DropRepository, TelegramProvider } from "./types.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); });

async function providerServer() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      calls.push({ path: request.url ?? "", body });
      response.setHeader("Content-Type", "application/json");
      if (request.url?.endsWith("/getMe") === true) response.end(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, username: "vault_bot" } }));
      else if (request.url?.endsWith("/setWebhook") === true) response.end(JSON.stringify({ ok: true, result: true }));
      else response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  return { calls, baseUrl: `http://127.0.0.1:${String(address.port)}/` };
}

describe("Telegram provider and webhook", () => {
  it("validates the bot and registers only message updates without surfacing its token", async () => {
    const mock = await providerServer();
    const token = "100000:abcdefghijklmnopqrstuvwxyz_123456";
    const provider = new TelegramHttpProvider({ token, baseUrl: mock.baseUrl, timeoutMs: 2_000 });
    await expect(provider.getMe()).resolves.toMatchObject({ id: "123", isBot: true });
    await expect(provider.setWebhook({ url: "https://vault.test/internal/telegram/webhook", secretToken: "webhook_secret-123", maxConnections: 8 })).resolves.toBeUndefined();
    const supervisor = new TelegramSupervisor({ enabled: true, provider, publicOrigin: "https://vault.test", webhookSecret: "webhook_secret-123", maxConnections: 8 });
    await supervisor.initialize();
    expect(supervisor.status()).toMatchObject({ state: "ready", bot: { id: "123", username: "vault_bot" } });
    expect(mock.calls.map((call) => call.path)).toEqual([`/bot${token}/getMe`, `/bot${token}/setWebhook`, `/bot${token}/getMe`, `/bot${token}/setWebhook`]);
    expect(mock.calls[3]?.body).toMatchObject({ url: "https://vault.test/internal/telegram/webhook", secret_token: "webhook_secret-123", allowed_updates: ["message"], max_connections: 8 });

    const failing = new TelegramHttpProvider({ token, baseUrl: "http://127.0.0.1:1/", timeoutMs: 1_000 });
    const error = await failing.getMe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramProviderError);
    expect(String(error)).not.toContain(token);
  });

  it("deduplicates update IDs and derives identity only from a private non-bot sender", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const provider: TelegramProvider = {
      getMe: () => Promise.resolve({ id: "999", isBot: true }),
      setWebhook: () => Promise.resolve(),
      sendMessage: (chatId, text) => { sent.push({ chatId, text }); return Promise.resolve(); },
    };
    const states = new Map<string, "processing" | "completed" | "failed">();
    const repository = {
      claimTelegramUpdate: (id: string) => { const state = states.get(id); if (state === "completed") return Promise.resolve("duplicate" as const); if (state === "processing") return Promise.resolve("busy" as const); states.set(id, "processing"); return Promise.resolve(state === "failed" ? "retry" as const : "claimed" as const); },
      completeTelegramUpdate: (id: string) => { states.set(id, "completed"); return Promise.resolve(); },
      failTelegramUpdate: (id: string) => { states.set(id, "failed"); return Promise.resolve(); },
    } as unknown as DropRepository;
    const drop = {
      issueDropCodeForTelegram: (identity: { readonly userId: string; readonly chatId: string }) => identity.userId === "42" && identity.chatId === "42"
        ? Promise.resolve({ code: "ABCD-EFGH", expiresAt: new Date("2026-08-26T01:05:00Z") })
        : Promise.reject(new Error("not bound")),
      getBinding: () => Promise.resolve({ userId: "42", chatId: "42", boundAt: new Date(), updatedAt: new Date() }),
    } as unknown as DropService;
    const supervisor = new TelegramSupervisor({ enabled: true, provider, publicOrigin: "https://vault.test", webhookSecret: "secret-value", maxConnections: 8 });
    await supervisor.initialize();
    const service = new TelegramWebhookService({ drop, repository, provider, supervisor, webhookSecret: "secret-value" });
    expect(service.verifySecret("wrong")).toBe(false);
    expect(service.verifySecret("secret-value")).toBe(true);
    const update = { updateId: "100", message: { chatId: "42", chatType: "private", from: { userId: "42", isBot: false }, text: "/drop" } };
    await expect(service.process(update, new Date("2026-08-26T01:00:00Z"))).resolves.toEqual({ state: "completed" });
    await expect(service.process(update, new Date("2026-08-26T01:00:01Z"))).resolves.toEqual({ state: "duplicate" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("ABCD-EFGH");
    await service.process({ updateId: "101", message: { chatId: "-1", chatType: "group", from: { userId: "42", isBot: false }, text: "/drop" } });
    expect(sent).toHaveLength(1);
  });
});
