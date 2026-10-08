import "reflect-metadata";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { fastifyCookie } from "@fastify/cookie";
import type { FastifyPluginCallback } from "fastify";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Database, migrate } from "@saturn/database";
import { FileService, PostgresFileRepository, SYNC_RESOURCE_ID } from "@saturn/file-core";
import { ShareService, PostgresShareRepository } from "@saturn/shares";
import { LocalStorageAdapter } from "@saturn/storage";
import { expect, it } from "vitest";
import { PublicShareController } from "./share.controller.js";
import { APP_CONFIG, SHARE_SERVICE, SHARE_THUMBNAIL_SERVICE } from "./tokens.js";
import { TransferMonitorService } from "./transfer-monitor.service.js";

const databaseUrl = process.env.PLUTO_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("HEAD checks file, child and package headers without consuming download quota or streaming bytes", async () => {
  if (!databaseUrl) throw new Error("Database test configuration is missing");
  const schema = `share_head_${randomUUID().replaceAll("-", "")}`;
  const admin = new Database(databaseUrl);
  await admin.withSql(sql => sql.unsafe(`CREATE SCHEMA ${schema}`));
  const url = new URL(databaseUrl); url.searchParams.set("options", `-c search_path=${schema}`);
  await migrate(url.toString(), path.resolve("../../packages/database/migrations"));
  const database = new Database(url.toString()), root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-share-head-"));
  const storage = new LocalStorageAdapter(root), files = new FileService(new PostgresFileRepository(database), storage);
  const shares = new ShareService({ repository: new PostgresShareRepository(database), files, storage,
    pepper: "share-head-test-pepper-with-at-least-32-characters",
    options: { enabled: true, publicOrigin: "https://saturn.test", defaultExpiryMs: 3600000, maxExpiryMs: 86400000, sessionTtlMs: 1800000,
      passwordFailureLimit: 5, passwordFailureWindowMs: 900000, packageMaxFiles: 100, packageMaxBytes: 1048576, packageMaxDurationMs: 60000, streamRevalidateBytes: 65536 } });
  let streamCount = 0;
  @Module({ controllers: [PublicShareController], providers: [
    { provide: APP_CONFIG, useValue: { environment: "test", publicOrigin: "https://saturn.test" } },
    { provide: SHARE_SERVICE, useValue: shares }, { provide: SHARE_THUMBNAIL_SERVICE, useValue: {} },
    { provide: TransferMonitorService, useValue: { trackDownload: (stream: Readable) => { streamCount++; return stream; } } },
  ] }) class TestModule { readonly fixture = "share-head"; }
  const adapter = new FastifyAdapter();
  await adapter.getInstance().register(fastifyCookie as unknown as FastifyPluginCallback);
  const app = await NestFactory.create<NestFastifyApplication>(TestModule, adapter, { logger: false });
  app.setGlobalPrefix("api/v1");
  try {
    await storage.initialize(); await files.initializeStorage(); await app.init(); await adapter.getInstance().ready();
    const folder = await files.createFolder(SYNC_RESOURCE_ID, "Shared");
    const upload = await files.createUpload({ parentId: folder.id, filename: "valuable.txt", expectedSize: 6, idempotencyKey: randomUUID() });
    await files.appendUpload(upload.id, 0, 6, Readable.from(["abcdef"])); const file = (await files.completeUpload(upload.id)).resource;
    const single = await shares.createShare({ resourceId: file.id, mode: "download", maxDownloads: 1 });
    const tree = await shares.createShare({ resourceId: folder.id, mode: "download_folder", maxDownloads: 1 });
    const access = { sourceIp: "127.0.0.1", userAgent: "head-regression" };
    await shares.preparePackage(tree.token, access); await shares.runNextPackage();
    const inject = adapter.getInstance().inject.bind(adapter.getInstance());
    for (const route of [`${single.token}/content`, `${tree.token}/content/${file.id}`, `${tree.token}/package`]) {
      const response = await inject({ method: "HEAD", url: `/api/v1/public/shares/${route}`, headers: { "user-agent": access.userAgent } });
      expect(response.statusCode, `${route.split("/").slice(1).join("/")}: ${response.body}`).toBe(200); expect(Number(response.headers["content-length"])).toBeGreaterThan(0); expect(response.body).toBe("");
    }
    const range = await inject({ method: "HEAD", url: `/api/v1/public/shares/${single.token}/content`, headers: { range: "bytes=1-3" } });
    expect(range.statusCode).toBe(206); expect(range.headers["content-length"]).toBe("3");
    expect(streamCount).toBe(0); expect((await shares.listShares()).every(share => share.downloadCount === 0)).toBe(true);
    const get = await inject({ method: "GET", url: `/api/v1/public/shares/${single.token}/content` });
    expect(get.statusCode, get.body).toBe(200); expect(get.body).toBe("abcdef");
    expect((await shares.listShares()).find(share => share.id === single.share.id)?.downloadCount).toBe(1);
    expect((await inject({ method: "HEAD", url: `/api/v1/public/shares/${single.token}/content` })).statusCode).toBe(401);
    const locked = await shares.createShare({ resourceId: file.id, mode: "download", password: "protected" });
    expect((await inject({ method: "HEAD", url: `/api/v1/public/shares/${locked.token}/content` })).statusCode).toBe(401);
  } finally {
    await app.close(); await database.close(); await storage.close(); await fs.rm(root, { recursive: true, force: true });
    await admin.withSql(async sql => { await sql`SET client_min_messages = warning`; await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`); }); await admin.close();
  }
}, 30000);
