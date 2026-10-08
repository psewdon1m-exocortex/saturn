import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { BackupRunInfo, BackupServiceInfo, DeviceInfo, NeptuneAgentInfo } from "../src/types.js";

const uuid = (number: number) => `eeeeeeee-2026-4000-8000-${String(number).padStart(12, "0")}`;
const timestamp = (offset = 0) => new Date(Date.now() + offset).toISOString();
const hour = 3_600_000;
const previewCode = "MOCK_PREVIEW_NOT_REDEEMABLE";

export function createPipelineMockState() {
  const specs = [
    { namespace: "updater", kind: "host_service", name: "Updater · mock-vps-1", scenario: "ready" },
    { namespace: "neptune", kind: "host_service", name: "Neptune · mock-vps-1", scenario: "ready" },
    { namespace: "gryphon", kind: "host_service", name: "Gryphon · mock-vps-2", scenario: "offline" },
    { namespace: "wyvern", kind: "host_service", name: "Wyvern · mock-vps-2", scenario: "pending" },
    { namespace: "volt", kind: "volt", name: "Volt · archives + mirror", scenario: "ready", mirror: "volt" },
    { namespace: "mastermind", kind: "mastermind", name: "Mastermind · mirror only", scenario: "ready", mirror: "mastermind", archive: false },
    { namespace: "chronos", kind: "service", name: "Chronos · archives only", scenario: "error" },
  ] as const;
  const services: BackupServiceInfo[] = specs.map((spec, index) => ({
    id: uuid(index + 1), slug: `mock-${spec.namespace}`, namespaceSlug: spec.namespace,
    deploymentId: spec.namespace === "gryphon" || spec.namespace === "wyvern" ? "mock-vps-2" : "mock-vps-1", pipelineKind: spec.kind, pipelineGroupId: uuid(100 + index),
    name: `MOCK · ${spec.name}`, state: "active", archivePipeline: "archive" in spec ? spec.archive : true,
    ...("mirror" in spec ? { mirrorRoot: spec.mirror, mirrorDeviceId: uuid(300 + index) } : {}),
    requireEncryption: spec.kind === "host_service", maxBackupBytes: 20 * 1024 ** 3,
    dailyQuotaBytes: 40 * 1024 ** 3, storedQuotaBytes: 500 * 1024 ** 3, maxConcurrentRuns: 1,
    freshnessSlaMs: 24 * hour, retention: { daily: 7, weekly: 4, monthly: 12, yearly: 3 },
    usage: { storedBytes: spec.namespace === "mastermind" ? 0 : (index + 1) * 12 * 1024 ** 2,
      activeReservedBytes: 0, dailyReservedBytes: 0, activeRuns: 0, failedRuns: spec.scenario === "error" ? 1 : 0 },
    fresh: spec.scenario !== "offline", createdAt: timestamp(-7 * 24 * hour), updatedAt: timestamp(),
  }));
  const devices: DeviceInfo[] = ["Office PC", "Home laptop"].map((name, index) => ({
    id: uuid(200 + index), name: `MOCK · ${name}`, deviceKind: "windows_sync", state: "active",
    syncRootId: uuid(400 + index), syncFolderName: `MOCK ${name}`, scopeIds: [uuid(400 + index)],
    rights: { read: true, write: true, move: true, delete: true }, clientPlatform: "windows",
    clientVersion: "mock-preview", createdAt: timestamp(-7 * 24 * hour), updatedAt: timestamp(),
  }));
  devices.push({ id: uuid(210), name: "MOCK · External configs", deviceKind: "pluto", state: "active", syncRootId: uuid(410), syncFolderName: "MOCK External configs", scopeIds: [uuid(410)], rights: { read: true, write: true, move: false, delete: false }, clientPlatform: "linux", clientVersion: "mock-preview", createdAt: timestamp(-7 * 24 * hour), updatedAt: timestamp(), plutoStatus: { enabled: true, intervalSeconds: 3600, uploadedFiles: 4, lastSuccessAt: timestamp(-600_000), nextRunAt: timestamp(3_000_000) } });
  return {
    services, devices,
    agents(): NeptuneAgentInfo[] {
      return services.map((service, index) => {
        const spec = specs[index];
        const online = spec?.scenario !== "offline" && service.state === "active";
        return { serviceId: service.id, desired: { revision: 4, archiveEnabled: service.archivePipeline !== false,
          archiveIntervalHours: 24, mirrorEnabled: service.mirrorRoot !== undefined, mirrorIntervalMinutes: 15 },
          observed: { clientInstanceId: `mock-linux-${String(index + 1)}`, projectId: service.namespaceSlug,
            version: "mock-preview", appliedRevision: spec?.scenario === "pending" ? 3 : 4, online,
            lastSeenAt: timestamp(online ? -2_000 : -2 * hour),
            archive: service.archivePipeline === false ? {} : { state: spec?.scenario === "error" ? "failed" : "idle",
              lastAttemptAt: timestamp(-hour), lastSuccessAt: timestamp(-3 * hour), nextRunAt: timestamp(21 * hour) },
            mirror: service.mirrorRoot === undefined ? {} : { state: "idle", lastSuccessAt: timestamp(-60_000) },
            ...(spec?.scenario === "error" ? { latestError: "MOCK · Simulated archive upload timeout" } : {}) },
          updatedAt: timestamp() };
      });
    },
    windows(): DeviceInfo[] {
      return devices.filter(device => device.deviceKind === "windows_sync").map((device, index) => ({ ...device, lastSeenAt: timestamp(index === 0 ? -2_000 : -2 * hour) }));
    },
    connectedDevices(): DeviceInfo[] { return devices.map((device, index) => ({ ...device, lastSeenAt: timestamp(index === 1 ? -2 * hour : -2_000) })); },
    runs(service: BackupServiceInfo): BackupRunInfo[] {
      if (service.archivePipeline === false) return [];
      return [{ id: uuid(500 + services.indexOf(service)), serviceId: service.id,
        filename: `MOCK-${service.namespaceSlug}-preview.zip`, backupType: "mock-preview",
        createdAt: timestamp(-3 * hour), expectedSize: 12 * 1024 ** 2, sha256: "0".repeat(64),
        sourceVersion: "mock-preview", encrypted: service.requireEncryption, state: "complete",
        receivedSize: 12 * 1024 ** 2, updatedAt: timestamp(-3 * hour),
        receipt: { logicalPath: `MOCK · backups/${service.namespaceSlug}/${service.deploymentId}/preview.zip`,
          committedAt: timestamp(-3 * hour), sizeBytes: 12 * 1024 ** 2, sha256: "0".repeat(64) } }];
    },
  };
}

