import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DropServiceError } from "@saturn/drop";
import { expect, it, vi } from "vitest";
import { DropController } from "./drop.controller.js";
import { APP_CONFIG, AUTH_SERVICE, DROP_SERVICE } from "./tokens.js";

it.each([
  { failureWindowMs: 60_000, retryAfter: "60" },
  { failureWindowMs: 60_001, retryAfter: "61" },
  { failureWindowMs: 900_000, retryAfter: "900" },
])("returns the configured retry window through HTTP for $failureWindowMs ms", async ({ failureWindowMs, retryAfter }) => {
  const redeem = vi.fn(async () => { throw new DropServiceError("rate_limited"); });
  @Module({
    controllers: [DropController],
    providers: [
      { provide: APP_CONFIG, useValue: { environment: "production", publicOrigin: "https://saturn.test", drop: { failureWindowMs } } },
      { provide: AUTH_SERVICE, useValue: {} },
      { provide: DROP_SERVICE, useValue: { redeem } },
    ],
  })
  class FixtureModule { readonly fixture = "drop-rate-refusal"; }
  const adapter = new FastifyAdapter({ logger: false });
  const app = await NestFactory.create<NestFastifyApplication>(FixtureModule, adapter, { logger: false });
  app.setGlobalPrefix("api/v1");
  try {
    await app.init();
    await adapter.getInstance().ready();
    const limited = await adapter.getInstance().inject({
      method: "POST", url: "/api/v1/drop/redeem", headers: { origin: "https://saturn.test" }, payload: { code: "x" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe(retryAfter);
    expect(limited.json()).toEqual({ code: "drop_unavailable" });
    expect(limited.headers["set-cookie"]).toBeUndefined();

    const forbidden = await adapter.getInstance().inject({
      method: "POST", url: "/api/v1/drop/redeem", headers: { origin: "https://foreign.test" }, payload: { code: "x" },
    });
    expect(forbidden.statusCode).toBe(401);
    expect(forbidden.headers["retry-after"]).toBeUndefined();
    expect(redeem).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
