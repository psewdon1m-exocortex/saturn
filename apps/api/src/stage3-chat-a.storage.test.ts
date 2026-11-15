import {captureFixtureDocker} from "./stage3-chat-a.fault-snapshot.fixture.js";
import {startOwnedFixtureProcess,requireNormalFixtureExit} from "./stage3-chat-a.owned-process.fixture.js";
import type { SaturnConfig } from "@saturn/config";
import { parseFixtureContainer } from "./docker-container.fixture.js";
interface OwnedContainer {containerId:string;created:string;runId:string;image:string}
import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { LocalStorageAdapter, SftpStorageAdapter } from "@saturn/storage";
import { DurableBackendExecutor } from "../../../packages/storage/src/durable-backend-executor.js";
import { StorageVerifierClient } from "../../../packages/storage/src/storage-verifier.client.js";
import { storageVerifyResult } from "../../../packages/contracts/src/storage-verifier.js";
import { backendFixture, barrier, uid, sha, evidence, activeFixture } from "./stage3-chat-a.fixture.js";
import { IntegrityScrubService } from "../../../packages/protection/src/integrity-scrub.service.js";
import { FileService, PostgresFileRepository } from "@saturn/file-core";
import { CatalogUploadDatabaseCoordinator } from "../../../packages/file-core/src/catalog-upload-database.js";

it("A03 SQL single owner, queued write, heartbeat expiry cannot steal and clean drain", async () => {
  const f = await backendFixture("A03"), secondRaw = new LocalStorageAdapter(path.join(f.directory, "storage")), second = new DurableBackendExecutor(secondRaw, f.command, f.backendIdentity, f.generation);
  const entered = barrier(), release = barrier(), trace: string[] = [];
  const original = f.raw.mkdir.bind(f.raw);
  vi.spyOn(f.raw, "mkdir").mockImplementation(async p => { trace.push("start:" + p); if (p === "held") { entered.release(); await release.entered; } await original(p); trace.push("end:" + p); });
  try {
    await f.executor.start(); await second.start();
    const first = f.executor.mkdir("held"); await entered.entered;
    const next = second.mkdir("next");
    await vi.waitFor(async () => expect((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_tasks WHERE state='QUEUED'`)).length).toBe(1));
    await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE sync_backend_executor SET heartbeat_at=now()-interval '10 years'`);
    expect(await f.command("acquire", second.identity, {})).toEqual({ owned: false });
    expect(trace).toEqual(["start:held"]);
    release.release(); await Promise.all([first, next]);
    expect(trace).toEqual(["start:held", "end:held", "start:next", "end:next"]);
    await second.close(); await f.executor.close();
    expect((await f.executor.diagnostics()).state).toBe("STOPPED");
    await evidence("A03", "writer-trace", { trace, tasks: await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,state FROM sync_backend_tasks`) });
  } finally { release.release(); await second.close(); await f.close(); }
}, 30000);

it.each(["size", "hash", "type", "current-path", "foreign-prefix", "missing-retention", "missing-ordinary"])("A08 physical delete proof %s preserves bytes on refusal", async mode => {
  const f = await backendFixture("A08-physical-" + mode), resourceId = uid(), versionId = uid(), id = uid(), bytes = Buffer.from("retention-314159");
  const target = mode === "current-path" ? "live/current" : mode === "foreign-prefix" ? `_system/versions/${uid()}/${versionId}/file` : `_system/versions/${resourceId}/${versionId}/file`;
  await fs.mkdir(path.dirname(path.join(f.directory, "storage", target)), { recursive: true });
  if (mode === "type") await f.raw.mkdir(target);
  else if (!mode.startsWith("missing")) await f.raw.write(target, Readable.from(mode === "size" ? Buffer.concat([bytes, Buffer.from("+")]) : mode === "hash" ? Buffer.alloc(bytes.length, 32) : bytes), { offset: 0, create: true });
  try {
    await f.executor.start();
    await f.command("submit", f.executor.identity, { id, command: "delete", body: { path: target, ...(mode === "missing-ordinary" ? {} : { retention: { resourceId, versionId, sizeBytes: String(bytes.length), sha256: sha(bytes) } }) }, reservedBytes: "0" });
    const expected = mode === "missing-retention" ? "DONE" : "UNKNOWN";
    await vi.waitFor(async () => expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT state FROM sync_backend_tasks WHERE id=${id}`))[0]).state).toBe(expected));
    expect(await f.raw.exists(target)).toBe(!mode.startsWith("missing"));
    if (expected === "UNKNOWN") await expect(f.executor.close()).rejects.toThrow("backend_close_unconfirmed");
    await evidence("A08", "physical-" + mode, { id, target, expected, originalSize: bytes.length, originalSha256: sha(bytes), actual: await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,state,payload FROM sync_backend_tasks WHERE id=${id}`) });
  } finally { await f.executor.close().catch(() => undefined); await Promise.all([f.writer.close(), f.runtime.close(), f.admin.close()]); }
}, 30000);

it.each(["close", "sql-drain"])("A03 %s failure never records STOPPED", async mode => {
  const f = await backendFixture("A03-closure-" + mode);
  const command: ConstructorParameters<typeof DurableBackendExecutor>[1] = async (name, identity, payload) => { if (mode === "sql-drain" && name === "drain") throw Error("fixture SQL drain unavailable"); return f.command(name, identity, payload); };
  const executor = new DurableBackendExecutor(f.raw, command, f.backendIdentity, f.generation);
  if (mode === "close") vi.spyOn(f.raw, "close").mockRejectedValue(Error("fixture physical closure failed"));
  try {
    await executor.start(); await expect(executor.close()).rejects.toThrow("backend_close_unconfirmed");
    const state = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT state FROM sync_backend_executor WHERE backend_identity=${f.backendIdentity}`);
    expect(requireDefined(state[0]).state).not.toBe("STOPPED"); await evidence("A03", "closure-" + mode, state);
  } finally { await Promise.all([f.writer.close(), f.runtime.close(), f.admin.close()]); }
}, 30000);

