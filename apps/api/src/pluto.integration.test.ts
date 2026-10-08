import "reflect-metadata";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Database, migrate } from "@saturn/database";
import { FileService, PostgresFileRepository } from "@saturn/file-core";
import { LocalStorageAdapter } from "@saturn/storage";
import { DeviceService, PostgresDeviceRepository } from "@saturn/sync";
import { expect, it } from "vitest";
import { PlutoController } from "./pluto.controller.js";
import { DEVICE_SERVICE } from "./tokens.js";

const databaseUrl = process.env.PLUTO_TEST_DATABASE_URL;

it.skipIf(!databaseUrl)("copies ordinary Pluto files through HTTP with PostgreSQL isolation, retained versions and revoke", async () => {
  if (!databaseUrl) throw new Error("An isolated, migrated PLUTO_TEST_DATABASE_URL is required");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-pluto-http-"));
  const admin = new Database(databaseUrl), schema = "pluto_qa_" + randomUUID().replaceAll("-", "");
  await admin.withSql(sql => sql.unsafe(`CREATE SCHEMA ${schema}`));
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.searchParams.set("options", "-csearch_path=" + schema);
  await migrate(isolatedUrl.toString());
  const database = new Database(isolatedUrl.toString()), storage = new LocalStorageAdapter(root);
  const files = new FileService(new PostgresFileRepository(database), storage);
  const devices = new DeviceService({ repository: new PostgresDeviceRepository(database), files,
    pepper: "isolated-pluto-test-pepper-1234567890", options: { enabled: true, publicOrigin: "https://saturn.test", uploadChunkMaxBytes: 1024, propfindMaxItems: 100, deleteMaxItems: 2, deleteWindowMs: 900000 } });
  @Module({ controllers: [PlutoController], providers: [{ provide: DEVICE_SERVICE, useValue: devices }] })
  class TestModule { readonly fixture = "pluto"; }
  const adapter = new FastifyAdapter({ logger: false });
  adapter.getInstance().addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  const app = await NestFactory.create<NestFastifyApplication>(TestModule, adapter, { logger: false });
  app.setGlobalPrefix("api/v1");
  try {
    await storage.initialize(); await files.initializeStorage(); await app.init(); await adapter.getInstance().ready();
    const enrollment = await devices.createPlutoEnrollment("External configs");
    const peer = await devices.createPlutoEnrollment("Other configs");
    const inject = adapter.getInstance().inject.bind(adapter.getInstance());
    const redeem = await inject({ method: "POST", url: "/api/v1/pluto/enrollments/redeem", payload: { code: enrollment.code, version: "0.1.0" } });
    expect(redeem.statusCode).toBe(201);
    const { token, device } = redeem.json<{ token: string; device: { id: string; syncRootId: string } }>();
    expect(device).toMatchObject({ deviceKind: "pluto", clientPlatform: "linux", syncFolderName: "External configs" });
    const headers = { authorization: `Bearer ${token}` };
    expect((await inject({ method: "POST", url: "/api/v1/pluto/enrollments/redeem", payload: { code: enrollment.code, version: "0.1.0" } })).statusCode).toBe(401);
    expect((await inject({ method: "GET", url: "/api/v1/pluto/files?path=etc/missing.conf", headers })).statusCode).toBe(404);
    expect((await inject({ method: "POST", url: "/api/v1/pluto/folders", headers, payload: { path: "etc" } })).statusCode).toBe(201);
    expect((await inject({ method: "GET", url: "/api/v1/pluto/files?path=..%2FOther%20configs", headers })).statusCode).toBe(400);
    let etag: string | undefined;
    for (let revision = 0; revision < 13; revision++) {
      const body = Buffer.from(`config revision ${String(revision)}`);
      const response = await inject({ method: "PUT", url: "/api/v1/pluto/files?path=etc/app.conf", headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(body.length), "x-content-sha256": createHash("sha256").update(body).digest("hex"), ...(etag ? { "if-match": etag } : { "if-none-match": "*" }) }, payload: body });
      expect(response.statusCode, response.body).toBe(200); etag = response.json<{etag:string}>().etag;
    }
    const context = await devices.authenticate(headers.authorization);
    const [entry] = await devices.propfind(context, "pluto/External configs/etc/app.conf", 0);
    if (entry === undefined || peer.device.syncRootId === undefined) throw new Error("Pipeline roots or uploaded entry are missing");
    const versions = await files.listVersions(entry.resource.id);
    expect(versions.filter(version => version.state === "active")).toHaveLength(10);
    expect(versions.filter(version => version.state === "expired")).toHaveLength(3);
    for (const version of versions.filter(version => version.state === "expired")) expect(await storage.exists(version.storagePath)).toBe(false);
    await expect(devices.propfind(context, "pluto/Other configs", 0)).rejects.toMatchObject({ code: "not_found" });
    await expect(devices.updateDevice(device.id, { scopeIds: [peer.device.syncRootId] })).rejects.toMatchObject({ code: "forbidden" });
    const checkin = await inject({ method: "POST", url: "/api/v1/pluto/check-in", headers, payload: { version: "0.1.0", status: { enabled: true, intervalSeconds: 60, uploadedFiles: 1, lastSuccessAt: new Date().toISOString() } } });
    expect(checkin.statusCode, checkin.body).toBe(201);
    expect((await devices.listDevices()).find(item => item.id === device.id)).toMatchObject({ plutoStatus: { enabled: true }, clientPlatform: "linux" });
    await devices.revokeDevice(device.id);
    expect((await inject({ method: "GET", url: "/api/v1/pluto/files?path=etc/app.conf", headers })).statusCode).toBe(401);
    const current = await files.openDownload(entry.resource.id); const chunks: Buffer[] = [];
    for await (const chunk of current.stream) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe("config revision 12");
  } finally {
    await app.close(); await database.close(); await storage.close(); await fs.rm(root, { recursive: true, force: true });
    await admin.withSql(async sql => { await sql`SET client_min_messages = warning`; await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`); });
    await admin.close();
  }
}, 30000);