type Next = (error?: unknown) => void;

export function createPipelineMockMiddleware(options: { readonly enabled: () => boolean; readonly apiOrigin: string }) {
  const state = createPipelineMockState();
  return async (request: IncomingMessage, response: ServerResponse, next: Next) => {
    if (!options.enabled()) { next(); return; }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const method = request.method ?? "GET";
    const collections = ["/api/v1/backup-services", "/api/v1/devices", "/api/v1/operator/neptune/agents"];
    const service = state.services.find(item => pathname.startsWith(`/api/v1/backup-services/${item.id}`)
      || pathname.startsWith(`/api/v1/operator/neptune/agents/${item.id}`));
    const device = state.devices.find(item => pathname.startsWith(`/api/v1/devices/${item.id}`));
    const collection = method === "GET" && collections.includes(pathname);
    if (!collection && service === undefined && device === undefined) { next(); return; }
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Saturn-Dev-Mock": "pipelines" });
      response.end(JSON.stringify(body));
    };
    const headers = { Cookie: request.headers.cookie ?? "", "User-Agent": request.headers["user-agent"] ?? "" };
    try {
      const auth = await fetch(`${options.apiOrigin}/api/v1/auth/session`, { headers, signal: AbortSignal.timeout(5_000) });
      if (!auth.ok) { send(auth.status, { code: "authentication_required" }); return; }
      if (!["GET", "HEAD"].includes(method)) {
        const csrf = /(?:^|;\s*)vault_csrf_dev=([^;]+)/.exec(headers.Cookie)?.[1];
        if (!csrf || request.headers["x-vault-csrf"] !== csrf || request.headers.origin !== "http://127.0.0.1:5173") {
          send(403, { code: "csrf_rejected" }); return;
        }
      }
      if (collection) {
        const upstream = await fetch(`${options.apiOrigin}${request.url ?? pathname}`, { headers, signal: AbortSignal.timeout(5_000) });
        if (!upstream.ok) { send(upstream.status, await upstream.json()); return; }
        const real: unknown = await upstream.json();
        if (!Array.isArray(real)) { send(502, { code: "invalid_upstream_collection" }); return; }
        const mock = pathname.endsWith("backup-services") ? state.services : pathname.endsWith("devices") ? state.connectedDevices() : state.agents();
        send(200, [...(real as unknown[]), ...mock]); return;
      }
      const entity = service ?? device;
      if (entity === undefined) { next(); return; }
      if (method === "GET" && pathname.endsWith("/runs") && service) { send(200, state.runs(service)); return; }
      if (method === "GET" && pathname === `/api/v1/operator/neptune/agents/${service?.id ?? ""}`) {
        send(200, state.agents().find(agent => agent.serviceId === service?.id)); return;
      }
      if (method === "POST" && pathname.endsWith("/enrollment")) {
        if (entity.state !== "active") { send(409, { code: "mock_identity_revoked" }); return; }
        send(201, { code: previewCode, expiresAt: timestamp(900_000), ...(service ? { service } : { device }) }); return;
      }
      if (method === "DELETE" && pathname.endsWith(`/${entity.id}`)) {
        if (service) state.services.splice(state.services.indexOf(service), 1, { ...service, state: "revoked" });
        if (device) state.devices.splice(state.devices.indexOf(device), 1, { ...device, state: "revoked" });
        send(200, { ...entity, state: "revoked" }); return;
      }
      // Never forward a mock identity to the real API, DAV or agent control plane.
      send(409, { code: "mock_preview_only", message: "MOCK preview: this action has no real agent or stored archive." });
    } catch {
      send(503, { code: "mock_upstream_unavailable" });
    }
  };
}

export function pipelineMocks(): Plugin {
  return {
    name: "saturn-development-pipeline-mocks",
    apply: (_config, environment) => environment.command === "serve" && environment.mode === "development" && process.env.NODE_ENV !== "production",
    configureServer(server) {
      const flag = path.resolve(server.config.root, "../../.tmp/pipeline-mocks.enabled");
      const middleware = createPipelineMockMiddleware({ apiOrigin: "http://127.0.0.1:3000", enabled: () => {
        try { return fs.readFileSync(flag, "utf8").trim() === "enabled"; } catch { return false; }
      } });
      server.middlewares.use((request, response, next) => { void middleware(request, response, next); });
    },
  };
}