it("A12 upload fallback hashes once; native proof reads only the MIME prefix and uses one slot", async () => {
  const f = await activeFixture("A12-integration"), bytes = Buffer.alloc(65536, 31), originalRead = f.executor.openRead.bind(f.executor);
  let storageReads = 0, hostBytes = 0;
  vi.spyOn(f.executor, "openRead").mockImplementation(async (p, o) => {
    const source = await originalRead(p, o);
    return Readable.from((async function* () { for await (const b of source) { storageReads += Buffer.byteLength(b as Uint8Array); yield b as Uint8Array; } })());
  });
  const native = new LocalStorageAdapter(path.join(f.directory, "storage"), async () => {
    await f.executor.assertOwner();
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_read_slots WHERE state='ACTIVE'`)).toHaveLength(1);
  });
  const results: Record<string, number> = {};
  try {
    for (const mode of ["unsupported", "verifier_unavailable", "capacity", "cancelled", "identity_mismatch", "scope_denied", "source_changed", "verification_failed", "native"]) {
      storageReads = 0;
      const files = new FileService(new PostgresFileRepository(f.runtime), f.executor, { catalogBackendIdentity: f.backendIdentity, catalogRootAdmission: f.admission, catalogUploadCoordinator: new CatalogUploadDatabaseCoordinator(f.writer, f.issuer, "1073741824", true), catalogVerify: async (prepared, p, size, hash, contentVersionId) => {
        if (mode !== "native") throw Object.assign(Error(mode), { code: mode });
        await f.executor.withReadBudget(async () => { await native.verify({ ...verifyRequest(bytes), backendIdentity: f.backendIdentity, ownerId: f.executor.identity.ownerId, fencingToken: f.executor.identity.fencingToken, backendGeneration: f.generation, rootId: f.rootId, operationId: prepared.status.session.uploadId, contentVersionId, relativePath: p, sizeBytes: size, sha256: hash }); hostBytes += Number(size); });
      } });
      const input = f.uploadInput(mode, bytes); let prepared = await files.prepareCatalogUpload(input, f.proof); prepared = await files.appendCatalogUpload(prepared, f.proof, "0", bytes);
      if (["identity_mismatch", "scope_denied", "source_changed", "verification_failed"].includes(mode)) {
        await expect(files.completeCatalogUpload(prepared, f.proof)).rejects.toMatchObject({ code: mode }); expect(storageReads).toBe(0);
        expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM resources WHERE parent_id=${f.rootId} AND name=${mode}`)).toHaveLength(0);
        await files.cancelCatalogUpload(prepared, f.proof);
      } else {
        expect((await files.completeCatalogUpload(prepared, f.proof)).status.result?.status).toBe("PUBLISHED");
        // Fallback hashing already supplies the MIME prefix. Only the external
        // verifier needs a separate prefix read through the storage adapter.
        expect(storageReads).toBe(mode === "native" ? 512 : bytes.length);
      }
      results[mode] = storageReads;
    }
    expect(hostBytes).toBe(bytes.length); expect(requireDefined(results.unsupported) - requireDefined(results.native)).toBe(bytes.length - 512);
    await evidence("A12", "readback-savings", { results, hostBytes, nativeAuthority: "SQL current owner checked before and after native hash/fsync", directoryDurabilityClaimed: false });
  } finally { await f.close(); }
}, 90000);
it("A04 three shared reads include metadata; throw releases; close drains callbacks", async () => {
  const f = await backendFixture("A04");
  const source = Buffer.from("abc"); await f.raw.write("bytes", Readable.from(source), { offset: 0, create: true });
  const streams: Readable[] = [], entered = barrier(), release = barrier();
  try {
    await f.executor.start();
    for (let n = 0; n < 3; n++) streams.push(await f.executor.openRead("bytes"));
    const stat = vi.spyOn(f.raw, "stat"), pending = f.executor.stat("bytes");
    await vi.waitFor(async () => expect((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_read_slots WHERE state='WAITING'`)).length).toBe(1));
    expect(stat).not.toHaveBeenCalled();
    requireDefined(streams[0]).destroy(); expect((await pending).size).toBe(3);
    await expect(f.executor.stat("missing")).rejects.toThrow();
    const original = f.raw.exists.bind(f.raw);
    vi.spyOn(f.raw, "exists").mockImplementation(async p => { entered.release(); await release.entered; return original(p); });
    const action = f.executor.exists("bytes"); await entered.entered;
    let closed = false; const closing = f.executor.close().then(() => { closed = true; });
    for (const stream of streams) stream.destroy();
    await expect(f.executor.stat("bytes")).rejects.toMatchObject({ code: "backend_draining" });
    expect(closed).toBe(false); release.release(); expect(await action).toBe(true); await closing;
    const d = await f.executor.diagnostics(); expect(d.state).toBe("STOPPED");
    expect((d.process as { metadataCalls: number }).metadataCalls).toBe(3);
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_read_slots`)).toHaveLength(0);
    await evidence("A04", "diagnostics", d);
  } finally { release.release(); for (const stream of streams) stream.destroy(); await f.close(); }
}, 30000);
function verifyRequest(bytes: Buffer) { return { schema: "saturn.storage-verify.v1" as const, requestId: uid(), backendIdentity: "fixture", backendGeneration: uid(), ownerId: uid(), fencingToken: uid(), rootId: uid(), operationId: uid(), intentSha256: sha("intent"), contentVersionId: uid(), relativePath: "file", sizeBytes: String(bytes.length), sha256: sha(bytes), maximumBytes: String(bytes.length), timeoutMs: 30000, requireDurability: "file-sync" as const }; }
it("A12 native local verification needs ownership, verifies bytes and rejects changed authority/hash", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stage3-a12-")), bytes = Buffer.alloc(65536, 41), request = verifyRequest(bytes);
  let checks = 0; const raw = new LocalStorageAdapter(dir, async () => { checks++; });
  await raw.write("file", Readable.from(bytes), { offset: 0, create: true });
  const noAuthority = new LocalStorageAdapter(dir);
  await expect(noAuthority.verify(request)).rejects.toMatchObject({ code: "unsupported" });
  expect(await raw.verify(request)).toMatchObject({ sha256: sha(bytes), sizeBytes: String(bytes.length), durability: "file-sync" }); expect(checks).toBe(2);
  await fs.writeFile(path.join(dir, "file"), Buffer.alloc(bytes.length, 42));
  await expect(raw.verify(request)).rejects.toMatchObject({ code: "verification_failed" });
  const denied = new LocalStorageAdapter(dir, async () => { throw Error("owner changed"); });
  await expect(denied.verify(request)).rejects.toThrow("owner changed");
  await evidence("A12", "native-local", { directory: dir, ownershipChecks: checks, bytes: bytes.length, sha256: sha(bytes) });
});
it.each(["unsupported", "verifier_unavailable", "capacity", "cancelled", "identity_mismatch", "source_changed", "verification_failed", "scope_denied"])("A12 remote preserves typed %s", async code => {
  const request = verifyRequest(Buffer.from("x"));
  const client = new StorageVerifierClient({ url: "http://127.0.0.1:12345", token: "a".repeat(32), fetch: async () => new Response(JSON.stringify({ code }), { status: 409 }) });
  await expect(client.verify(request)).rejects.toMatchObject({ code });
});
it("A12 remote rejects forged receipt and nonloopback HTTP before transport", async () => {
  const request = verifyRequest(Buffer.from("x")), valid = storageVerifyResult(request, "file-sync");
  for (const [field, value, code] of [["sha256", sha("other"), "verification_failed"], ["ownerId", uid(), "identity_mismatch"], ["durability", "directory-sync", "invalid_input"]]) {
    const client = new StorageVerifierClient({ url: "http://127.0.0.1", token: "a".repeat(32), fetch: async () => new Response(JSON.stringify({ ...valid, [requireDefined(field)]: value })) });
    await expect(client.verify(request)).rejects.toMatchObject({ code });
  }
  expect(() => new StorageVerifierClient({ url: "http://remote.invalid", token: "a".repeat(32) })).toThrow("invalid_input");
});

