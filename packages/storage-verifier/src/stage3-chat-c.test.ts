import { requireDefined } from "../../contracts/src/require-defined.js";
import { afterEach, expect, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmod, chown, link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { connect, createServer as createSocketServer } from "node:net";
import { StorageVerifyError, parseStorageVerifyRequest, parseStorageVerifyResult } from "../../contracts/src/storage-verifier.js";
import { RegistryAuthority, parseHostConfig } from "./authority.js";
import { HostVerifier } from "./verifier.js";
import { createVerifierServer } from "./server.js";
import * as files from "./secure-files.js";
import { StorageVerifierClient } from "../../storage/src/storage-verifier.client.js";

type HandleRead = (this: {fd:number}, buffer:Buffer, offset?:number, length?:number, position?:number|null) => Promise<{bytesRead:number;buffer:Buffer}>;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await requireDefined(cleanups.pop())(); });
const digest = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const signal = () => new AbortController().signal;
const barrier = () => { let release!: () => void; const wait = new Promise<void>(r => { release = r; }); return { wait, release }; };
async function fixture(size = 131089) {
  expect(process.platform).toBe("linux");
  const base = await mkdtemp(join(tmpdir(), "stage3-c-host-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const content = join(base, "content"), registry = join(base, "registry"), secretFile = join(base, "secret");
  for (const p of [join(content, "private"), join(registry, "owners"), join(registry, "operations")]) await mkdir(p, { recursive: true, mode: 0o700 });
  const data = Buffer.alloc(size); for (let i = 0; i < size; i++) data[i] = (314159 + i * 31) % 251;
  const file = join(content, "private", "Агентность, локус контроля, инициативность.md");
  await writeFile(file, data, { mode: 0o600 });
  const token = "fixture-canary-" + randomUUID(); await writeFile(secretFile, token, { mode: 0o600 });
  const request = parseStorageVerifyRequest({ schema: "saturn.storage-verify.v1", requestId: randomUUID(), backendIdentity: "fixture-c-host", backendGeneration: randomUUID(), ownerId: randomUUID(), fencingToken: randomUUID(), rootId: randomUUID(), operationId: randomUUID(), intentSha256: digest("intent"), contentVersionId: randomUUID(), relativePath: "private/Агентность, локус контроля, инициативность.md", sizeBytes: String(size), sha256: digest(data), maximumBytes: "1073741824", timeoutMs: 30000, requireDurability: "file-sync" });
  const owner = { schema: "saturn.storage-verifier-owner.v1", state: "ACTIVE", backendIdentity: request.backendIdentity, backendGeneration: request.backendGeneration, ownerId: request.ownerId, fencingToken: request.fencingToken };
  const object = { contentVersionId: request.contentVersionId, relativePath: request.relativePath, sizeBytes: request.sizeBytes, sha256: request.sha256 };
  const operation = { ...owner, schema: "saturn.storage-verifier-operation.v1", state: "SEALED", rootId: request.rootId, operationId: request.operationId, intentSha256: request.intentSha256, objects: [object] };
  const ownerFile = join(registry, "owners", digest(request.backendIdentity) + ".json"), operationFile = join(registry, "operations", request.operationId + ".json");
  const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await save(ownerFile, owner); await save(operationFile, operation);
  const config = parseHostConfig({ schema: "saturn.storage-verifier-host.v1", listenHost: "127.0.0.1", port: 12345, secretFile, registryDirectory: registry, roots: [{ rootId: request.rootId, backendIdentity: request.backendIdentity, directory: content, prefixes: ["private"] }], maximumActive: 4, maximumBytes: "1073741824" });
  const authority = new RegistryAuthority(config), verifier = new HostVerifier(authority);
  return { base, content, registry, secretFile, token, data, file, request, owner, object, operation, ownerFile, operationFile, save, config, authority, verifier };
}
async function serve(f: Awaited<ReturnType<typeof fixture>>) {
  const service = await createVerifierServer(f.config);
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { service.server.closeAllConnections(); if (service.server.listening) await service.shutdown(); });
  const address = service.server.address(); if (!address || typeof address === "string") throw Error("address");
  const post = (body: unknown = f.request, token = f.token) => fetch(`http://127.0.0.1:${String(address.port)}/v1/verify`, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { ...service, port: address.port, post };
}

test.each([1, 16, "single"] as const)("C14 authorized objects %s and file-sync receipt", async count => {
  const f = await fixture();
  if (count === "single") { const common = Object.fromEntries(Object.entries(f.operation).filter(([key]) => key !== "objects")); await f.save(f.operationFile, { ...common, ...f.object }); }
  else await f.save(f.operationFile, { ...f.operation, objects: Array.from({ length: count }, (_, i) => i ? { ...f.object, contentVersionId: randomUUID(), relativePath: `private/${String(i)}` } : f.object) });
  const result = await f.verifier.verify(f.request, signal());
  expect(parseStorageVerifyResult(result, f.request).durability).toBe("file-sync");
  expect(result.sha256).toBe(digest(await readFile(f.file)));
  expect(f.verifier.activeRequests).toBe(0);
});
test.each(["zero", "seventeen", "duplicate", "rootId", "ownerId", "backendGeneration", "operationId", "intentSha256", "relativePath", "sha256"])("C14 authority refuses %s before content open", async field => {
  const f = await fixture(); const operation: Record<string, unknown> = { ...f.operation };
  if (field === "zero") operation.objects = [];
  else if (field === "seventeen") operation.objects = Array.from({ length: 17 }, () => f.object);
  else if (field === "duplicate") operation.objects = [f.object, f.object];
  else if (field === "relativePath" || field === "sha256") operation.objects = [{ ...f.object, [field]: field === "sha256" ? "0".repeat(64) : "private/foreign" }];
  else operation[field] = field === "intentSha256" ? "0".repeat(64) : randomUUID();
  await f.save(f.operationFile, operation);
  const opened = vi.spyOn(files, "openBeneath");
  await expect(f.verifier.verify(f.request, signal())).rejects.toMatchObject({ code: "identity_mismatch" });
  expect(opened).not.toHaveBeenCalled(); expect(f.verifier.activeRequests).toBe(0);
});
test.each(["owner-public", "operation-public", "owner-symlink", "secret-public", "secret-symlink"])("C14 protected authority %s", async kind => {
  const f = await fixture(); const p = kind.startsWith("secret") ? f.secretFile : kind.startsWith("owner") ? f.ownerFile : f.operationFile;
  if (kind.endsWith("public")) await chmod(p, 0o644); else { await rename(p, p + ".real"); await symlink(p + ".real", p); }
  const attempt = kind.startsWith("secret") ? createVerifierServer(f.config) : f.verifier.verify(f.request, signal());
  await expect(attempt).rejects.toMatchObject({ code: "scope_denied" });
});
test("C14 HTTP bearer, strict authority and nonloopback TLS", async () => {
  const f = await fixture(), s = await serve(f);
  expect((await s.post(f.request, "wrong")).status).toBe(401);
  expect((await s.post({ ...f.request, foreignAuthority: true })).status).toBe(400);
  expect((await s.post({ ...f.request, rootId: randomUUID() })).status).toBe(403);
  expect((await s.post({ ...f.request, ownerId: randomUUID() })).status).toBe(409);
  expect(() => parseHostConfig({ ...f.config, listenHost: "0.0.0.0" })).toThrow();
  expect(() => parseHostConfig({ ...f.config, secretFile: f.file })).toThrow();
  const response = await s.post(); expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain(f.token);
});

test.each(["ancestor-symlink", "file-symlink", "hardlink"])("C15 no-follow refuses %s", async fault => {
  const f = await fixture();
  if (fault === "ancestor-symlink") { const p = join(f.content, "private"); await rename(p, p + ".old"); await symlink(p + ".old", p); }
  else if (fault === "file-symlink") { await rename(f.file, f.file + ".old"); await symlink(f.file + ".old", f.file); }
  else await link(f.file, f.file + ".link");
  await expect(f.verifier.verify(f.request, signal())).rejects.toMatchObject({ code: "scope_denied" });
});
test.each(["rename-recreate", "ancestor-rename", "ancestor-symlink", "hardlink", "same-size", "owner-generation", "operation-witness", "file-symlink"])("C15 barrier during hash %s", async fault => {
  const f = await fixture(262161), probe = await open(f.file, "r"), prototype = Object.getPrototypeOf(probe) as {read: HandleRead}; await probe.close();
  const entered = barrier(), proceed = barrier(); let once = false;
  const original = Object.getOwnPropertyDescriptor(prototype, "read")?.value as HandleRead;
  vi.spyOn(prototype, "read").mockImplementation(async function(this: { fd: number }, ...args: Parameters<HandleRead>) {
    const result = await original.apply(this, args);
    if (!once && args[0] instanceof Buffer && args[0].length === 65536) { once = true; entered.release(); await proceed.wait; }
    return result;
  });
  const result = f.verifier.verify(f.request, signal()).then(value => ({ value }), (error: unknown) => ({ error }));
  await entered.wait;
  if (fault === "rename-recreate") { await rename(f.file, f.file + ".old"); await writeFile(f.file, f.data); }
  if (fault === "same-size") { const changed = Buffer.from(f.data); changed[changed.length - 1] = requireDefined(changed[changed.length - 1]) ^ 1; await writeFile(f.file, changed); }
  if (fault === "owner-generation") await f.save(f.ownerFile, { ...f.owner, backendGeneration: randomUUID() });
  if (fault === "operation-witness") await f.save(f.operationFile, { ...f.operation, observed: true });
  if (fault === "file-symlink") { await rename(f.file, f.file + ".old"); await symlink(f.file + ".old", f.file); }
  if (fault === "ancestor-rename" || fault === "ancestor-symlink") { const p = join(f.content, "private"); await rename(p, p + ".old"); if (fault === "ancestor-symlink") await symlink(p + ".old", p); else { await mkdir(p); await writeFile(f.file, f.data); } }
  if (fault === "hardlink") await link(f.file, f.file + ".link");
  proceed.release(); const outcome = await result;
  expect(outcome).toHaveProperty("error"); expect(f.verifier.activeRequests).toBe(0);
});

test("C14 K4 HTTP caller artifacts for integration", async () => {
  const f = await fixture(), s = await serve(f), response = await s.post();
  expect(response.status).toBe(200); const result = parseStorageVerifyResult(await response.json(), f.request);
  if (process.env.STAGE3_C_EVIDENCE) await writeFile(join(process.env.STAGE3_C_EVIDENCE, "verifier-k4-http.json"), JSON.stringify({ request: f.request, response: result }, null, 2));
});

test("C14 A12 contract consumer verifies native response and typed refusals", async () => {
  const f = await fixture(), s = await serve(f);
  const client = new StorageVerifierClient({ url: `http://127.0.0.1:${String(s.port)}`, token: f.token });
  expect((await client.verify(f.request)).sha256).toBe(digest(f.data));
  await expect(client.verify({ ...f.request, ownerId: randomUUID() })).rejects.toMatchObject({ code: "identity_mismatch" });
  const denied = new StorageVerifierClient({ url: `http://127.0.0.1:${String(s.port)}`, token: "wrong-bearer-".repeat(4) });
  await expect(denied.verify(f.request)).rejects.toMatchObject({ code: "unauthorized" });
  await expect(client.verify({ ...f.request, sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "identity_mismatch" });
});
test("C15 final witness reauthorizes and refuses changed owner", async () => {
  const f = await fixture(); const authorize = f.authority.authorize.bind(f.authority); let calls = 0;
  vi.spyOn(f.authority, "authorize").mockImplementation(async request => { if (++calls === 2) await f.save(f.ownerFile, { ...f.owner, ownerId: randomUUID() }); return authorize(request); });
  await expect(f.verifier.verify(f.request, signal())).rejects.toMatchObject({ code: "identity_mismatch" }); expect(calls).toBe(2);
});

test("C16 active limit four, cancellation releases slots, valid retry", async () => {
  const f = await fixture(), entered = barrier(), proceed = barrier(); const authorize = f.authority.authorize.bind(f.authority); let calls = 0;
  vi.spyOn(f.authority, "authorize").mockImplementation(async r => { if (++calls <= 4) { if (calls === 4) entered.release(); await proceed.wait; } return authorize(r); });
  const cancel = new AbortController(); const running = Array.from({ length: 4 }, () => f.verifier.verify(f.request, cancel.signal).catch((e: unknown) => e));
  await entered.wait; expect(f.verifier.activeRequests).toBe(4);
  await expect(f.verifier.verify(f.request, signal())).rejects.toMatchObject({ code: "capacity" });
  cancel.abort(); proceed.release(); const results = await Promise.all(running); expect(results.every(r => r instanceof StorageVerifyError && r.code === "cancelled")).toBe(true); expect(f.verifier.activeRequests).toBe(0);
  expect((await f.verifier.verify(f.request, signal())).status).toBe("VERIFIED");
});
test("C16 HTTP body/header/size bounds and subsequent valid request", async () => {
  const f = await fixture(), s = await serve(f);
  expect((await s.post({ ...f.request, sizeBytes: "1073741825", maximumBytes: "1073741825" })).status).toBe(400);
  expect((await s.post(" ".repeat(65537))).status).toBe(400);
  const code = await new Promise<number>((resolve, reject) => { const r = httpRequest({ host: "127.0.0.1", port: s.port, headers: { "x-large": "x".repeat(10000) } }, response => { response.resume(); resolve(requireDefined(response.statusCode)); }); r.on("error", reject); r.end(); });
  expect(code).toBe(431); expect((await s.post()).status).toBe(200);
});
test("C16 shutdown cancels stalled request and joins within watchdog", async () => {
  const f = await fixture(), s = await serve(f), connected = barrier();
  const socket = connect(s.port, "127.0.0.1", () => { socket.write(`POST /v1/verify HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.token}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{`); connected.release(); });
  socket.on("error", () => undefined); cleanups.push(async () => { socket.destroy(); }); await connected.wait;
  // A completed loopback request is a barrier proving the stalled request has entered the server.
  expect((await s.post()).status).toBe(200);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([s.shutdown(), new Promise<never>((_, reject) => { watchdog = setTimeout(() => { socket.destroy(); reject(Error("shutdown did not join stalled body")); }, 1500); })]); }
  finally { clearTimeout(watchdog); socket.destroy(); }
  expect(s.verifier.activeRequests).toBe(0);
});

test("C14 wrong native UID authority is refused", async () => {
  const f = await fixture(); expect(process.geteuid?.()).toBe(0);
  await chown(f.ownerFile, 65534, 65534);
  await expect(f.verifier.verify(f.request, signal())).rejects.toMatchObject({ code: "scope_denied" });
});
test.each(["ancestor", "file"])("C15 barrier before opening %s never follows substituted symlink", async kind => {
  const f = await fixture(), original = files.openBeneath; let once = false;
  const foreign = join(f.base, "foreign"); await mkdir(foreign); await writeFile(join(foreign, "canary"), "foreign-content-canary");
  vi.spyOn(files, "openBeneath").mockImplementation(async (root, relative) => {
    if (!once) { once = true; if (kind === "ancestor") { await rename(join(f.content, "private"), join(f.content, "old")); await symlink(foreign, join(f.content, "private")); } else { await rename(f.file, f.file + ".old"); await symlink(join(foreign, "canary"), f.file); } }
    return original(root, relative);
  });
  await expect(f.verifier.verify(f.request, signal())).rejects.toMatchObject({ code: "scope_denied" });
  expect(await readFile(join(foreign, "canary"), "utf8")).toBe("foreign-content-canary");
});
test("C16 deadline between syscalls and bounded buffers", async () => {
  const f = await fixture(262161), probe = await open(f.file, "r"), prototype = Object.getPrototypeOf(probe) as {read: HandleRead}; await probe.close();
  const original = Object.getOwnPropertyDescriptor(prototype, "read")?.value as HandleRead; let reads = 0; let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(prototype, "read").mockImplementation(async function(this: { fd: number }, ...args: Parameters<HandleRead>) {
    if (args[0] instanceof Buffer && args[0].length === 65536) { expect(Number(args[2])).toBeLessThanOrEqual(65536); reads++; now = 30001; }
    return original.apply(this, args);
  });
  await expect(f.verifier.verify(f.request, signal())).rejects.toMatchObject({ code: "cancelled" });
  expect(reads).toBe(1); expect(f.verifier.activeRequests).toBe(0);
});
test("C16 package entrypoint starts, verifies K4 and joins SIGTERM", async () => {
  const f = await fixture(); const reservation = createSocketServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); if (!address || typeof address === "string") throw Error("reservation address");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const configFile = join(f.base, "host.json"); await f.save(configFile, { ...f.config, port: address.port });
  const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  const child = spawn(process.execPath, [entry, configFile], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (b:Buffer) => { output += b.toString(); }); child.stderr.on("data", (b:Buffer) => { output += b.toString(); });
  const exit = new Promise<number | null>(resolve => child.once("exit", resolve));
  cleanups.push(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await exit; });
  let response: Response | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error("entrypoint exited: " + output);
    try { response = await fetch(`http://127.0.0.1:${String(address.port)}/v1/verify`, { method: "POST", headers: { authorization: "Bearer " + f.token, "content-type": "application/json" }, body: JSON.stringify(f.request) }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  expect(response?.status).toBe(200); expect(parseStorageVerifyResult(await requireDefined(response).json(), f.request).status).toBe("VERIFIED");
  child.kill("SIGTERM"); expect(await exit).toBe(0); expect(output).not.toContain(f.token);
});

test.each(["disconnect", "shutdown"])("C16 %s during a real hash joins IO and releases admission", async action => {
  const f = await fixture(262161), s = await serve(f), probe = await open(f.file, "r"), prototype = Object.getPrototypeOf(probe) as {read: HandleRead}; await probe.close();
  const original = Object.getOwnPropertyDescriptor(prototype, "read")?.value as HandleRead, entered = barrier(), proceed = barrier(); let first = true;
  vi.spyOn(prototype, "read").mockImplementation(async function(this: { fd: number }, ...args: Parameters<HandleRead>) {
    const result = await original.apply(this, args);
    if (first && args[0] instanceof Buffer && args[0].length === 65536) { first = false; entered.release(); await proceed.wait; }
    return result;
  });
  const cancel = new AbortController();
  const response = fetch(`http://127.0.0.1:${String(s.port)}/v1/verify`, { method: "POST", headers: { authorization: "Bearer " + f.token, "content-type": "application/json" }, body: JSON.stringify(f.request), signal: cancel.signal }).catch((error: unknown) => error);
  await entered.wait; expect(s.verifier.activeRequests).toBe(1);
  let shutdown: Promise<void> | undefined;
  if (action === "shutdown") shutdown = s.shutdown(); else cancel.abort();
  expect(s.verifier.activeRequests).toBe(1); // In-flight syscall/barrier has not joined yet.
  proceed.release(); await response;
  if (shutdown) await shutdown;
  else {
    for (let i = 0; s.verifier.activeRequests && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect((await s.post()).status).toBe(200);
  }
  expect(s.verifier.activeRequests).toBe(0);
});

