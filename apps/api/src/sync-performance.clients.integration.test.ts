import "reflect-metadata";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { databaseFixture, fixtureManifest } from "./stage3-chat-a.fixture.js";
import { CompletionCommandOwner, completionCommandBudget, completionCommandPaths, nativeCompletionCommandPhaseMs } from "./completion-command.fixture.js";
import { FileService, PostgresFileRepository } from "@saturn/file-core";
import { LocalStorageAdapter, SftpStorageAdapter, type StorageAdapter } from "@saturn/storage";
import { DeviceService, PostgresDeviceRepository } from "@saturn/sync";
import type { SaturnConfig } from "@saturn/config";
import { expect, it } from "vitest";
import { PlutoController } from "./pluto.controller.js";
import { SyncClientController } from "./sync-client.controller.js";
import { SyncMetadataController } from "./sync-metadata.controller.js";
import { registerSyncMetadataLimits } from "./sync-metadata-limits.js";
import { AUTH_SERVICE, DEVICE_SERVICE } from "./tokens.js";
import { registerWebDav } from "./webdav.js";
import type { TransferMonitorService } from "./transfer-monitor.service.js";

const runFile = promisify(execFile);
const databaseUrl = process.env.PLUTO_TEST_DATABASE_URL;
const auditRoot = process.env.SYNC_PERFORMANCE_CLIENT_AUDIT;
const neptuneRunner = process.env.SYNC_PERFORMANCE_NEPTUNE_RUNNER;
const plutoRunner = process.env.SYNC_PERFORMANCE_PLUTO_RUNNER;
const plutoImage = process.env.SYNC_PERFORMANCE_PLUTO_IMAGE;
const dockerExecutable = process.env.SYNC_PERFORMANCE_DOCKER;
const dotnet = process.env.SYNC_PERFORMANCE_DOTNET;
const sftpFixture = process.env.SYNC_PERFORMANCE_SFTP_FIXTURE;
const bootstrapMode = process.env.SYNC_PERFORMANCE_NEPTUNE_BOOTSTRAP === "1";
const baselineWindowsMode = process.env.SYNC_PERFORMANCE_BASELINE_WINDOWS === "1";
const receiptMode = process.env.SYNC_PERFORMANCE_IMMUTABLE_RECEIPT === "1";
const receiptRestartMode = process.env.SYNC_PERFORMANCE_RECEIPT_RESTART === "1";
const enabled = !!(databaseUrl && auditRoot && neptuneRunner && plutoRunner && dotnet);

interface StorageMetric {
  calls: number; errors: number; active: number; peakActive: number; promiseMs: number;
  completedReadStreams: number; readStreamMs: number;
}

// Only counts the public adapter boundary. Nested calls inside the adapter and
// its SSH packet/pool timings are deliberately not reported as measured here.
function observeStorage(storage: StorageAdapter) {
  let phase = "setup";
  const metrics: Record<string, StorageMetric> = {};
  const wrapped = new Map<PropertyKey, unknown>();
  const adapter = new Proxy(storage, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property);
      if (typeof member !== "function") return member;
      if (!wrapped.has(property)) wrapped.set(property, async (...args: unknown[]) => {
        const key = phase + "/" + String(property);
        const metric = metrics[key] ??= { calls: 0, errors: 0, active: 0, peakActive: 0, promiseMs: 0,
          completedReadStreams: 0, readStreamMs: 0 };
        const started = performance.now(); metric.calls++; metric.active++;
        metric.peakActive = Math.max(metric.peakActive, metric.active);
        try {
          const value: unknown = await Reflect.apply(member, target, args);
          if (property === "openRead") {
            const stream = value as Readable;
            const opened = performance.now();
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true; metric.completedReadStreams++; metric.readStreamMs += performance.now() - opened;
            };
            // Observing terminal events does not put the stream into flowing mode.
            stream.once("end", finish); stream.once("close", finish);
          }
          return value;
        } catch (error) { metric.errors++; throw error; }
        finally { metric.active--; metric.promiseMs += performance.now() - started; }
      });
      return wrapped.get(property);
    },
  });
  return { adapter, metrics, setPhase: (next: string) => { phase = next; } };
}