it("A01 A12 native Linux K4 objects and actual remote client", async () => {
  const directory = path.join(requireDefined(process.env.STAGE3_CHAT_A_EVIDENCE), "linux-host"), fixture = JSON.parse((await fs.readFile(path.join(directory, "fixture.json"), "utf8")).replace(/^\uFEFF/, "")) as OwnedContainer;
  const commands=path.join(directory,"commands");await fs.mkdir(commands,{recursive:true});
  const container = parseFixtureContainer((await captureFixtureDocker(commands,["inspect",fixture.containerId])).toString());
  expect(container.Id).toBe(fixture.containerId); expect(container.Created).toBe(fixture.created); expect(container.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId); expect(container.Image).toBe(fixture.image);
  const sources = JSON.parse(await fs.readFile(path.join(directory, "source-hashes.json"), "utf8")) as {file:string;sha256:string}[];
  for (const source of sources) expect(sha(await fs.readFile(path.resolve(source.file)))).toBe(source.sha256);
  const started=performance.now();
  const output=await captureFixtureDocker(commands,["exec",fixture.containerId,"node","apps/api/src/stage3-chat-a.verifier-linux.mjs"]);
  expect(performance.now()-started).toBeLessThanOrEqual(45000);
  expect(JSON.parse(output.toString())).toMatchObject({ selected: 10, passed: 10, failed: 0 });
  await evidence("A12", "linux-native", JSON.parse(await fs.readFile(path.join(directory, "result.json"), "utf8")));
}, 60000);

