import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, HttpStatus, Inject, Post, Req, UnauthorizedException, UseFilters, UseGuards } from "@nestjs/common";
import type { SaturnConfig } from "@saturn/config";
import type { DropService, TelegramSupervisor, TelegramUpdate, TelegramWebhookService } from "@saturn/drop";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { APP_CONFIG, DROP_SERVICE, TELEGRAM_SUPERVISOR, TELEGRAM_WEBHOOK_SERVICE } from "./tokens.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const updateSchema = z.looseObject({
  update_id: z.number().int(),
  message: z.looseObject({
    chat: z.looseObject({ id: z.number().int(), type: z.string() }),
    from: z.looseObject({ id: z.number().int(), is_bot: z.boolean(), first_name: z.string().max(128).optional(), last_name: z.string().max(128).optional() }).optional(),
    text: z.string().max(4_096).optional(),
  }).optional(),
});

function telegramUpdate(body: unknown): TelegramUpdate {
  const value = updateSchema.parse(body);
  const message = value.message;
  if (message === undefined) return { updateId: String(value.update_id) };
  const from = message.from;
  const displayName = from === undefined ? undefined : [from.first_name, from.last_name].filter(Boolean).join(" ") || undefined;
  return {
    updateId: String(value.update_id),
    message: {
      chatId: String(message.chat.id),
      chatType: message.chat.type,
      ...(from === undefined ? {} : { from: { userId: String(from.id), isBot: from.is_bot, ...(displayName === undefined ? {} : { displayName }) } }),
      ...(message.text === undefined ? {} : { text: message.text }),
    },
  };
}

@Controller("telegram")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class TelegramOwnerController {
  constructor(
    @Inject(DROP_SERVICE) private readonly drop: DropService,
    @Inject(TELEGRAM_SUPERVISOR) private readonly supervisor: TelegramSupervisor,
  ) {}

  @Post("link-challenges")
  @RequireRecentReauthentication()
  createLinkChallenge() { return this.drop.createLinkChallenge(); }

  @Get("status")
  async status() { return { provider: this.supervisor.status(), binding: await this.drop.getBinding() }; }

  @Delete("binding")
  @RequireRecentReauthentication()
  unlink() { return this.drop.unlink(); }
}

@Controller("internal/telegram")
@UseFilters(SaturnApiExceptionFilter)
export class TelegramWebhookController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: SaturnConfig,
    @Inject(TELEGRAM_WEBHOOK_SERVICE) private readonly telegram: TelegramWebhookService,
  ) {}

  @Post("webhook")
  @HttpCode(200)
  async webhook(
    @Headers("x-telegram-bot-api-secret-token") secret: string | undefined,
    @Headers("content-length") contentLength: string | undefined,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    if (contentLength !== undefined && Number(contentLength) > this.config.telegram.webhookMaxBytes) {
      throw new HttpException({ code: "payload_too_large" }, HttpStatus.PAYLOAD_TOO_LARGE);
    }
    if (!this.telegram.verifySecret(secret ?? "")) throw new UnauthorizedException();
    void request;
    return this.telegram.process(telegramUpdate(body));
  }
}
