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
import { SyncClientController } from "./sync-client.controller.js";
import { AUTH_SERVICE, DEVICE_SERVICE } from "./tokens.js";

const databaseUrl = process.env.PLUTO_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("resumes scoped Windows uploads, rejects stale preconditions, peers and revoked tokens", async () => {
  if (!databaseUrl) throw new Error("Isolated test database is required");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-sync-http-"));
  const admin = new Database(databaseUrl), schema = "sync_qa_" + randomUUID().replaceAll("-", "");
  await admin.withSql(sql => sql.unsafe(`CREATE SCHEMA ${schema}`));
  const url = new URL(databaseUrl); url.searchParams.set("options", "-csearch_path=" + schema); await migrate(url.toString());
  const db = new Database(url.toString()), storage = new LocalStorageAdapter(root);
  const files = new FileService(new PostgresFileRepository(db), storage);
  const devices = new DeviceService({ repository: new PostgresDeviceRepository(db), files, pepper: "sync-http-fixture-pepper-1234567890", options: { enabled: true, publicOrigin: "https://saturn.test", uploadChunkMaxBytes: 1024, propfindMaxItems: 100, deleteMaxItems: 2, deleteWindowMs: 900000 } });
  @Module({ controllers: [SyncClientController], providers: [{ provide: DEVICE_SERVICE, useValue: devices }, { provide: AUTH_SERVICE, useValue: {} }] })
  class TestModule { readonly fixture = "sync"; }
  const adapter = new FastifyAdapter({ logger: false }); adapter.getInstance().addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  const app = await NestFactory.create<NestFastifyApplication>(TestModule, adapter, { logger: false }); app.setGlobalPrefix("api/v1");
  try {
    await storage.initialize(); await files.initializeStorage(); await app.init(); await adapter.getInstance().ready();
    const enrollment = await devices.createWindowsEnrollment("Win A"), peerEnrollment = await devices.createWindowsEnrollment("Win B");
    const a = await devices.redeemWindowsEnrollment(enrollment.code, "fixture"), b = await devices.redeemWindowsEnrollment(peerEnrollment.code, "fixture");
    const headers = { authorization: `Bearer ${a.token}` }, peerHeaders = { authorization: `Bearer ${b.token}` };
    const inject = adapter.getInstance().inject.bind(adapter.getInstance()); const body = Buffer.from("valuable-file"), digest = createHash("sha256").update(body).digest("hex");
    const payload = { path: "sync/Win A/config.txt", expectedSize: body.length, expectedSha256: digest, idempotencyKey: "a".repeat(64), ifNoneMatch: "*" };
    const first = await inject({ method: "POST", url: "/api/v1/sync/uploads", headers, payload }); expect(first.statusCode,first.body).toBe(201);
    const { id } = first.json<{id:string}>(), target = "/api/v1/sync/uploads/" + id;
    expect((await inject({ method: "GET", url: target, headers: peerHeaders })).statusCode).toBe(404);
    expect((await inject({ method: "POST", url: "/api/v1/sync/uploads", headers, payload: { ...payload, path: "sync/Win B/config.txt", idempotencyKey: "b".repeat(64) } })).statusCode).toBe(404);
    const append = (offset:number,chunk:Buffer) => inject({ method: "PATCH", url: target, headers: { ...headers, "upload-offset": String(offset), "content-length": String(chunk.length), "content-type": "application/octet-stream" }, payload: chunk });
    expect((await append(0,body.subarray(0,4))).statusCode).toBe(200);
    const resumed = await inject({ method: "POST", url: "/api/v1/sync/uploads", headers, payload }); expect(resumed.json<{id:string;receivedSize:number}>()).toMatchObject({id,receivedSize:4});
    expect((await append(0,body.subarray(0,4))).statusCode).toBe(409); expect((await append(4,body.subarray(4))).statusCode).toBe(200);
    const complete = await inject({ method: "POST", url: target + "/complete", headers }); expect(complete.statusCode,complete.body).toBe(201); expect(complete.json<{etag:string}>().etag).toBe(`"sha256-${digest}"`);
    expect((await inject({ method: "POST", url: "/api/v1/sync/uploads", headers, payload: { ...payload, idempotencyKey: "c".repeat(64), ifMatch:'"stale"' } })).statusCode).toBe(412);
    const cancel = (key:string,authorization=headers) => inject({method:"POST",url:"/api/v1/sync/uploads/cancel",headers:authorization,payload:{idempotencyKey:key}});
    expect((await cancel(payload.idempotencyKey)).json()).toMatchObject({id,status:"active"});
    const partialPayload={...payload,path:"sync/Win A/cancel.txt",idempotencyKey:"d".repeat(64)};
    const partialResponse=await inject({method:"POST",url:"/api/v1/sync/uploads",headers,payload:partialPayload});
    const partialId=partialResponse.json<{id:string}>().id;
    const partial=await files.getUpload(partialId);
    await files.appendUpload(partialId,0,4,(await import("node:stream")).Readable.from(body.subarray(0,4)));
    expect((await cancel(partialPayload.idempotencyKey,peerHeaders)).json()).toMatchObject({status:"absent"});
    expect((await files.getUpload(partialId)).status).toBe("uploading");
    await db.withSql(sql=>sql`UPDATE upload_sessions SET expires_at=now()-interval '1 minute' WHERE id=${partialId}`);
    expect((await cancel(partialPayload.idempotencyKey)).json()).toMatchObject({id:partialId,status:"abandoned"});
    expect(await storage.exists(partial.tempPath)).toBe(false);
    expect((await cancel(partialPayload.idempotencyKey)).json()).toMatchObject({status:"abandoned"});
    expect((await cancel("not-a-key")).statusCode).toBe(400);
    await devices.revokeDevice(a.device.id); expect((await inject({ method: "GET", url: target, headers })).statusCode).toBe(401);
    expect(await storage.exists("sync/Win A/config.txt")).toBe(true);
  } finally {
    await app.close(); await db.close(); await storage.close(); await fs.rm(root,{recursive:true,force:true});
    await admin.withSql(async sql => { await sql`SET client_min_messages=warning`; await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`); }); await admin.close();
  }
},30000);