it("A03 native SFTP leased stream and handshake clients close before adapter drain", async () => {
  if (!process.env.STAGE3_CHAT_A_SFTP) throw Error("STAGE3_CHAT_A_SFTP required; native SFTP cannot be skipped");
  const f = JSON.parse((await fs.readFile(process.env.STAGE3_CHAT_A_SFTP, "utf8")).replace(/^\uFEFF/, "")) as OwnedContainer & {functionalScope:string;storage:SaturnConfig["storage"]};
  const commands=path.join(requireDefined(process.env.STAGE3_CHAT_A_EVIDENCE),"A03","native-sftp-commands");await fs.mkdir(commands,{recursive:true});
  const c=parseFixtureContainer((await captureFixtureDocker(commands,["inspect",f.containerId])).toString());
  expect(c.Id).toBe(f.containerId); expect(c.Created).toBe(f.created); expect(c.Image).toBe(f.image); expect(c.Config.Labels["exocortex.release.run"]).toBe(f.runId); expect(c.Config.Labels["exocortex.functional.scope"]).toBe(f.functionalScope); expect(c.State.Running).toBe(true);
  const raw = new SftpStorageAdapter(f.storage); raw.enableExactPaths();
  const directory = uid(), file = directory + "/Агентность, локус контроля, инициативность.md", bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 31);
  await evidence("A03","native-sftp-intent",{containerId:f.containerId,directory,file,size:bytes.length,sha256:sha(bytes)});
  try {
  await raw.mkdir(directory); await raw.mkdir(directory + "/empty");
  await raw.write(file, Readable.from(bytes), { offset: 0, create: true });
  const stream = await raw.openRead(file); stream.on("error", () => undefined);
  const closed = new Promise<void>(resolve => stream.once("close", resolve));
  await raw.close(); await closed;
  await expect(raw.stat(file)).rejects.toThrow();
  const fresh = new SftpStorageAdapter(f.storage), pending = fresh.stat(file).catch((e: unknown) => e);
  try { await fresh.close(); expect(await pending).toBeInstanceOf(Error); } finally { await fresh.close(); }
  await evidence("A03", "native-sftp", { containerId: f.containerId, directory, size: bytes.length, sha256: sha(bytes), streamClosed: stream.destroyed });
  } finally { await raw.close(); }
}, 30000);

