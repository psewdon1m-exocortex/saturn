import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Body, Controller, Headers, Inject, NotFoundException, Post, UnauthorizedException, UseFilters } from "@nestjs/common";
import type { SaturnConfig } from "@saturn/config";
import { GryphonCommandService, type GryphonCommandEnvelope } from "@saturn/drop";
import { z } from "zod";
import { APP_CONFIG, DROP_SERVICE, GRYPHON_EVENT_STORE } from "./tokens.js";
import type { DropService } from "@saturn/drop";
import { GryphonEventStore } from "./gryphon-event.store.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const commandSchema = z.strictObject({
  schema: z.literal("exocortex.telegram.command.v1"),
  eventId: z.string().min(1).max(200),
  correlationId: z.string().min(1).max(200),
  connectionId: z.string().min(1).max(200),
  serviceId: z.literal("saturn"),
  actor: z.strictObject({
    telegramUserId: z.string().regex(/^[1-9]\d{0,18}$/),
    chatId: z.string().regex(/^-?[1-9]\d{0,18}$/),
    chatType: z.literal("private"),
    displayName: z.string().max(256).optional(),
  }),
  command: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  arguments: z.record(z.string(), z.unknown()),
});

function equal(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

@Controller("internal/gryphon")
@UseFilters(SaturnApiExceptionFilter)
export class GryphonController {
  readonly #commands: GryphonCommandService;

  constructor(
    @Inject(APP_CONFIG) private readonly config: SaturnConfig,
    @Inject(DROP_SERVICE) drop: DropService,
    @Inject(GRYPHON_EVENT_STORE) private readonly events: GryphonEventStore,
  ) {
    this.#commands = new GryphonCommandService(drop);
  }

  @Post("command")
  async command(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    if (!this.config.gryphon.enabled || this.config.gryphon.serviceTokenFile === undefined) throw new NotFoundException();
    const expected = (await readFile(this.config.gryphon.serviceTokenFile, "utf8")).replace(/[\r\n]+$/, "");
    const supplied = (authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!supplied || !equal(supplied, expected)) throw new UnauthorizedException();
    const envelope = commandSchema.parse(body) as GryphonCommandEnvelope;
    const cached = await this.events.begin(envelope.eventId);
    if (cached !== undefined) return cached;
    try {
      const result = await this.#commands.handle(envelope);
      await this.events.complete(envelope.eventId, result);
      return result;
    } catch (error) {
      await this.events.fail(envelope.eventId).catch(() => undefined);
      throw error;
    }
  }
}
