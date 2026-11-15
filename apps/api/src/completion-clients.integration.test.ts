import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import { it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { activeFixture, sha } from "./stage3-chat-a.fixture.js";
import { guardedSyncHttp } from "./guarded-sync-http.js";
import { guardedSyncFolderHttp } from "./guarded-sync-folder-http.js";
import { guardedSyncUploadHttp } from "./guarded-sync-upload-http.js";
import { guardedSyncMutationHttp } from "./guarded-sync-mutation-http.js";
import { guardedSyncStreamHttp } from "./guarded-sync-stream-http.js";
import { guardedSyncSmallBatchHttp } from "./guarded-sync-small-batch-http.js";
import { guardedSyncCapabilitiesHttp } from "./guarded-sync-capabilities-http.js";
import { SMALL_BATCH_SCHEMA, SMALL_BATCH_MAX_ITEMS, SMALL_BATCH_MAX_FILE_BYTES, SMALL_BATCH_MAX_DATA_BYTES, SMALL_BATCH_MAX_MANIFEST_BYTES } from "../../../packages/contracts/src/sync-small-batch.js";
import { SmallBatchRegistry } from "../../../packages/file-core/src/small-batch-registry.js";
import { PostgresSyncSnapshotStage } from "../../../packages/sync/src/sync-snapshot-stage.js";
import { PostgresSyncSnapshotReader } from "../../../packages/sync/src/sync-snapshot-read.js";
import { completionAdopt } from "./completion-adoption.fixture.js";
import { CatalogPlutoRetention } from "../../../packages/file-core/src/catalog-pluto-retention.js";
import { resumeCompletionFixture, type RetainedClient } from "./completion-resume.fixture.js";
import { sharedBackendFactory } from "./completion-shared-backend.fixture.js";
import { registerCompletionProgress } from "./completion-progress.fixture.js";

// This is an externally controlled receiver entry, not a standalone native test.
// Its controller must run and independently qualify the real callers before
// sending api-stop. Ordinary CI reports this entry as NOT_RUN, never native PASS.
// Faults live in the middle proxy; production handlers and receipts are intact.
it.skipIf(process.env.COMPLETION_RECEIVER !== "1")("manual completion receiver fixture through two hops", async () => {
  const output = requireDefined(process.env.COMPLETION_EVIDENCE);
  if (!output) throw Error("COMPLETION_EVIDENCE required");
  const fixtures: Awaited<ReturnType<typeof activeFixture>>[] = [];
  const app = Fastify(), proxies: http.Server[] = [];
  const traces: object[] = [];
  let fault: { tail: string; kind: string; milliseconds?: number; count?: number } | undefined;
  let unavailable = false;
  const adopted = new Map<number, Awaited<ReturnType<typeof completionAdopt>>>();
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  let retentionJob = Promise.resolve(); let retentionBusy = false;
  const retentionEvents: object[] = [];
  try {
    const storageFactory = await sharedBackendFactory();
    const scaled = !!process.env.COMPLETION_SCALE_ACTIVATION;
    if (scaled && !process.env.COMPLETION_RETAINED_CLIENTS) throw Error("Scale handoff requires retained clients and offline qualification");
    if (process.env.COMPLETION_RETAINED_CLIENTS) {
      const retained = JSON.parse(await fs.readFile(process.env.COMPLETION_RETAINED_CLIENTS, "utf8")) as RetainedClient[];
      if (retained.length !== 2 || retained[0]?.kind !== "windows" || retained[1]?.kind !== "pluto") throw Error("Exact retained receiver pair required");
      for (const client of retained) fixtures.push(await resumeCompletionFixture(client));
    } else for (const kind of ["windows", "pluto"] as const) fixtures.push(await activeFixture("completion-" + kind, kind, 70, storageFactory));
    const ports = process.env.COMPLETION_LISTEN_PORTS ? JSON.parse(process.env.COMPLETION_LISTEN_PORTS) as { port: number; middlePort: number; frontPort: number } : undefined;
    if (Number(process.env.ENDURANCE_TIER ?? 0) >= 8) {
      const f = requireDefined(fixtures[1]), retention = new CatalogPlutoRetention(f.writer, f.admission, f.executor.identity);
      retentionTimer = setInterval(() => {
        if (retentionBusy) return;
        retentionBusy = true;
        retentionJob = retention.tick(f.rootId).then(progress => {
          if (progress.planned || progress.completed || progress.resumed) retentionEvents.push({ at: new Date().toISOString(), ...progress });
        }, (error: unknown) => { retentionEvents.push({ at: new Date().toISOString(), error: String(error) }); }).finally(() => { retentionBusy = false; });
      }, 2000);
    }
    const roots = fixtures.map(f => {
      const guard = { rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, guardRevision: f.binding.guardRevision };
      const scope = { wire: f.wireBinding, guard };
      return { binding: f.wireBinding, guard, authority: f.issuer, files: f.files, admission: f.admission, namespace: f.namespace, mutations: f.mutations, streams: f.streams,
        batches: new SmallBatchRegistry(f.writer, f.issuer), extensions: ["metadata-gzip-v1", "changes-wait-v1", "stream-upload-v1", "namespace-mutations-v1", "folder-batch-v1", "clone-content-v1", ...(scaled?["scale-transfer-v2"]:[])],
        stage: new PostgresSyncSnapshotStage(f.runtime, f.issuer, scope), reader: new PostgresSyncSnapshotReader(f.runtime, f.issuer, scope, "completion", [{ id: "completion", secret: Buffer.alloc(32, 73) }]),
        ensureFolder: async (): Promise<never> => { throw Error("legacy folder route forbidden"); } };
    });
    const root = async (id: string) => { const index = fixtures.findIndex(f => f.rootId === id); return adopted.has(index) ? requireDefined(adopted.get(index)).runtime.scope(id) : roots[index]; };
    // Test-only independent oracle: read committed backend bytes, not client receipts.
    if (process.env.COMPLETION_PROGRESS_ORACLE === 'aggregate-v1') registerCompletionProgress(app, fixtures);
    app.post<{ Body: { kind: string; folder: string; metadataOnly?: boolean; includeVersions?: boolean } }>("/__completion/readback", async request => {
      const snapshot = async () => {
      const f = fixtures[request.body.kind === "windows" ? 0 : request.body.kind === "pluto" ? 1 : -1];
      const segments = request.body.folder.split("/");
      if (!f || !segments.length || segments.some(s => !s || s === "." || s === ".." || s.includes("\\"))) throw Error("owned root-relative folder required");
      let folderId = f.rootId;
      for (const segment of segments) {
        const found = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM resources WHERE parent_id=${folderId} AND name=${segment} AND type='folder' AND status='active'`);
        if (found.length !== 1) return { files: [], folders: [] };
        folderId = String(requireDefined(found[0]).id);
      }
      const rows = await f.admin.withSql(sql => sql<{id:string;type:string;name:string;storage_path:string;sha256:string;size_bytes:string;current_version_id:string;relative_path:string;version_count:number}[]>`
        WITH RECURSIVE tree AS (
          SELECT id,type,name,storage_path,sha256,size_bytes,current_version_id,''::text AS relative_path
          FROM resources WHERE id=${folderId} AND status='active'
          UNION ALL SELECT r.id,r.type,r.name,r.storage_path,r.sha256,r.size_bytes,r.current_version_id,CASE WHEN t.relative_path='' THEN r.name ELSE t.relative_path || '/' || r.name END
          FROM resources r JOIN tree t ON r.parent_id=t.id WHERE r.status='active'
        ) SELECT t.*,(SELECT count(*)::int FROM file_versions v WHERE v.resource_id=t.id) AS version_count FROM tree t ORDER BY relative_path`);
      const files = [];
      for (const row of rows) if (row.type === "file") {
        const hash = createHash("sha256"); let size = 0;
        if (!request.body.metadataOnly) for await (const chunk of await f.raw.openRead(row.storage_path)) { const bytes=Buffer.from(chunk as Uint8Array);hash.update(bytes); size += bytes.length; }
        const versions = [];
        if (request.body.includeVersions) {
          const history = await f.admin.withSql(sql => sql<{id:string;state:string;storage_path:string;sha256:string;size_bytes:string}[]>`SELECT id,state,storage_path,sha256,size_bytes FROM file_versions WHERE resource_id=${row.id} ORDER BY created_at,id`);
          for (const version of history) {
            const exists = await f.raw.exists(version.storage_path); let actualHash: string | undefined;
            if (exists && !request.body.metadataOnly) { const h = createHash("sha256"); for await (const chunk of await f.raw.openRead(version.storage_path)) h.update(chunk as Uint8Array); actualHash = h.digest("hex"); }
            versions.push({ id: version.id, state: version.state, exists, sha256: actualHash, catalogSha256: version.sha256, size: version.size_bytes });
          }
        }
        files.push({ path: row.relative_path, id: row.id, version: row.current_version_id,
          size: request.body.metadataOnly ? undefined : size, sha256: request.body.metadataOnly ? undefined : hash.digest("hex"), catalogSha256: row.sha256, catalogSize: row.size_bytes, versionCount: row.version_count, ...(request.body.includeVersions ? { versions } : {}) });
      }
      return { files, folders: rows.filter(r => r.type === "folder").map(r => r.relative_path) };
      };
      for (let attempt = 0; ; attempt++) {
        try { return await snapshot(); }
        catch (error) {
          // Raw independent readback can intersect archive/rename during publish.
          // Re-read metadata and bytes together; persistent absence still fails.
          const code = (error as NodeJS.ErrnoException).code;
          // The same rename window is ENOENT for local storage and SFTP status 2.
          if ((code !== "ENOENT" && String(code) !== "2") || attempt >= 4) throw error;
          traces.push({ at: new Date().toISOString(), oracle: "raw-readback-rename-window", attempt });
          await delay(50 * (attempt + 1));
        }
      }
    });
    // A second actor edits one existing owned file through the production
    // guarded coordinator. SQL is only used to obtain current preconditions.
    app.post<{ Body: { kind: string; folder: string; name: string; expectedSha256: string; content: string } }>("/__completion/remote-edit", async request => {
      const b = request.body, f = fixtures[b.kind === "windows" ? 0 : b.kind === "pluto" ? 1 : -1];
      const segments = b.folder.split("/");
      if (!f || !segments.length || segments.some(s => !s || s === "." || s === ".." || s.includes("\\")) || b.name !== "conflict.md" || b.content.length > 4096) throw Error("owned conflict fixture required");
      const topology = [];
      let parent = f.rootId;
      const rootRow = requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT name FROM resources WHERE id=${f.rootId}`))[0]);
      topology.push({ nodeId: f.rootId, parentId: null, name: String(rootRow.name) });
      for (const segment of segments) {
        const rows = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM resources WHERE parent_id=${parent} AND name=${segment} AND type='folder' AND status='active'`);
        if (rows.length !== 1) throw Error("owned conflict parent missing");
        topology.unshift({ nodeId: String(requireDefined(rows[0]).id), parentId: parent, name: segment }); parent = String(requireDefined(rows[0]).id);
      }
      const rows = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,metadata_version,current_version_id,sha256 FROM resources WHERE parent_id=${parent} AND name=${b.name} AND type='file' AND status='active'`);
      if (rows.length !== 1 || requireDefined(rows[0]).sha256 !== b.expectedSha256) throw Error("conflict input precondition mismatch");
      const old = requireDefined(rows[0]), bytes = Buffer.from(b.content, "utf8");
      const input = f.uploadInput(b.name, bytes, { nodeId: String(old.id), metadataVersion: String(old.metadata_version), versionId: String(old.current_version_id) });
      const result = await f.upload({ ...input, intent: { ...input.intent, parentId: parent, parentTopology: topology } }, bytes);
      if (result.status.result?.status !== "PUBLISHED") throw Error("independent edit was not published");
      const evidence = { at: new Date().toISOString(), kind: b.kind, rootId: f.rootId, original: old, changedSha256: sha(bytes), result: result.status.result };
      await fs.writeFile(path.join(output, "remote-edit-" + b.kind + ".json"), JSON.stringify(evidence, null, 2));
      return evidence;
    });
    app.post<{ Body: { kind: string } }>("/__completion/adopt", async request => {
      const index = request.body.kind === "windows" ? 0 : request.body.kind === "pluto" ? 1 : -1;
      if (index < 0) throw Error("unknown fixture");
      if (!adopted.has(index)) { if (index === 1) { clearInterval(retentionTimer); retentionTimer = undefined; await retentionJob; } adopted.set(index, await completionAdopt(requireDefined(fixtures[index]))); }
      const artifact = requireDefined(adopted.get(index)).artifact;
      await fs.writeFile(path.join(output, "adoption-" + request.body.kind + ".json"), JSON.stringify(artifact, null, 2));
      return artifact;
    });
    const capabilities = async (rootId: string, authorization: string | undefined) => {
      const index = fixtures.findIndex(f => f.rootId === rootId), f = fixtures[index];
      if (!f) return undefined;
      if (adopted.has(index)) return requireDefined(adopted.get(index)).runtime.capabilities(f.rootId, authorization);
      await f.issuer.device(authorization, f.rootId);
      // Exact ACTIVE-extension envelope from GuardedRuntime.capabilities.
      return { schema: "saturn.sync-capabilities.v1", binding: f.wireBinding,
        device_id: f.uploadInput("capability", Buffer.alloc(0)).intent.deviceId, backend_identity: f.backendIdentity,
        qualification_receipt_sha256: sha("isolated-role-proof"), coverage: "namespace-mutations-v1",
        features: ["snapshot-v1", "changes-v1", "folder-v2", "catalog-upload-v2", ...requireDefined(roots[index]).extensions],
        extensions: { revisions: { K1: 2, K2: 2, K3: 2, K4: 1 }, namespace: f.namespace, minimum_writer: "saturn.namespace-mutation.v1", backend_policy: "managed-exclusive",
          limits: { metadata_items: 500, metadata_bytes: 4194304, long_poll_ms: 25000, gzip_threshold_bytes: 16384, stream_chunk_bytes: 4194304, stream_maximum_chunks: scaled?2147483648:256 } },
        limits: { data_jobs: scaled?8:4, large_jobs: 2, spool_bytes: "1073741824", maximum_file_bytes: "1073741824" } };
    };
    await app.register(guardedSyncCapabilitiesHttp, {
      capabilities,
      smallBatchCapabilities: async (id, authorization) => {
        const index = fixtures.findIndex(f => f.rootId === id);
        if (adopted.has(index)) return requireDefined(adopted.get(index)).runtime.smallBatchCapabilities(id, authorization);
        const base = await capabilities(id, authorization);
        if (!base || !(await root(id))?.batches) return undefined;
        // This fixture has isolated runtime/writer roles including the approved
        // sync_small_batch_command. Use its existing activation receipt/binding.
        return { schema: "saturn.small-file-batch-capabilities.v1", transport: SMALL_BATCH_SCHEMA,
          binding: base.binding, device_id: base.device_id, backend_identity: base.backend_identity,
          qualification_receipt_sha256: base.qualification_receipt_sha256,
          limits: { items: SMALL_BATCH_MAX_ITEMS, file_bytes: String(SMALL_BATCH_MAX_FILE_BYTES),
            data_bytes: String(SMALL_BATCH_MAX_DATA_BYTES), manifest_bytes: String(SMALL_BATCH_MAX_MANIFEST_BYTES) } };
      },
    });
    await app.register(guardedSyncHttp, { root });
    await app.register(guardedSyncFolderHttp, { root });
    await app.register(guardedSyncUploadHttp, { root });
    await app.register(guardedSyncMutationHttp, { root });
    await app.register(guardedSyncStreamHttp, { root });
    await app.register(guardedSyncSmallBatchHttp, { root: async id => {
      const scope = await root(id);
      return scope?.batches ? { ...scope, batches: scope.batches } : undefined;
    } });
    await app.listen({ host: "127.0.0.1", port: ports?.port ?? 0 });
    const port = (app.server.address() as { port: number }).port;
    async function proxy(upstream: number, middle: boolean) {
      const server = http.createServer((request, response) => { void (async () => {
        if (middle && request.url === "/__completion/restore") { unavailable = false; response.end("{}"); return; }
        if (middle && request.url === "/__completion/trace") { response.end(JSON.stringify(traces)); return; }
        if (middle && request.url === "/__completion/fault") {
          const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part as Uint8Array));
          const next = JSON.parse(Buffer.concat(parts).toString()) as NonNullable<typeof fault>;
          if (next.count !== undefined && (next.kind !== "close" || !Number.isInteger(next.count) || next.count < 1 || next.count > 3)) {
            response.writeHead(400); response.end("{}"); return;
          }
          fault = next;
          response.end("{}"); return;
        }
        if (middle && unavailable) { request.socket.destroy(); return; }
        const selected = middle && fault && request.url?.endsWith(fault.tail) ? fault : undefined;
        if (selected) fault = selected.kind === "close" && (selected.count ?? 1) > 1 ? { ...selected, count: (selected.count ?? 1) - 1 } : undefined;
        if (selected?.kind === "407" || selected?.kind === "429") {
          response.writeHead(Number(selected.kind), { "Retry-After": "1", "Content-Type": "application/json" });
          response.end(JSON.stringify({ code: selected.kind === "407" ? "proxy_authentication_required" : "admission_full", retry_after_ms: 1000 }));
          traces.push({ hop: "middle", path: request.url, fault: selected.kind }); return;
        }
        if (selected?.kind === "close") { request.socket.destroy(); traces.push({ hop: "middle", path: request.url, fault: "close" }); return; }
        if (selected?.kind === "stall") await delay(selected.milliseconds ?? 35000);
        if (request.destroyed) return;
        const forwarded = http.request({ host: "127.0.0.1", port: upstream, path: request.url, method: request.method, headers: request.headers }, incoming => { void (async () => {
          traces.push({ hop: middle ? "middle" : "front", path: request.url, method: request.method, status: incoming.statusCode, fault: selected?.kind });
          if ((selected?.kind === "lost-ack" || selected?.kind === "lost-ack-offline") && incoming.statusCode === 200) {
            incoming.resume(); incoming.once("end", () => {
              if (selected.kind === "lost-ack-offline") unavailable = true;
              response.writeHead(requireDefined(incoming.statusCode), { "Content-Type": "application/json", "Content-Length": "1024" });
              response.write("{"); response.flushHeaders(); setTimeout(() => response.destroy(), 20);
            }); return;
          }
          if (selected && incoming.statusCode !== 200 && selected.kind.startsWith("lost-ack")) fault = selected;
          incoming.on("error", () => response.destroy());
          response.writeHead(requireDefined(incoming.statusCode), incoming.headers);
          if (selected?.kind === "slow") {
            for await (const raw of incoming) { const part=Buffer.from(raw as Uint8Array);for (let n = 0; n < part.length; n += 128) { response.write(part.subarray(n, n + 128)); await delay(selected.milliseconds ?? 20); } }
            response.end();
          } else incoming.pipe(response);
        })().catch(()=>response.destroy()); });
        forwarded.on("error", () => response.destroy());
        request.on("aborted", () => forwarded.destroy());
        request.pipe(forwarded);
      })().catch(()=>response.destroy()); });
      await new Promise<void>(resolve => server.listen((middle ? ports?.middlePort : ports?.frontPort) ?? 0, "127.0.0.1", resolve));
      proxies.push(server);
      return (server.address() as { port: number }).port;
    }
    const middlePort = await proxy(port, true), frontPort = await proxy(middlePort, false);
    const configs = fixtures.map((f, n) => ({ kind: n ? "pluto" : "windows", databaseName: "stage3_" + f.suffix, origin: `http://127.0.0.1:${String(frontPort)}/`, faultOrigin: `http://127.0.0.1:${String(middlePort)}/`,
      binding: f.wireBinding, backendIdentity: f.backendIdentity, receipt: sha("isolated-role-proof"), authorization: f.authorization,
      deviceId: f.uploadInput("config", Buffer.alloc(0)).intent.deviceId, namespace: f.namespace, rootName: requireDefined(f.uploadInput("config", Buffer.alloc(0)).intent.parentTopology[0]).name }));
    await fs.writeFile(path.join(output, "clients.private.json"), JSON.stringify(configs, null, 2));
    await fs.writeFile(path.join(output, "api-ready.json"), JSON.stringify({ port, middlePort, frontPort, roots: fixtures.map(f => f.rootId) }));
    for (;;) { try { await fs.access(path.join(output, "api-stop")); break; } catch { await delay(250); } }
    const summaries = [];
    for (const [n, f] of fixtures.entries()) {
      const counts = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT operation_type,state,count(*)::int FROM operation_journal WHERE sync_root_id=${f.rootId} GROUP BY operation_type,state ORDER BY operation_type,state`);
      const resources = await f.admin.withSql(sql => sql<{id:string;name:string;type:string;current_version_id:string}[]>`SELECT id,name,type,current_version_id FROM resources WHERE parent_id=${f.rootId} ORDER BY name`);
      summaries.push({ kind: requireDefined(configs[n]).kind, counts, resources });
      expect(new Set(resources.map(r => r.name)).size).toBe(resources.length);
    }
    await fs.writeFile(path.join(output, "api-receipts.json"), JSON.stringify(summaries, null, 2));
  } finally {
    if (retentionTimer) clearInterval(retentionTimer); await retentionJob;
    await fs.writeFile(path.join(output, "retention-worker.json"), JSON.stringify(retentionEvents, null, 2));
    await fs.writeFile(path.join(output, "api-trace.json"), JSON.stringify(traces, null, 2));
    for (const server of proxies.reverse()) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await app.close();
    // A lost HTTP acknowledgement can leave the handler finishing its original
    // batch. The pre-close summary above is not a final drain receipt.
    const drained = [];
    for (const f of fixtures) {
      const operations = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT operation_type,state,namespace_state,count(*)::int FROM operation_journal WHERE sync_root_id=${f.rootId} GROUP BY operation_type,state,namespace_state ORDER BY operation_type,state,namespace_state`);
      const backendTasks = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT state,count(*)::int FROM sync_backend_tasks GROUP BY state ORDER BY state`);
      const root = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT root_id,epoch,binding_version,namespace_state FROM sync_root_clock WHERE root_id=${f.rootId}`);
      drained.push({ rootId:f.rootId,operations,backendTasks,root });
    }
    await fs.writeFile(path.join(output,"api-receipts-final.json"),JSON.stringify({at:new Date().toISOString(),afterHttpDrain:true,roots:drained},null,2));
    for (const a of adopted.values()) await a.runtime.close();
    for (const f of fixtures) await f.close();
  }
}, Number(process.env.ENDURANCE_SERVER_TIMEOUT_MS ?? 3600000));