it("A14 cancellation during native file read releases slot; foreground progresses and restart rehashes", async () => {
  const f = await activeFixture("A14-midfile"), entered = barrier(), release = barrier(), controller = new AbortController();
  try {
    const bytes = Buffer.alloc(131073, 37); await f.upload(f.uploadInput("large", bytes), bytes);
    const read = f.raw.openRead.bind(f.raw); let physicalBytes = 0;
    const intercept = vi.spyOn(f.raw, "openRead").mockImplementation(async (p, o) => {
      const stream = await read(p, o);
      return Readable.from((async function* () {
        try { for await (const chunk of stream) { physicalBytes += Buffer.byteLength(chunk as Uint8Array); yield chunk as Uint8Array; entered.release(); await release.entered; controller.signal.throwIfAborted(); } }
        finally { stream.destroy(); }
      })());
    });
    const options = { maximumBytes: 1048576, maximumMs: 10000, quarantine: async () => { throw Error("partial hash must not quarantine"); } };
    const pending = new IntegrityScrubService(f.runtime, f.executor, options).run(10, controller.signal);
    await entered.entered; expect(physicalBytes).toBeGreaterThan(0); expect(physicalBytes).toBeLessThan(bytes.length);
    await f.executor.mkdir("foreground-during-scrub"); expect(await f.executor.exists("foreground-during-scrub")).toBe(true);
    controller.abort(); release.release(); expect(await pending).toMatchObject({ checked: 0, mismatched: 0, deferred: true }); intercept.mockRestore();
    expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT last_version_id FROM integrity_scrub_state`))[0]).last_version_id).toBe("");
    expect(await new IntegrityScrubService(f.runtime, f.executor, options).run()).toMatchObject({ checked: 1, mismatched: 0, bytes: bytes.length });
    await evidence("A14", "mid-file-cancel", { physicalBytesBeforeCancel: physicalBytes, rehashedBytes: bytes.length, foregroundCompleted: true });
  } finally { release.release(); await f.close(); }
}, 30000);

it("A14 cooperative scrub partial hash, restart, corruption of history preserves current", async () => {
  const f = await activeFixture("A14");
  try {
    const bytes = Buffer.alloc(65537, 19), first = await f.upload(f.uploadInput("scrub", bytes), bytes);
    expect(first.status.result?.status).toBe("PUBLISHED");
    const r = requireDefined((await f.admin.withSql(sql => sql<{ id: string; metadata_version: string; current_version_id: string }[]>`SELECT id,metadata_version,current_version_id FROM resources WHERE parent_id=${f.rootId} AND name='scrub'`))[0]);
    const quarantine: ConstructorParameters<typeof IntegrityScrubService>[2] = { maximumBytes: 32768, maximumMs: 10000, quarantine: async row => {
      const current = requireDefined((await f.admin.withSql(sql => sql<{ metadata_version: string }[]>`SELECT metadata_version FROM resources WHERE id=${row.resource_id}`))[0]);
      await f.mutations.markUnavailable({ schema: "saturn.namespace-mutation.v1", kind: "availability", operationId: uid(), idempotencyKey: uid(), rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, expected: { kind: "version", node_id: row.resource_id, version: current.metadata_version }, availability: "UNAVAILABLE", reason: "integrity_scrub", contentVersionId: row.id, sha256: row.sha256 }, f.namespace); return true;
    } };
    const scrub = new IntegrityScrubService(f.runtime, f.executor, quarantine);
    expect(await scrub.run()).toMatchObject({ checked: 0, bytes: 32768, deferred: true });
    expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT last_version_id FROM integrity_scrub_state`))[0]).last_version_id).toBe("");
    const restarted = new IntegrityScrubService(f.runtime, f.executor, quarantine);
    expect(await restarted.run()).toMatchObject({ checked: 0, bytes: 32768, deferred: true });
    expect(await restarted.run()).toMatchObject({ checked: 0, bytes: 32768, deferred: true });
    expect(await restarted.run()).toMatchObject({ checked: 1, bytes: 1, mismatched: 0 });
    const currentBytes = Buffer.from("current"), second = await f.upload(f.uploadInput("scrub", currentBytes, { nodeId: r.id, metadataVersion: r.metadata_version, versionId: r.current_version_id }), currentBytes);
    expect(second.status.result?.status).toBe("PUBLISHED");
    const old = requireDefined((await f.admin.withSql(sql => sql<{ storage_path: string }[]>`SELECT storage_path FROM file_versions WHERE id=${r.current_version_id}`))[0]);
    await f.raw.write(old.storage_path, Readable.from(Buffer.alloc(bytes.length, 20)), { offset: 0, create: false, truncate: true });
    await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE integrity_scrub_state SET last_version_id=''`);
    const large = new IntegrityScrubService(f.runtime, f.executor, { ...quarantine, maximumBytes: 1048576 });
    const result = await large.run(); expect(result.mismatched).toBe(1);
    expect((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT sync_availability,status FROM resources WHERE id=${r.id}`))[0]).toEqual({ sync_availability: "AVAILABLE", status: "active" });
    expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT state FROM file_versions WHERE id=${r.current_version_id}`))[0]).state).toBe("error");
    const current = requireDefined((await f.admin.withSql(sql => sql<{ storage_path: string; current_version_id: string }[]>`SELECT storage_path,current_version_id FROM resources WHERE id=${r.id}`))[0]);
    await f.raw.write(current.storage_path, Readable.from(Buffer.alloc(currentBytes.length, 21)), { offset: 0, create: false, truncate: true });
    await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE integrity_scrub_state SET last_version_id=''`);
    const cancelled = new AbortController(); cancelled.abort();
    expect(await large.run(10, cancelled.signal)).toMatchObject({ checked: 0, deferred: true });
    expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT last_version_id FROM integrity_scrub_state`))[0]).last_version_id).toBe("");
    const rootSeq = requireDefined((await f.admin.withSql(sql => sql<{published_seq:string}[]>`SELECT published_seq FROM sync_root_clock WHERE root_id=${f.rootId}`))[0]).published_seq;
    expect(await new IntegrityScrubService(f.runtime, f.executor, { ...quarantine, maximumBytes: 1048576 }).run()).toMatchObject({ checked: 1, mismatched: 1 });
    expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT sync_availability FROM resources WHERE id=${r.id}`))[0]).sync_availability).toBe("UNAVAILABLE");
    expect(BigInt(requireDefined((await f.admin.withSql(sql => sql<{published_seq:string}[]>`SELECT published_seq FROM sync_root_clock WHERE root_id=${f.rootId}`))[0]).published_seq)).toBeGreaterThan(BigInt(rootSeq));
    await evidence("A14", "scrub", { result, historyVersion: r.current_version_id, sourceBytes: bytes.length });
  } finally { await f.close(); }
}, 60000);