async function smokeStorage(qaRoot: string, runId: string): Promise<StorageAdapter> {
  if (!sftpFixture) {
    const local = new LocalStorageAdapter(path.join(qaRoot, "storage"));
    await local.initialize();
    return local;
  }
  const fixture = JSON.parse(await fs.readFile(sftpFixture, "utf8")) as {
    containerId: string; runId: string; storage: SaturnConfig["storage"];
  };
  if (!/^[a-f0-9]{64}$/.test(fixture.containerId) || !/^[a-f0-9]{32}$/.test(fixture.runId)
    || fixture.storage.host !== "127.0.0.1" || fixture.storage.root !== "/data"
    || fixture.storage.port < 1024 || fixture.storage.maxConnections > 4) {
    throw new Error("Only an explicitly owned, bounded loopback SFTP fixture is allowed");
  }
  const { stdout } = await runFile("docker", ["inspect", "--format",
    '{{.Id}} {{index .Config.Labels "exocortex.sync-performance.run"}} {{.State.Running}}', fixture.containerId],
  { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (stdout.trim() !== fixture.containerId + " " + fixture.runId + " true") throw new Error("SFTP fixture ownership mismatch");
  const prefix = "http-" + runId;
  const bootstrap = new SftpStorageAdapter(fixture.storage);
  try { await bootstrap.mkdir(prefix); } finally { await bootstrap.close(); }
  return new SftpStorageAdapter({ ...fixture.storage, root: "/data/" + prefix });
}

async function removeOwnedContainer(docker: string, name: string, runId: string): Promise<void> {
  const options = { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true } as const;
  const { stdout } = await runFile(docker, ["container", "ls", "--all", "--no-trunc",
    "--filter", "name=^/" + name + "$", "--format", "{{.ID}}"], options);
  const id = stdout.trim();
  if (!id) return;
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Test container identity mismatch");
  const { stdout: details } = await runFile(docker, ["inspect", "--type", "container", "--format",
    '{{.Id}} {{.Name}} {{index .Config.Labels "exocortex.sync-performance.run"}} {{.State.Status}}', id], options);
  const [actualId, actualName, label, status] = details.trim().split(" ");
  if (actualId !== id || actualName !== "/" + name || label !== runId) throw new Error("Test container ownership mismatch");
  if (status !== "exited" && status !== "created") throw new Error("Owned Pluto container has not reached a terminal state");
  await runFile(docker, ["rm", id], options);
}

// Explicitly opt in with built client engines and a separately owned database.
// No native application's production profile or daemon is used by this test.
it.skipIf(!enabled)("runs real Neptune Core and Pluto Copy together through Saturn HTTP and PostgreSQL", async () => {
  if (!databaseUrl || !auditRoot || !neptuneRunner || !plutoRunner || !dotnet) throw new Error("Isolated client smoke settings are required");
  if (!plutoImage || !/^sha256:[a-f0-9]{64}$/.test(plutoImage)) throw new Error("Exact local Pluto runner image required");
  if (!dockerExecutable || !path.isAbsolute(dockerExecutable) || !path.isAbsolute(dotnet))
    throw new Error("Explicit absolute Docker and .NET executables required");
  const testDeadline = Date.now() + 240_000;
  const fixtureFile = process.env.STAGE3_CHAT_A_FIXTURE, evidencePath = process.env.STAGE3_CHAT_A_EVIDENCE;
  if (!fixtureFile || !evidencePath || ![fixtureFile, evidencePath, auditRoot].every(value => path.isAbsolute(value)))
    throw new Error("Explicit private PostgreSQL fixture and evidence directory required");
  const runRoot = await fs.realpath(path.dirname(fixtureFile)), evidenceRoot = await fs.realpath(evidencePath);
  if (path.relative(path.dirname(fixtureFile), runRoot) !== "" || !(await fs.lstat(fixtureFile)).isFile()
      || path.relative(runRoot, evidenceRoot) !== "evidence" || path.relative(evidencePath, evidenceRoot) !== ""
      || path.relative(auditRoot, evidenceRoot) !== "") throw new Error("Client test evidence must belong to the admitted fixture");
  const owned = await fixtureManifest(), fixtureDirectory = await fs.realpath(owned.fixtureDirectory);
  if (databaseUrl !== owned.databaseUrl || !path.isAbsolute(owned.fixtureDirectory)
      || path.relative(owned.fixtureDirectory, fixtureDirectory) !== "" || path.relative(runRoot, fixtureDirectory) !== "fixtures")
    throw new Error("Client test PostgreSQL fixture binding mismatch");
  const runId = randomUUID().replaceAll("-", ""), qaRoot = path.join(evidenceRoot, "http-" + runId);
  await fs.mkdir(qaRoot, { mode: 0o700 });
  const fixture = await databaseFixture("sync-performance-clients", 126), database = fixture.db;
  let storage: StorageAdapter;
  try { storage = await smokeStorage(qaRoot, runId); }
  catch (error) {
    await fixture.close();
    await fs.writeFile(path.join(qaRoot, "cleanup.json"), JSON.stringify({
      databaseRetained: "stage3_" + fixture.suffix, databaseClosed: true, completed: false, setupFailed: true,
    }, null, 2));
    throw error;
  }
  const observation = observeStorage(storage);
  const files = new FileService(new PostgresFileRepository(database), observation.adapter);
  const devices = new DeviceService({ repository: new PostgresDeviceRepository(database), files, pepper: "isolated-client-smoke-pepper-1234567890", options: {
    enabled: true, publicOrigin: "https://saturn.test", uploadChunkMaxBytes: 1024 * 1024, propfindMaxItems: 100, deleteMaxItems: 2, deleteWindowMs: 900000,
  } });
  @Module({ controllers: [PlutoController, SyncClientController, SyncMetadataController], providers: [
    { provide: DEVICE_SERVICE, useValue: devices }, { provide: AUTH_SERVICE, useValue: {} },
  ] })
  class TestModule { readonly fixture = "isolated-sync-clients"; }
  const adapter = new FastifyAdapter({ logger: false });
  const instance = adapter.getInstance();
  registerSyncMetadataLimits(instance);
  for (const method of ["PROPFIND", "MKCOL", "MOVE", "COPY"]) instance.addHttpMethod(method);
  instance.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  let activePlutoPuts = 0, maxPlutoPuts = 0;
  instance.addHook("onRequest", async request => {
    if (request.method === "PUT" && request.url.startsWith("/api/v1/pluto/files")) {
      activePlutoPuts++; maxPlutoPuts = Math.max(maxPlutoPuts, activePlutoPuts);
      // Controlled metadata/transport latency, recorded as artificial.
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  });
  instance.addHook("onResponse", async request => {
    if (request.method === "PUT" && request.url.startsWith("/api/v1/pluto/files")) activePlutoPuts--;
  });
  let faultRootId: string | undefined;
  let lostReceipt: Awaited<ReturnType<typeof files.getUpload>>["publicationReceipt"];
  let destroyedCompletionResponses = 0;
  instance.addHook("onSend", async (request, reply, payload) => {
    if (receiptRestartMode && request.method === "POST") {
      const match = /^\/api\/v1\/sync\/uploads\/([a-f0-9-]{36})\/complete$/.exec(request.url);
      if (match?.[1]) {
        const published = (await files.getUpload(match[1])).publicationReceipt;
        if (published?.rootId === faultRootId && published?.name === "resumable.bin") {
          // HttpClient can transparently retry an empty POST after an early
          // connection close. Keep losing this UUID's completion replies;
          // restarted same-key CREATE lookup remains available.
          lostReceipt = published;
          destroyedCompletionResponses++;
          await fs.writeFile(path.join(qaRoot, "expected-lost-completion.json"), JSON.stringify({
            fault: "All completion replies for this UUID destroyed after actual commit", destroyedCompletionResponses, publicationReceipt: published,
          }, null, 2));
          reply.raw.destroy();
        }
      }
    }
    return payload;
  });
  let app: NestFastifyApplication | undefined;
  const containerNames: string[] = [];
  const commandPaths = { ...completionCommandPaths(), cwd: process.cwd() };
  let nativeAdmissionClosed = false;
  const pendingNativeEvidence = new Set<string>();
  const runNative = async (executable: string, args: string[]) => {
    const phaseMs = Math.min(nativeCompletionCommandPhaseMs, testDeadline - Date.now() - completionCommandBudget.cleanupReserveMs);
    if (nativeAdmissionClosed || phaseMs < 1) throw new Error("Native client admission closed");
    const owner = new CompletionCommandOwner(commandPaths, qaRoot, { phaseMs, nativeExecutable: executable });
    try {
      const result = await owner.run(args);
      if (result.exitCode !== 0 || result.signal !== null || !result.outputAccepted || result.supervisorExitCode !== 0)
        throw Object.assign(new Error("Native client command failed"), { code: result.exitCode, signal: result.signal,
          stdout: result.stdout, stderr: result.stderr, evidence: result.evidence });
      return result;
    } catch (error) {
      nativeAdmissionClosed = true;
      const operation = owner.lastOperation;
      if (operation) {
        const remaining = Math.max(0, Math.min(completionCommandBudget.cleanupReserveMs, testDeadline - Date.now() - 1_000));
        const joined = await Promise.race([
          operation.join.then(() => true, () => false),
          delay(remaining, false, { ref: false }),
        ]);
        if (!joined) pendingNativeEvidence.add(operation.evidence);
      }
      throw error;
    }
  };
  const manifests: { relative: string; sha256: string; size: number }[] = [];
  let result: Record<string, unknown> | undefined;
  const testFailures: unknown[] = [];
  try {
    app = await NestFactory.create<NestFastifyApplication>(TestModule, adapter, { logger: false });
    app.setGlobalPrefix("api/v1");
    registerWebDav(instance, devices, { publicOrigin: "https://saturn.test" } as SaturnConfig,
      { trackDownload: (stream: unknown) => stream } as unknown as TransferMonitorService);
    await files.initializeStorage();
    if (bootstrapMode || baselineWindowsMode) {
      // A file eligible from the root can publish while the audit runner holds
      // branch-0 enumeration. Existing fixtures/cohort identities stay separate.
      const relative = "bootstrap-first.dat", content = Buffer.from("first eligible sealed file\n".repeat(128));
      manifests.push({ relative, sha256: createHash("sha256").update(content).digest("hex"), size: content.length });
      for (const source of ["neptune-source", "pluto-source"]) {
        const filename = path.join(qaRoot, source, relative);
        await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, content);
      }
    }
    for (let branch = 0; branch < 8; branch++) {
      for (let index = 0; index < 4; index++) {
        const relative = `branch-${String(branch)}/nested/file-${String(index)}.txt`;
        const content = Buffer.from((relative + " content\n").repeat(256));
        manifests.push({ relative, sha256: createHash("sha256").update(content).digest("hex"), size: content.length });
        for (const source of ["neptune-source", "pluto-source"]) {
          const filename = path.join(qaRoot, source, relative);
          await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, content);
        }
      }
    }
    const large = Buffer.alloc(3 * 1024 * 1024, 0x6e), largeRelative = "large/resumable.bin";
    manifests.push({ relative: largeRelative, sha256: createHash("sha256").update(large).digest("hex"), size: large.length });
    for (const source of ["neptune-source", "pluto-source"]) {
      const filename = path.join(qaRoot, source, largeRelative);
      await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, large);
    }
    await fs.writeFile(path.join(qaRoot, "dataset.json"), JSON.stringify({ generated: true, files: manifests }, null, 2));
    const neptuneRuntime = path.join(qaRoot, "neptune-runtime");
    await fs.cp(path.dirname(neptuneRunner), neptuneRuntime, { recursive: true });
    await fs.copyFile(plutoRunner, path.join(qaRoot, "pluto-smoke"));
    const frozenNeptuneRunner = path.join(neptuneRuntime, path.basename(neptuneRunner));
    const runnerIdentity = {
      neptuneRunnerSha256: createHash("sha256").update(await fs.readFile(frozenNeptuneRunner)).digest("hex"),
      neptuneCoreSha256: createHash("sha256").update(await fs.readFile(path.join(neptuneRuntime, "Neptune.Core.dll"))).digest("hex"),
      plutoRunnerSha256: createHash("sha256").update(await fs.readFile(path.join(qaRoot, "pluto-smoke"))).digest("hex"),
      integrationTestSha256: createHash("sha256").update(await fs.readFile(new URL(import.meta.url))).digest("hex"),
    };
    await fs.writeFile(path.join(qaRoot, "runner-identity.json"), JSON.stringify(runnerIdentity, null, 2));
    observation.setPhase("enrollment");
    const win = await devices.createWindowsEnrollment("Isolated Neptune " + runId.slice(0, 8));
    const windows = await devices.redeemWindowsEnrollment(win.code, "audit-core");
    const enrollment = await devices.createPlutoEnrollment("Isolated Pluto " + runId.slice(0, 8));
    const pluto = await devices.redeemPlutoEnrollment(enrollment.code, "audit-copy");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw new Error("Test API did not bind to loopback");
    const origin = "http://127.0.0.1:" + String(address.port);
    const neptuneSettings = path.join(qaRoot, "neptune.private.json");
    await fs.mkdir(path.join(qaRoot, "neptune-state"));
    if (bootstrapMode && baselineWindowsMode || receiptMode && !bootstrapMode || receiptRestartMode && !receiptMode) throw new Error("Choose a single compatible Neptune runner mode");
    faultRootId = win.device.syncRootId ?? undefined;
    await fs.writeFile(neptuneSettings, JSON.stringify({ MappingRoot: origin + "/dav/sync/" + encodeURIComponent(win.device.syncFolderName ?? "") + "/",
      Origin: origin + "/", RemoteFolder: win.device.syncFolderName,
      RootId: win.device.syncRootId, Token: windows.token, SourceDir: path.join(qaRoot, "neptune-source"), StateDir: path.join(qaRoot, "neptune-state"),
      ...(receiptRestartMode ? { Phase: "initial-lost-ack" } : {}) }));
    const plutoSettings = path.join(qaRoot, "pluto.private.json");
    await fs.writeFile(plutoSettings, JSON.stringify({ Origin: "http://host.docker.internal:" + String(address.port), Token: pluto.token,
      Sources: ["/qa/pluto-source"], SpoolDir: "/qa/pluto-spool" }));
    const runPluto = async (pass: number): Promise<{ ok: boolean; uploadedFiles: number }> => {
      const name = "sync-perf-client-" + runId.slice(0, 12) + "-" + String(pass); containerNames.push(name);
      const start = Date.now();
      const { stdout, stderr } = await runNative(dockerExecutable, ["run", "--pull=never", "--name", name, "--label", "exocortex.sync-performance.run=" + runId,
        "--cpus=1", "--memory=768m", "--memory-swap=768m", "--pids-limit=128", "-v", qaRoot + ":/qa", plutoImage, "/qa/pluto-smoke", "/qa/pluto.private.json"]);
      await fs.writeFile(path.join(qaRoot, "pluto-" + String(pass) + ".log"), stdout + stderr);
      const parsed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { ok: boolean; uploadedFiles: number };
      await fs.writeFile(path.join(qaRoot, "pluto-" + String(pass) + "-metrics.json"), JSON.stringify({ pass, elapsedMs: Date.now() - start, ...parsed }, null, 2));
      return parsed;
    };
    observation.setPhase("clients");
    const neptuneRun = runNative(dotnet, [frozenNeptuneRunner, neptuneSettings])
      .catch(async (error: unknown) => {
        const failure = error as { stdout?: string; stderr?: string; message?: string; code?: unknown; signal?: unknown };
        await fs.writeFile(path.join(qaRoot, "neptune-terminal-diagnostics.json"), JSON.stringify({
          message: failure.message, code: failure.code, signal: failure.signal, stdout: failure.stdout, stderr: failure.stderr,
        }, null, 2));
        throw error;
      });
    const [neptuneJoined, plutoJoined] = await Promise.allSettled([neptuneRun, runPluto(0)]);
    if (neptuneJoined.status === "rejected" && plutoJoined.status === "rejected")
      throw new AggregateError([neptuneJoined.reason, plutoJoined.reason], "Both native clients failed");
    if (neptuneJoined.status === "rejected") throw neptuneJoined.reason;
    if (plutoJoined.status === "rejected") throw plutoJoined.reason;
    const neptuneOutput = neptuneJoined.value, plutoFirst = plutoJoined.value;
    await fs.writeFile(path.join(qaRoot, "neptune.log"), neptuneOutput.stdout + neptuneOutput.stderr);
    let neptune = JSON.parse(neptuneOutput.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
      ok: boolean; fileCount: number; rounds: { pass: number; elapsedMs: number; requests: Record<string, number> }[];
      processId?: number; sessionId?: string;
      retainedFailure?: { operationId: string; uploadId: string; originalIntentHash: string }[];
      firstPublicationMs?: number; scanEnumerationFinishedMs?: number; barrierReached?: boolean; barrierReleasedByConfirmedFile?: boolean;
      initial?: { publishedFiles: number; failures: number; conflicts: number; deferred: number; maximumDataJobs: number;
        maximumLargeJobs: number; maximumSourceReaders: number; maximumReadyQueue: number; maximumSpoolBytes: number };
      receiptPolicy?: string; proofs?: Record<string, number>;
      receipts?: { relativePath: string; operationId: string; proof: string; sha256: string; size: number;
        immutableReceiptJson: string; serverReceipt: { uploadId: string; operationId: string; rootId: string; versionId: string; sha256: string; sizeBytes: string } }[];
    };
    let recoveryEvidence: Record<string, unknown> | undefined;
    let currentReplacement: typeof manifests[number] | undefined;
    if (receiptRestartMode) {
      expect(neptune.ok).toBe(true);
      expect(neptune.initial).toMatchObject({ publishedFiles: manifests.length - 1, failures: 1, conflicts: 0, deferred: 0 });
      expect(lostReceipt).toBeDefined();
      if (!lostReceipt || !neptune.sessionId) throw new Error("Expected committed V1 and retained original client session are missing");
      const original = neptune, firstReceipt = lostReceipt;
      observation.setPhase("independent-overwrite");
      const replacement = Buffer.alloc(large.length, 0x76), replacementHash = createHash("sha256").update(replacement).digest("hex");
      const second = await files.createUpload({ parentId: firstReceipt.parentId, filename: firstReceipt.name,
        expectedSize: replacement.length, expectedSha256: replacementHash, idempotencyKey: "independent-v2-" + randomUUID(),
        overwriteResourceId: firstReceipt.resourceId, expectedVersionId: firstReceipt.versionId });
      await files.appendUpload(second.id, 0, replacement.length, Readable.from(replacement));
      await files.completeUpload(second.id);
      currentReplacement = { relative: largeRelative, sha256: replacementHash, size: replacement.length };
      const versionsBefore = await database.withSql(sql => sql`SELECT id, sha256, size_bytes FROM file_versions
        WHERE resource_id=${firstReceipt.resourceId} ORDER BY id`);
      expect(versionsBefore).toHaveLength(2);
      const settings = JSON.parse(await fs.readFile(neptuneSettings, "utf8")) as Record<string, unknown>;
      await fs.writeFile(neptuneSettings, JSON.stringify({ ...settings, Phase: "resume", SessionId: original.sessionId }));
      observation.setPhase("receipt-recovery");
      const recoveredOutput = await runNative(dotnet, [frozenNeptuneRunner, neptuneSettings]).catch(async (error: unknown) => {
        const failure = error as { stdout?: string; stderr?: string; message?: string; code?: unknown; signal?: unknown };
        await fs.writeFile(path.join(qaRoot, "neptune-recovery-terminal-diagnostics.json"), JSON.stringify({
          message: failure.message, code: failure.code, signal: failure.signal, stdout: failure.stdout, stderr: failure.stderr,
        }, null, 2));
        throw error;
      });
      await fs.writeFile(path.join(qaRoot, "neptune-recovery.log"), recoveredOutput.stdout + recoveredOutput.stderr);
      const recovered = JSON.parse(recoveredOutput.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as typeof neptune;
      expect(recovered.ok).toBe(true); expect(recovered.processId).not.toBe(original.processId);
      expect(recovered.rounds[0]?.requests).toEqual({ POST: 1 });
      expect(recovered.rounds[1]?.requests).toEqual({});
      expect(Object.keys(observation.metrics).filter(key => key.startsWith("receipt-recovery/"))).toEqual([]);
      const versionsAfter = await database.withSql(sql => sql`SELECT id, sha256, size_bytes FROM file_versions
        WHERE resource_id=${firstReceipt.resourceId} ORDER BY id`);
      expect(versionsAfter).toEqual(versionsBefore);
      const historical = recovered.receipts?.find(receipt => receipt.relativePath === largeRelative);
      expect(historical?.serverReceipt).toEqual(firstReceipt);
      expect(original.retainedFailure).toHaveLength(1);
      expect(historical?.operationId).toBe(original.retainedFailure?.[0]?.operationId);
      expect(original.retainedFailure?.[0]).toMatchObject({ uploadId: firstReceipt.uploadId, originalIntentHash: firstReceipt.intentHash });
      const currentResponse = await fetch(origin + "/api/v1/sync/uploads/" + firstReceipt.uploadId,
        { headers: { authorization: "Bearer " + windows.token } });
      expect(currentResponse.status).toBe(200);
      const current = await currentResponse.json() as { publicationReceipt: typeof firstReceipt; etag: string };
      expect(current.publicationReceipt).toEqual(firstReceipt);
      expect(current.etag).toBe(`"sha256-${replacementHash}"`);
      observation.setPhase("historical-readback");
      const historicalBytes = await files.openVersionDownload(firstReceipt.resourceId, firstReceipt.versionId);
      const historicalHash = createHash("sha256");
      for await (const chunk of historicalBytes.stream) historicalHash.update(chunk as Uint8Array);
      expect(historicalHash.digest("hex")).toBe(firstReceipt.sha256);
      recoveryEvidence = { firstProcessId: original.processId, restartedProcessId: recovered.processId,
        firstReceipt, originalClientSessionId: original.sessionId, currentReplacement,
        versionsBefore, versionsAfter, initialExpectedFailures: 1, destroyedCompletionResponses, recoveryRequests: recovered.rounds[0]?.requests,
        noRecoveryBackendCalls: true, historicalReadbackSha256: firstReceipt.sha256, legacyCurrentEtag: current.etag };
      await fs.writeFile(path.join(qaRoot, "receipt-restart-evidence.json"), JSON.stringify(recoveryEvidence, null, 2));
      const originalInitial = original.initial, recoveredInitial = recovered.initial;
      if (!originalInitial || !recoveredInitial) throw new Error("Original and recovered executor metrics are required");
      if (original.firstPublicationMs === undefined || original.scanEnumerationFinishedMs === undefined
        || original.barrierReached === undefined || original.barrierReleasedByConfirmedFile === undefined) {
        throw new Error("First-process enumeration/publication barrier evidence is required");
      }
      neptune = { ...recovered, firstPublicationMs: original.firstPublicationMs,
        scanEnumerationFinishedMs: original.scanEnumerationFinishedMs, barrierReached: original.barrierReached,
        barrierReleasedByConfirmedFile: original.barrierReleasedByConfirmedFile,
        initial: { ...recoveredInitial, maximumDataJobs: originalInitial.maximumDataJobs,
          maximumLargeJobs: originalInitial.maximumLargeJobs, maximumSourceReaders: originalInitial.maximumSourceReaders,
          maximumReadyQueue: originalInitial.maximumReadyQueue, maximumSpoolBytes: originalInitial.maximumSpoolBytes },
        rounds: [...original.rounds, ...recovered.rounds] };
      observation.setPhase("clients");
    }
    const plutoSecond = await runPluto(1);
    expect(neptune.ok).toBe(true); expect(neptune.fileCount).toBe(manifests.length);
    if (bootstrapMode) {
      expect(neptune.barrierReached).toBe(true); expect(neptune.barrierReleasedByConfirmedFile).toBe(true);
      expect(neptune.firstPublicationMs).toBeGreaterThanOrEqual(0);
      expect(neptune.firstPublicationMs).toBeLessThan(neptune.scanEnumerationFinishedMs ?? -1);
      expect(neptune.initial).toMatchObject({ publishedFiles: manifests.length, failures: 0, conflicts: 0, deferred: 0 });
      expect(neptune.initial?.maximumDataJobs).toBeLessThanOrEqual(4);
      expect(neptune.initial?.maximumLargeJobs).toBeLessThanOrEqual(2);
      expect(neptune.initial?.maximumSourceReaders).toBeLessThanOrEqual(1);
      expect(neptune.initial?.maximumReadyQueue).toBeLessThanOrEqual(16);
      expect(neptune.initial?.maximumSpoolBytes).toBeLessThanOrEqual(1024 * 1024 * 1024);
      expect(neptune.rounds[0]?.requests["POST-complete"]).toBe(manifests.length);
      expect(neptune.rounds[0]?.requests["PATCH"]).toBe(manifests.length + 2);
      // Completed immutable local work replay, not a fresh repeat-sync scan.
      expect(neptune.rounds.at(-1)?.requests).toEqual({});
      if (receiptMode) {
        expect(neptune.receiptPolicy).toBe("RequireImmutable");
        expect(neptune.proofs?.["QualifiedImmutableReceipt"]).toBe(manifests.length);
        expect(neptune.receipts).toHaveLength(manifests.length);
        const receipts = neptune.receipts ?? [];
        expect(new Set(receipts.map(receipt => receipt.serverReceipt.uploadId)).size).toBe(manifests.length);
        expect(new Set(receipts.map(receipt => receipt.serverReceipt.versionId)).size).toBe(manifests.length);
        for (const expected of manifests) {
          const receipt = receipts.find(row => row.relativePath === expected.relative);
          expect(receipt).toMatchObject({ proof: "QualifiedImmutableReceipt", sha256: expected.sha256, size: expected.size,
            serverReceipt: { rootId: win.device.syncRootId, sha256: expected.sha256, sizeBytes: String(expected.size) } });
          if (!receipt) throw new Error("Qualified file receipt is missing");
          expect(receipt.operationId).toMatch(/^[a-f0-9]{64}$/);
          expect(receipt.serverReceipt.uploadId).toBe(receipt.serverReceipt.operationId);
          expect(receipt.serverReceipt.uploadId).not.toBe(receipt.operationId);
          expect(JSON.parse(receipt.immutableReceiptJson) as unknown).toEqual(receipt.serverReceipt);
        }
      }
    } else {
      expect(neptune.rounds[0]?.requests["POST-complete"]).toBe(1);
      expect(neptune.rounds[0]?.requests["PATCH"]).toBe(3);
    }
    expect(neptune.rounds[1]?.requests["POST"] ?? 0).toBe(receiptRestartMode ? 1 : 0);
    expect(neptune.rounds[1]?.requests["PATCH"] ?? 0).toBe(0);
    expect(neptune.rounds[1]?.requests["PUT"] ?? 0).toBe(0);
    expect(plutoFirst).toMatchObject({ ok: true, uploadedFiles: manifests.length });
    expect(plutoSecond).toMatchObject({ ok: true, uploadedFiles: 0 });
    expect(maxPlutoPuts).toBe(baselineWindowsMode ? 1 : 2);
    const windowsContext = await devices.authenticate("Bearer " + windows.token), plutoContext = await devices.authenticate("Bearer " + pluto.token);
    const checkFile = async (context: typeof windowsContext, remotePath: string, expected: typeof manifests[number]): Promise<string> => {
      const [entry] = await devices.propfind(context, remotePath, 0);
      expect(entry?.resource).toMatchObject({ type: "file", sha256: expected.sha256, sizeBytes: expected.size });
      if (!entry) throw new Error("Published resource is absent");
      const opened = await files.openDownload(entry.resource.id); const digest = createHash("sha256");
      for await (const chunk of opened.stream) digest.update(chunk as Uint8Array);
      expect(digest.digest("hex")).toBe(expected.sha256);
      return entry.resource.id;
    };
    observation.setPhase("readback");
    const windowsIds: string[] = [], plutoIds: string[] = [];
    for (const file of manifests) {
      windowsIds.push(await checkFile(windowsContext, "sync/" + (win.device.syncFolderName ?? "") + "/"
        + (baselineWindowsMode ? "neptune-source/" : "") + file.relative, currentReplacement?.relative === file.relative ? currentReplacement : file));
      plutoIds.push(await checkFile(plutoContext, "pluto/" + (enrollment.device.syncFolderName ?? "") + "/qa/pluto-source/" + file.relative, file));
    }
    observation.setPhase("metadata");
    const metadataChecks: { client: string; items: number; peerHidden: boolean }[] = [];
    for (const client of [
      { name: "neptune", rootId: win.device.syncRootId, token: windows.token, ids: windowsIds, peerId: plutoIds[0] },
      { name: "pluto", rootId: enrollment.device.syncRootId, token: pluto.token, ids: plutoIds, peerId: windowsIds[0] },
    ]) {
      if (!client.rootId || !client.peerId) throw new Error("Synthetic metadata bindings are missing");
      const headers = { authorization: "Bearer " + client.token, "content-type": "application/json" };
      const rootUrl = origin + "/api/v1/sync/roots/" + client.rootId;
      const capabilities = await fetch(rootUrl + "/capabilities", { headers });
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toMatchObject({ features: { metadataBatch: true, deltaFeed: false, newSyncEngine: false } });
      const nodeIds = [...client.ids, client.peerId];
      const response = await fetch(rootUrl + "/metadata/batch", { method: "POST", headers, body: JSON.stringify({ nodeIds }) });
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
      const batch = await response.json() as { results: { nodeId: string; status: string; metadata?: { sizeBytes: string; sha256: string } }[] };
      expect(batch.results.map(item => item.nodeId)).toEqual(nodeIds);
      for (let index = 0; index < manifests.length; index++) {
        const original = manifests[index]; if (!original) throw new Error("Dataset manifest entry is missing");
        const expected = client.name === "neptune" && currentReplacement?.relative === original.relative ? currentReplacement : original;
        expect(batch.results[index]).toMatchObject({ status: "found", metadata: { sizeBytes: String(expected.size), sha256: expected.sha256 } });
      }
      expect(batch.results.at(-1)).toEqual({ nodeId: client.peerId, status: "not_found" });
      metadataChecks.push({ client: client.name, items: nodeIds.length, peerHidden: true });
    }
    await expect(devices.propfind(windowsContext, "pluto/" + (enrollment.device.syncFolderName ?? ""), 0)).rejects.toMatchObject({ code: "not_found" });
    result = { ok: true, runId, runnerIdentity, neptuneMode: baselineWindowsMode ? "B0-original-WindowsSyncService" : receiptMode ? "opt-in-qualified-receipt-bootstrap" : bootstrapMode ? "opt-in-create-only-bootstrap" : "legacy-upload",
      backend: sftpFixture ? "isolated-sftp" : "local", filesPerClient: manifests.length,
      storageMetrics: observation.metrics, storageMetricBoundary: "public adapter calls; durations overlap and exclude nested SSH/pool operations",
      artificialPlutoLatencyMs: 30, maxPlutoPuts, neptune, plutoFirst, plutoSecond, metadataChecks, recoveryEvidence,
      coverage: "Actual Neptune.Core and Pluto.Copy; " + (baselineWindowsMode ? "B0 actual original WindowsSyncService, fixture-only Kernel/heartbeat discovery; current Saturn server means this qualifies client baseline only; " : "")
        + (bootstrapMode ? "Neptune initial streaming and completed-session replay only, no fresh repeat scan; " : "")
        + "native WPF, installed MSI, daemon, production backend and D1/D2 performance not covered" };
    await fs.writeFile(path.join(qaRoot, "results.json"), JSON.stringify(result, null, 2));
  } catch (error) {
    testFailures.push(error);
  }
  try {
    if (pendingNativeEvidence.size) {
      await fs.writeFile(path.join(qaRoot, "cleanup.json"), JSON.stringify({
        completed: false, pendingNativeEvidence: [...pendingNativeEvidence], databaseRetained: "stage3_" + fixture.suffix,
        admissionClosed: true, killIssued: false,
      }, null, 2));
      throw new Error("Native client outcomes are pending; receiver resources retained");
    }
    for (const name of containerNames) await removeOwnedContainer(dockerExecutable, name, runId);
    observation.setPhase("cleanup");
    await app?.close();
    const closed = await Promise.allSettled([fixture.close(), observation.adapter.close()]);
    const failures: unknown[] = [];
    for (const outcome of closed) {
      if (outcome.status === "rejected") failures.push(outcome.reason);
    }
    await fs.writeFile(path.join(qaRoot, "cleanup.json"), JSON.stringify({
      databaseRetained: "stage3_" + fixture.suffix, databaseClosed: closed[0].status === "fulfilled",
      containersChecked: containerNames, completed: result?.ok === true && testFailures.length === 0 && failures.length === 0,
    }, null, 2));
    if (failures.length) throw new AggregateError(failures, "Native client fixture cleanup failed");
    await fs.writeFile(path.join(qaRoot, "storage-metrics.json"), JSON.stringify({ metrics: observation.metrics,
      boundary: "public adapter calls; durations overlap; openRead promise records handle setup separately from terminal stream events" }, null, 2));
  } catch (error) {
    testFailures.push(error);
  }
  if (testFailures.length === 1) throw testFailures[0];
  if (testFailures.length > 1) throw new AggregateError(testFailures, "Native client test and fixture cleanup failed");
}, 240000);
