import "reflect-metadata";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fastifyCookie } from "@fastify/cookie";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { encodeOwnerAccessKey, loadEnvironment, type SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";
import type { GuardedRuntime } from "../../../packages/sync/src/guarded-runtime.js";
import { guardedSyncRuntimeHttp } from "./guarded-sync-runtime-http.js";
import { GUARDED_RUNTIME, DATABASE, FILE_SERVICE, STORAGE_ADAPTER } from "./tokens.js";
import type { FileService } from "@saturn/file-core";
import type { StorageAdapter } from "@saturn/storage";
import { expect } from "vitest";

/** Actual ordinary AppModule providers. Tests use the TypeScript metadata emitter,
 * as does the application's compiler; no providers/adapters/auth are overridden. */
export interface OrdinaryFixtureInput {
  directory: string; databaseUrl: string; storage: SaturnConfig["storage"]; manifestFile: string;
  ownerKey: string; authPepper: string; devicePepper: string; rootId: string; deviceToken: string;
}
export async function ordinaryFixtureEnvironment(input: OrdinaryFixtureInput): Promise<Record<string, string>> {
  const passwordFile = input.storage.passwordFile;
  if (passwordFile === undefined) throw new Error("Owned ordinary fixture requires its password file");
  const directory = path.join(input.directory, "ordinary-nest"); await fs.mkdir(directory);
  const owner = path.join(directory, "owner.private"), pepper = path.join(directory, "pepper.private"), device = path.join(directory, "device.private"), auth = path.join(directory, "auth.private");
  await fs.writeFile(owner, encodeOwnerAccessKey(input.ownerKey), { mode: 0o600 });
  await fs.writeFile(pepper, randomUUID() + randomUUID(), { mode: 0o600 });
  await fs.writeFile(device, input.devicePepper, { mode: 0o600 }); await fs.writeFile(auth, input.authPepper, { mode: 0o600 });
  return {
    NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_URL: input.databaseUrl, DATABASE_PASSWORD_FILE: "", PUBLIC_ORIGIN: "https://fixture.invalid", KERNEL_URL: "", KERNEL_TOKEN_FILE: "",
    OWNER_BOOTSTRAP_TOKEN_FILE: owner, AUTH_PEPPER_FILE: auth, DEVICE_PEPPER_FILE: device,
    DROP_PEPPER_FILE: pepper, SHARE_PEPPER_FILE: pepper, BACKUP_PEPPER_FILE: pepper, LABORATORY_PEPPER_FILE: pepper,
    STORAGE_HOST: input.storage.host, STORAGE_PORT: String(input.storage.port), STORAGE_USER: input.storage.username,
    STORAGE_ROOT: input.storage.root, STORAGE_HOST_FINGERPRINT: input.storage.hostFingerprint, STORAGE_AUTH_MODE: "password_file", STORAGE_PASSWORD_FILE: passwordFile, STORAGE_PRIVATE_KEY_FILE: "",
    STORAGE_OPERATION_TIMEOUT_MS: String(input.storage.operationTimeoutMs), STORAGE_HEALTH_TIMEOUT_MS: String(input.storage.healthTimeoutMs), STORAGE_MAX_CONNECTIONS: String(input.storage.maxConnections), STORAGE_REQUIRE_FSYNC: String(input.storage.requireFsync ?? false),
    STORAGE_RUNTIME_CONFIG_DIR: path.join(directory, "storage-runtime"), DROP_BUFFER_DIRECTORY: path.join(directory, "drop"),
    RECOVERY_SPOOL_DIR: path.join(directory, "recovery-spool"), RECOVERY_ARCHIVE_DIR: path.join(directory, "recovery-archive"), ARCHIVE_SPOOL_DIR: path.join(directory, "archive-spool"),
    API_HOST: "127.0.0.1", API_PORT: "3000", WEBDAV_ENABLED: "true", SATURN_GUARDED_RUNTIME_MANIFEST: input.manifestFile,
  };
}
export async function qualifyOrdinaryNest(input: OrdinaryFixtureInput): Promise<void> {
  const values = await ordinaryFixtureEnvironment(input), directory = path.join(input.directory, "ordinary-nest");
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  let app: NestFastifyApplication | undefined;
  try {
    const configuration = loadEnvironment(); expect(configuration.storage).toEqual(input.storage);
    const { AppModule } = await import("./app.module.js");
    const adapter = new FastifyAdapter({ logger: false, bodyLimit: configuration.limits.uploadChunkMaxBytes });
    await adapter.getInstance().register(fastifyCookie);
    app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api/v1");
    const database = app.get<Database>(DATABASE), runtime = app.get<GuardedRuntime>(GUARDED_RUNTIME);
    expect(app.get<FileService>(FILE_SERVICE)).toBe(runtime.legacyFiles); expect(app.get<StorageAdapter>(STORAGE_ADAPTER)).toBe(runtime.legacyStorage);
    await adapter.getInstance().register(guardedSyncRuntimeHttp, { runtime, database }); await app.listen(0, "127.0.0.1");
    const bound = app.getHttpServer().address() as { port: number }, origin = "http://127.0.0.1:" + String(bound.port);
    const request = async (route: string, body: unknown, token: string) => fetch(origin + route, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await fetch(origin + "/sync/v1/roots/" + input.rootId + "/capabilities", { headers: { Authorization: "Bearer " + input.deviceToken } })).status).toBe(200);
    expect((await request("/api/v1/folders", { name: "ordinary-no-auth" }, "invalid" )).status).toBe(401);
    const folder = await request("/api/v1/folders", { name: "ordinary-root-" + randomUUID() }, input.ownerKey); expect(folder.status).toBe(201);
    const windows = await request("/api/v1/devices/enrollments", { name: "ordinary-nest-windows" }, input.ownerKey); expect(windows.status).toBe(201);
    const enrollment = await windows.json() as { code: string };
    const redeemed = await request("/api/v1/device-enrollments/redeem", { code: enrollment.code, version: "ordinary-nest-fixture" }, "unused"); expect(redeemed.status).toBe(201);
    const client = await redeemed.json() as { token: string };
    expect((await request("/api/v1/device-session/heartbeat", { platform: "windows", version: "ordinary-nest-fixture" }, client.token)).status).toBe(201);
    await fs.writeFile(path.join(directory, "result.json"), JSON.stringify({ passed: true, actualAppModule: true, providersOverridden: false, guardedStorageIdentity: true,
      capability: 200, ownerRejected: 401, rootFolder: 201, enrollment: 201, redeemed: 201, deviceHeartbeat: 201 }, null, 2));
  } finally {
    await app?.close(); for (const [key, value] of Object.entries(old)) { if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value; }
  }
}