it("A04 native second process holds two slots; metadata, writer, scrub aging and cancellation share admission", async () => {
  const f = await backendFixture("A04-process"), helper = fileURLToPath(new URL("./stage3-chat-a.executor-helper.mts", import.meta.url));
  const writerUrl = new URL(f.url); writerUrl.username = f.roles.writerLogin;
  const config = path.join(f.directory, "child.json");
  await fs.writeFile(config, JSON.stringify({ url: writerUrl.toString(), directory: path.join(f.directory, "storage"), backendIdentity: f.backendIdentity, generation: f.generation, phase: "reads" }));
  await f.raw.write("bytes", Readable.from(Buffer.from("abc")), { offset: 0, create: true }); await f.executor.start();
  const owned = await startOwnedFixtureProcess(helper, config), child = owned.child;
  const exit = owned.closed; const streams: Readable[] = [];
  try {
    const event = await owned.message<{ pid: number }>(); expect(event.pid).toBe(child.pid);
    await evidence("A04", "process", { pid: child.pid, helper, executable: child.spawnfile });
    streams.push(await f.executor.openRead("bytes"));
    const actions = [f.executor.stat("bytes"), f.executor.list("", undefined, 10), f.executor.exists("bytes"), f.executor.statFs()];
    await vi.waitFor(async () => expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_read_slots WHERE state='WAITING'`)).toHaveLength(4));
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_read_slots WHERE state='ACTIVE'`)).toHaveLength(3);
    await f.executor.mkdir("writer-independent"); expect(await f.raw.exists("writer-independent")).toBe(true);
    const abort = new AbortController(), waiting = f.executor.openRead("bytes", { signal: abort.signal }).catch((e: unknown) => e);
    abort.abort(); expect(await waiting).toMatchObject({ code: "cancelled" });
    await owned.release(); await requireNormalFixtureExit(exit); await Promise.all(actions);
    const scrub = await f.executor.openRead("bytes", { priority: "scrub" }); streams.push(scrub);
    const nextScrub = f.executor.openRead("bytes", { priority: "scrub" });
    await vi.waitFor(async () => expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_read_slots WHERE priority='scrub' AND state='WAITING'`)).toHaveLength(1));
    await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE sync_backend_read_slots SET created_at=now()-interval '3 seconds' WHERE priority='scrub' AND state='WAITING'`);
    const foreground = f.executor.openRead("bytes");
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_read_slots WHERE priority='scrub' AND state='ACTIVE'`)).toHaveLength(1);
    scrub.destroy(); streams.push(await nextScrub); requireDefined(streams[0]).destroy(); streams.push(await foreground);
    for (const stream of streams) stream.destroy();
    for (const method of ["stat", "list", "exists", "statFs"] as const) {
      const spy = vi.spyOn(f.raw, method).mockRejectedValueOnce(Error("fixture metadata failure"));
      const failed = method === "list" ? f.executor.list("", undefined, 10) : method === "statFs" ? f.executor.statFs() : f.executor[method]("bytes");
      await expect(failed).rejects.toThrow("fixture metadata failure"); spy.mockRestore();
    }
    await f.executor.close(); expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_read_slots`)).toHaveLength(0);
    const diagnostics = await f.executor.diagnostics(); expect((diagnostics.process as { metadataCalls: number }).metadataCalls).toBe(8); await evidence("A04", "multiprocess-diagnostics", diagnostics);
  } finally { for (const stream of streams) stream.destroy(); if (child.exitCode === null && child.signalCode === null) await owned.release(); await requireNormalFixtureExit(exit); await f.close(); }
}, 30000);

it.each(["queued", "before", "after"])("A03 native child crash at %s preserves original without lease takeover", async phase => {
  const f = await backendFixture("A03-process-" + phase), taskId = uid(), writerUrl = new URL(f.url); writerUrl.username = f.roles.writerLogin;
  const config = path.join(f.directory, "child.json"), helper = fileURLToPath(new URL("./stage3-chat-a.executor-helper.mts", import.meta.url));
  if (phase === "queued") await f.command("acquire", f.executor.identity, {});
  await fs.writeFile(config, JSON.stringify({ url: writerUrl.toString(), directory: path.join(f.directory, "storage"), backendIdentity: f.backendIdentity, generation: f.generation, phase, taskId }));
  const owned = await startOwnedFixtureProcess(helper, config, {faultScope:"A03-native-"+phase}), child = owned.child;
  const exit = owned.closed;
  try {
    const event = await owned.message<{ pid: number; identity: unknown }>();
    expect(event.pid).toBe(child.pid); expect(child.spawnfile).toBe(process.execPath);
    await evidence("A03", "process-" + phase, { pid: child.pid, executable: child.spawnfile, helper, event });
    if (phase !== "queued") { await f.executor.start(); expect((await f.executor.diagnostics()).ownerId).not.toBe(f.executor.identity.ownerId); }
    if (phase === "before") {
      await f.command("submit", f.executor.identity, { id: taskId, command: "mkdir", body: { path: "second-writer" }, reservedBytes: "0" });
      const held = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,state FROM sync_backend_tasks ORDER BY id`);
      expect(held.filter(r => r.state === "RUNNING")).toHaveLength(1); expect(held.find(r => r.id === taskId)?.state).toBe("QUEUED");
      expect(await f.executor.exists("second-writer")).toBe(false); expect(await f.executor.exists("effect")).toBe(false);
      await evidence("A03", "native-second-writer", { ownerPid: child.pid, submittingPid: process.pid, held, readCompletedWhileWriterHeld: true, secondEffectStarted: false });
    }
    await owned.crash(); await exit;
    const rows = await f.admin.withSql(sql => sql<{ id: string; state: string }[]>`SELECT id,state FROM sync_backend_tasks ORDER BY id`);
    expect(rows).toHaveLength(phase === "before" ? 2 : 1);
    expect(rows.filter(r => r.state === (phase === "queued" ? "QUEUED" : "RUNNING"))).toHaveLength(1);
    expect(await f.raw.exists("effect")).toBe(phase === "after");
    if (phase === "queued") { await f.executor.start(); await vi.waitFor(async () => expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT state FROM sync_backend_tasks WHERE id=${taskId}`))[0]).state).toBe("DONE")); }
    else {
      await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE sync_backend_executor SET heartbeat_at=now()-interval '10 years'`);
      expect(await f.command("acquire", f.executor.identity, {})).toEqual({ owned: false });
      expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,state FROM sync_backend_tasks ORDER BY id`)).toEqual(rows);
    }
  } finally { if (child.exitCode === null && child.signalCode === null) await owned.stop(); await exit; await f.close(); }
}, 30000);
