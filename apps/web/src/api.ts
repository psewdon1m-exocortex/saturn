import type { ArchiveJobInfo, AuditEventInfo, BackupRunInfo, BackupServiceInfo, DeviceInfo, DropSessionInfo, DropUploadStatus, FileVersion, GryphonBot, GryphonStatus, KernelStatus, NeptuneAgentInfo, NeptuneAvailability, NeptuneReleaseCheck, NeptuneStatus, OperatorOverview, OwnerPreferences, RecoveryRestoreCandidate, RecoveryRestoreResult, RecoveryStatus, Resource, ShareChild, ShareInfo, StorageConnectionInput, StorageConnectionStatus, StorageAnalysisJob, StorageAnalysisReport, UpdateStatus } from "./types.js";
import { uploadSourceHasher } from "./upload-sha256.js";
import { errorValue } from "./error-value.js";
import { listUploadRecovery, uploadSourceLock, withUploadSourceLock, type UploadRecoveryRecord, type UploadRecoveryScope } from "./upload-recovery-store.js";
import { hydrateUploadRecovery, listDurableUploadRecovery, saveDurableUploadRecovery, removeDurableUploadRecovery, removeDurableUploadRecoveries } from "./upload-recovery-durable.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, body: unknown) {
    const detail = typeof body === "object" && body !== null
      ? ["message", "error"].map((key) => key in body ? (body as Record<string, unknown>)[key] : undefined)
        .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim().slice(0, 500)
      : undefined;
    super(detail === undefined ? `Gateway request failed with status ${String(status)}` : `${detail} (HTTP ${String(status)})`);
    this.status = status;
    if (typeof body === "object" && body !== null && "code" in body && typeof body.code === "string") this.code = body.code;
  }
}

function cookieToken(names: readonly string[]): string | undefined {
  const prefix = document.cookie.split("; ").find((value) => names.some((name) => value.startsWith(`${name}=`)));
  if (prefix === undefined) return undefined;
  return decodeURIComponent(prefix.slice(prefix.indexOf("=") + 1));
}

function csrfToken(): string | undefined {
  return cookieToken(["vault_csrf_dev", "__Host-vault_csrf"]);
}

function dropCsrfToken(): string | undefined {
  return cookieToken(["vault_drop_csrf_dev", "__Host-vault_drop_csrf"]);
}

const DROP_CHANNEL_HISTORY_KEY = "saturnDropChannelId";

function dropChannelHint(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value: unknown = window.history.state;
  if (typeof value !== "object" || value === null || !(DROP_CHANNEL_HISTORY_KEY in value)) return undefined;
  const channelId = (value as Record<string, unknown>)[DROP_CHANNEL_HISTORY_KEY];
  return typeof channelId === "string" && channelId !== "" ? channelId : undefined;
}

export async function request<T>(relativePath: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const method = options.method?.toUpperCase() ?? "GET";
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = csrfToken();
    if (csrf !== undefined) headers.set("X-Vault-CSRF", csrf);
  }
  const response = await fetch(`/api/v1${relativePath}`, { ...options, headers, credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as unknown;
    throw new ApiError(response.status, body);
  }
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json") ? await response.json() as T : await response.text() as T;
}

export async function dropRequest<T>(relativePath: string, options: RequestInit = {}, csrf = true, channelId = dropChannelHint()): Promise<T> {
  const headers = new Headers(options.headers);
  const method = options.method?.toUpperCase() ?? "GET";
  if (channelId !== undefined) headers.set("X-Saturn-Drop-Channel", channelId);
  if (csrf && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    const token = dropCsrfToken();
    if (token !== undefined) headers.set("X-Vault-CSRF", token);
  }
  const response = await fetch(`/api/v1/drop${relativePath}`, { ...options, headers, credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as unknown;
    throw new ApiError(response.status, body);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function publicShareRequest<T>(token: string, relativePath = "", options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1/public/shares/${encodeURIComponent(token)}${relativePath}`, { ...options, credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as unknown;
    throw new ApiError(response.status, body);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export const api = {
  publicAppearance: (signal?: AbortSignal) => request<{ readonly accentColor: string }>("/auth/public-appearance", signal === undefined ? {} : { signal }),
  session: () => request<{ readonly state: string; readonly expiresAt?: string }>("/auth/session"),
  login: (accessKey: string) => request<{ readonly state: string }>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey }),
  }),
  logout: () => request<{ readonly state: string }>("/auth/logout", { method: "POST" }),
  reauthenticate: (accessKey: string) => request<{ readonly state: string }>("/auth/reauthenticate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey }),
  }),
  changeAccessKey: (input: { readonly currentAccessKey: string; readonly newAccessKey: string; readonly confirmation: string }) => request<{ readonly state: string; readonly revokedSessions: number }>("/auth/access-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }),
  preferences: () => request<OwnerPreferences>("/auth/preferences"),
  updatePreferences: (input: Omit<OwnerPreferences, "updatedAt">) => request<OwnerPreferences>("/auth/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }),
  overview: () => request<OperatorOverview>("/operator/overview"),
  controlTransferTask: async (id: string, action: "pause" | "resume" | "cancel") => {
    const result = await request<{ readonly id: string; readonly state: "running" | "paused" | "cancelled" }>(`/operator/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
    });
    if (action === "cancel") { ownerUploadControllers.get(id)?.abort(); ownerUploadChannel()?.postMessage({ action: "cancel", id }); }
    return result;
  },
  updateStatus: () => request<UpdateStatus>("/operator/updates"),
  checkSaturnUpdate: () => request<{ update_available: boolean; available_version?: string; installed_version: string }>("/operator/updates/check", { method: "POST" }),
  installSaturnUpdate: (version: string) => request<{ id: string; state: string; message?: string }>("/operator/updates/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version }) }),
  agentJob: (id: string) => request<{ id: string; state: string; message?: string; rollback_available?: boolean }>(`/operator/updates/jobs/${encodeURIComponent(id)}`),
  rollbackSaturnUpdate: (id: string) => request<{ id: string; state: string }>(`/operator/updates/jobs/${encodeURIComponent(id)}/rollback`, { method: "POST" }),
  initializeGryphon: (requestId: string = crypto.randomUUID()) => request<{ id: string; state: string }>("/operator/gryphon/initialize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: requestId }) }),
  recoveryStatus: () => request<RecoveryStatus>("/operator/recovery"),
  neptuneStatus: () => request<NeptuneStatus>("/operator/neptune/status"),
  neptuneAvailability: () => request<NeptuneAvailability>("/operator/neptune/availability"),
  initializeNeptune: (enrollmentCode: string, requestId?: string) => request<{ readonly id: string; readonly state: string }>("/operator/neptune/initialize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enrollment_code: enrollmentCode, request_id: requestId }) }),
  unlinkNeptune: () => request<{ readonly id: string; readonly state: string }>("/operator/neptune/unlink", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
  neptuneInitialization: (id: string) => request<{ readonly id: string; readonly state: string; readonly message?: string }>(`/operator/neptune/initializations/${encodeURIComponent(id)}`),
  neptuneAgents: () => request<readonly NeptuneAgentInfo[]>("/operator/neptune/agents"),
  gryphonStatus: () => request<GryphonStatus>("/operator/gryphon/status"),
  gryphonManagement: () => request<{ url: string }>("/operator/gryphon/management"),
  gryphonBots: () => request<{ readonly bots: readonly GryphonBot[] }>("/operator/gryphon/bots"),
  connectGryphon: (botId: string) => request<GryphonStatus>("/operator/gryphon/connection", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botId }) }),
  disconnectGryphon: () => request<{ readonly disconnected: boolean }>("/operator/gryphon/connection", { method: "DELETE" }),
  attachGryphonOwner: () => request<GryphonStatus>("/operator/gryphon/binding", { method: "PUT" }),
  checkGryphonUpdate: () => request<NeptuneReleaseCheck>("/operator/gryphon/update/check", { method: "POST" }),
  installGryphonUpdate: (version: string) => request<{ readonly updated: boolean; readonly version: string }>("/operator/gryphon/update/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version }) }),
  beginRecoveryRestore: (filename: string, expectedBytes: number) => request<{ readonly id: string; readonly filename: string; readonly archiveBytes: number; readonly state: "uploading" }>("/operator/recovery/restores", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename, expectedBytes }),
  }),
  validateRecoveryRestore: (id: string) => request<RecoveryRestoreCandidate>(`/operator/recovery/restores/${encodeURIComponent(id)}/validate`, { method: "POST" }),
  applyRecoveryRestore: (id: string) => request<RecoveryRestoreResult>(`/operator/recovery/restores/${encodeURIComponent(id)}/apply`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "RESTORE" }),
  }),
  cancelRecoveryRestore: (id: string) => request<undefined>(`/operator/recovery/restores/${encodeURIComponent(id)}`, { method: "DELETE" }),
  kernelStatus: () => request<KernelStatus>("/operator/kernel"),
  changeKernelUrl: (url: string) => request<KernelStatus>("/operator/kernel/url", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }),
  rotateKernelToken: (token: string) => request<KernelStatus>("/operator/kernel/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }),
  storageStatus: () => request<StorageConnectionStatus>("/operator/storage"),
  storageAnalysis: (offset = 0) => request<StorageAnalysisReport>(`/operator/storage/analysis?offset=${String(offset)}`),
  analyzeStorage: () => request<StorageAnalysisJob>("/operator/storage/analysis", { method: "POST" }),
  synchronizeStorageCatalog: (id: string) => request<StorageAnalysisJob>(`/operator/storage/analysis/${encodeURIComponent(id)}/synchronize`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "SYNCHRONIZE CATALOG" }),
  }),
  testStorage: (input: StorageConnectionInput) => request<Omit<StorageConnectionStatus, "profileId" | "revision" | "activatedAt" | "source">>("/operator/storage/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
  switchStorage: (input: StorageConnectionInput) => request<StorageConnectionStatus>("/operator/storage/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, confirmation: "SWITCH WITHOUT MIGRATION" }) }),
  activity: (before?: number, limit = 100) => request<readonly AuditEventInfo[]>(`/activity?limit=${String(limit)}${before === undefined ? "" : `&before=${String(before)}`}`),
  createDropCode: () => request<{ readonly code: string; readonly url: string; readonly expiresAt: string }>("/drop/codes", { method: "POST" }),
  openInternalDropSession: () => request<DropSessionInfo>("/drop/internal/session", { method: "POST" }),
  dropBuffer: () => request<{ readonly capacity?: NonNullable<DropSessionInfo["buffer"]>; readonly sessionTtlMs: number; readonly continuationTtlMs: number; readonly workers: number; readonly intervalMs: number; readonly maximumFileBytes: number }>("/drop/buffer"),
  resource: (id: string, signal?: AbortSignal) => request<Resource>(`/resources/${encodeURIComponent(id)}`, signal === undefined ? {} : { signal }),
  resolveFolder: (rootId: string, segments: readonly string[], signal?: AbortSignal) => {
    const query = new URLSearchParams({ rootId, path: segments.join("/") });
    return request<readonly Resource[]>(`/folders/resolve?${query.toString()}`, signal === undefined ? {} : { signal });
  },
  childrenPage: async (id: string, offset = 0, signal?: AbortSignal): Promise<{ readonly items: readonly Resource[]; readonly nextOffset: number | null }> => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - 500) throw new Error("Invalid folder page offset");
    const items = await request<readonly Resource[]>(`/folders/${encodeURIComponent(id)}/children?offset=${String(offset)}&limit=500`, signal === undefined ? {} : { signal });
    if (!Array.isArray(items) || items.length > 500) throw new Error("Folder page exceeds its bound");
    // This owner endpoint filters active rows in SQL before LIMIT. Shared
    // classification-filtered endpoints must use their explicit raw cursor.
    return { items, nextOffset: items.length === 500 ? offset + 500 : null };
  },
  children: async (id: string) => {
    const children: Resource[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await request<readonly Resource[]>(`/folders/${encodeURIComponent(id)}/children?offset=${String(offset)}&limit=500`);
      children.push(...page);
      if (page.length < 500) return children;
    }
  },
  trash: () => request<readonly Resource[]>("/trash?limit=500"),
  archiveJobs: (parentId?: string) => request<readonly ArchiveJobInfo[]>(`/archives/jobs?limit=50${parentId === undefined ? "" : `&parentId=${encodeURIComponent(parentId)}`}`),
  createArchive: (destinationParentId: string, sourceResourceIds: readonly string[], outputName: string) => request<ArchiveJobInfo>("/archives/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destinationParentId, sourceResourceIds, outputName }),
  }),
  extractArchive: (resourceId: string) => request<ArchiveJobInfo>(`/archives/resources/${encodeURIComponent(resourceId)}/extract`, { method: "POST" }),
  controlArchiveJob: (id: string, action: "pause" | "resume" | "cancel") => request<ArchiveJobInfo>(`/archives/jobs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  }),
  createFolder: (parentId: string, name: string) => request<Resource>("/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentId, name }),
  }),
  move: (id: string, parentId: string, name?: string) => request<Resource>(`/resources/${encodeURIComponent(id)}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `web-move-${crypto.randomUUID()}` },
    body: JSON.stringify({ parentId, ...(name === undefined ? {} : { name }) }),
  }),
  copy: (id: string, parentId: string, name?: string) => request<Resource>(`/resources/${encodeURIComponent(id)}/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `web-copy-${crypto.randomUUID()}` },
    body: JSON.stringify({ parentId, ...(name === undefined ? {} : { name }) }),
  }),
  trashResource: (id: string) => request<Resource>(`/resources/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "Idempotency-Key": `web-trash-${crypto.randomUUID()}` },
  }),
  restoreResource: (id: string) => request<Resource>(`/resources/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    headers: { "Idempotency-Key": `web-restore-${crypto.randomUUID()}` },
  }),
  purgeTrashResource: (id: string) => request<Resource>(`/trash/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "Idempotency-Key": `web-purge-${id}` },
  }),
  versions: (id: string) => request<readonly FileVersion[]>(`/files/${encodeURIComponent(id)}/versions?limit=100`),
  restoreVersion: (id: string, versionId: string) => request<Resource>(`/files/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`, {
    method: "POST",
    headers: { "Idempotency-Key": `web-version-restore-${crypto.randomUUID()}` },
  }),
  shares: () => request<readonly ShareInfo[]>("/shares?limit=200"),
  createShare: (input: { readonly resourceId: string; readonly mode: ShareInfo["mode"]; readonly expiresAt?: string; readonly password?: string; readonly maxDownloads?: number }) => request<{ readonly token: string; readonly url: string; readonly share: ShareInfo }>("/shares", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }),
  shareCapability: (id: string) => request<{ readonly url: string; readonly replaced: boolean }>(`/shares/${encodeURIComponent(id)}/capability`, { method: "POST" }),
  revokeShare: (id: string) => request<ShareInfo>(`/shares/${encodeURIComponent(id)}`, { method: "DELETE" }),
  classifyResource: (id: string, classification: NonNullable<Resource["securityClassification"]>) => request<Resource>(`/resources/${encodeURIComponent(id)}/classification`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classification }),
  }),
  devices: () => request<readonly DeviceInfo[]>("/devices?limit=200"),
  createDevice: (input: { readonly name: string; readonly scopeIds: readonly string[]; readonly rights: DeviceInfo["rights"] }) => request<{ readonly token: string; readonly device: DeviceInfo }>("/devices", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }),
  createDeviceEnrollment: (name: string, deviceKind?: "pluto") => request<{ readonly code: string; readonly expiresAt: string; readonly device: DeviceInfo }>("/devices/enrollments", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, ...(deviceKind === undefined ? {} : { deviceKind }) }),
  }),
  createDeviceReplacementEnrollment: (id: string) => request<{ readonly code: string; readonly expiresAt: string; readonly device: DeviceInfo }>(`/devices/${encodeURIComponent(id)}/enrollment`, { method: "POST" }),
  revokeDevice: (id: string) => request<DeviceInfo>(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  backupServices: () => request<readonly BackupServiceInfo[]>("/backup-services?limit=200"),
  backupRuns: (serviceId: string, limit = 10) => request<readonly BackupRunInfo[]>(`/backup-services/${encodeURIComponent(serviceId)}/runs?limit=${String(limit)}`),
  createBackupEnrollment: (input: { readonly namespaceSlug: string; readonly deploymentId: string; readonly name: string; readonly requireEncryption: boolean; readonly maxConcurrentRuns: number; readonly pipelineKind: BackupServiceInfo["pipelineKind"]; readonly archivePipeline?: boolean; readonly mirrorRoot?: "volt" | "mastermind" }) => request<{ readonly code: string; readonly expiresAt: string; readonly service: BackupServiceInfo }>("/backup-services/enrollments", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }),
  rotateBackupService: (id: string) => request<{ readonly token: string; readonly service: BackupServiceInfo }>(`/backup-services/${encodeURIComponent(id)}/rotate-token`, { method: "POST" }),
  createBackupServiceEnrollment: (id: string) => request<{ readonly code: string; readonly expiresAt: string; readonly service: BackupServiceInfo }>(`/backup-services/${encodeURIComponent(id)}/enrollment`, { method: "POST" }),
  revokeBackupService: (id: string) => request<BackupServiceInfo>(`/backup-services/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

function responseFilename(response: Response): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded !== undefined) {
    try { return decodeURIComponent(encoded); } catch { /* Fall through to the safe ASCII name. */ }
  }
  return /filename="([^"]+)"/i.exec(disposition)?.[1] ?? "saturn-snapshot.zip";
}

export async function downloadRecoverySnapshot(): Promise<{ readonly filename: string; readonly createdAt?: string }> {
  const headers = new Headers();
  const csrf = csrfToken();
  if (csrf !== undefined) headers.set("X-Vault-CSRF", csrf);
  const response = await fetch("/api/v1/operator/recovery/snapshots", { method: "POST", headers, credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as unknown;
    throw new ApiError(response.status, body);
  }
  const filename = responseFilename(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const createdAt = response.headers.get("x-saturn-created-at");
  return { filename, ...(createdAt === null ? {} : { createdAt }) };
}

export async function uploadRecoverySnapshot(file: File, onProgress: (progress: number) => void, maximumChunkBytes = 8 * 1024 * 1024): Promise<RecoveryRestoreCandidate> {
  const upload = await api.beginRecoveryRestore(file.name, file.size);
  const chunkBytes = Math.max(1, Math.min(8 * 1024 * 1024, Math.floor(maximumChunkBytes)));
  let offset = 0;
  try {
    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(file.size, offset + chunkBytes));
      await request<undefined>(`/operator/recovery/restores/${encodeURIComponent(upload.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) },
        body: chunk,
      });
      offset += chunk.size;
      onProgress(offset / file.size);
    }
    return await api.validateRecoveryRestore(upload.id);
  } catch (error) {
    await api.cancelRecoveryRestore(upload.id).catch(() => undefined);
    throw error;
  }
}

export const publicShareApi = {
  metadata: (token: string) => publicShareRequest<ShareInfo>(token),
  unlock: (token: string, password: string) => publicShareRequest<ShareInfo>(token, "/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }),
  children: (token: string, parentId?: string) => publicShareRequest<readonly ShareChild[]>(token, `/children${parentId === undefined ? "" : `?parentId=${encodeURIComponent(parentId)}`}`),
  childrenPage: async (token: string, parentId?: string, offset = 0, signal?: AbortSignal) => {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid shared folder page");
    const query = new URLSearchParams({ offset: String(offset), limit: "500", ...(parentId === undefined ? {} : { parentId }) });
    const page = await publicShareRequest<{ readonly items: readonly ShareChild[]; readonly nextOffset: number | null }>(token, `/children/page?${query}`, signal === undefined ? {} : { signal });
    if (!Array.isArray(page.items) || page.items.length > 500 || page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)) throw new Error("Invalid shared folder page response");
    return page;
  },
  preparePackage: (token: string) => publicShareRequest<{ readonly state: string; readonly sizeBytes: number }>(token, "/package", { method: "POST" }),
  packageStatus: (token: string) => publicShareRequest<{ readonly state: string; readonly sizeBytes: number }>(token, "/package/status"),
  thumbnailUrl: (token: string, resourceId: string) => `/api/v1/public/shares/${encodeURIComponent(token)}/thumbnail/${encodeURIComponent(resourceId)}`,
  contentUrl: (token: string, resourceId?: string, download = false) => `/api/v1/public/shares/${encodeURIComponent(token)}/content${resourceId === undefined ? "" : `/${encodeURIComponent(resourceId)}`}${download ? `?transferId=${crypto.randomUUID()}` : ""}`,
  packageUrl: (token: string) => `/api/v1/public/shares/${encodeURIComponent(token)}/package?transferId=${crypto.randomUUID()}`,
};

export function folderDownloadUrl(id: string): string {
  return `/api/v1/folders/${encodeURIComponent(id)}/archive?transferId=${crypto.randomUUID()}`;
}

export const dropApi = {
  session: () => dropRequest<DropSessionInfo>("/session"),
  redeem: (code: string) => dropRequest<DropSessionInfo>("/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  }, false),
  status: async (id: string, signal?: AbortSignal, channelId = dropChannelHint()) => {
    const value = await dropRequest<DropUploadStatus>(`/uploads/${encodeURIComponent(id)}/status`, signal === undefined ? {} : { signal }, true, channelId);
    await reconcileDropRecovery(channelId, [value]); return value;
  },
  uploads: async (signal?: AbortSignal, channelId = dropChannelHint()) => {
    const values = await dropRequest<readonly DropUploadStatus[]>("/uploads", signal === undefined ? {} : { signal }, true, channelId);
    await reconcileDropRecovery(channelId, values); return values;
  },
  subscribeUploads: (onUploads: (uploads: readonly DropUploadStatus[]) => void): (() => void) | undefined => {
    if (typeof EventSource === "undefined") return undefined;
    const channelId = dropChannelHint();
    const query = channelId === undefined ? "" : `?channelId=${encodeURIComponent(channelId)}`;
    const source = new EventSource(`/api/v1/drop/events${query}`, { withCredentials: true });
    source.addEventListener("uploads", (event) => {
      try {
        const value: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (Array.isArray(value)) {
          onUploads(value as readonly DropUploadStatus[]);
          // Keep authoritative snapshot order even while durable cleanup runs.
          // Failed cleanup retains an original for the next status/recovery check.
          void reconcileDropRecovery(channelId, value as readonly DropUploadStatus[]).catch(() => undefined);
        }
      } catch {
        // A malformed event is ignored; EventSource will continue with the next authoritative snapshot.
      }
    });
    return () => source.close();
  },
  cancel: (id: string) => dropRequest<DropUploadStatus>(`/uploads/${encodeURIComponent(id)}`, { method: "DELETE" }),
  logout: () => dropRequest<{ readonly state: string }>("/logout", { method: "POST" }),
};

async function reconcileDropRecovery(channelId: string | undefined, statuses: readonly DropUploadStatus[]): Promise<void> {
  if (channelId === undefined) return;
  const terminal = new Map(statuses.filter(value => ["stored", "completed", "cancelled"].includes(value.state)).map(value => [value.id, value]));
  if (terminal.size === 0) return;
  const resolved: string[] = [];
  for (const record of await listDurableUploadRecovery()) {
    if (record.channel !== "drop" || record.channelId !== channelId || record.id === undefined) continue;
    const value = terminal.get(record.id);
    if (value !== undefined && value.expectedSize === record.expectedSize) resolved.push(record.operationId);
  }
  await removeDurableUploadRecoveries(resolved);
}

function uploadRetryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(errorValue(signal?.reason ?? new DOMException("Cancelled", "AbortError")));
    };
    const timer = window.setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// Only upload admission has this replay wrapper: its caller captures one key
// and immutable body before the first attempt. Never apply it to arbitrary POSTs.
async function admitUpload<T>(create: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try { return await create(); }
    catch (error) {
      signal?.throwIfAborted();
      if (attempt >= 2 || !(error instanceof TypeError || error instanceof ApiError && error.status >= 500)) throw error;
      await uploadRetryDelay(200 * 2 ** attempt, signal);
    }
  }
}

async function prepareUploadRecovery(file: File, scope: UploadRecoveryScope, signal?: AbortSignal): Promise<UploadRecoveryRecord> {
  signal?.throwIfAborted();
  const key = uploadSourceLock(scope, file.name);
  const existing = (await listDurableUploadRecovery()).filter(item => uploadSourceLock(item, item.filename) === key);
  if (existing.length > 1) throw new Error("Multiple unresolved uploads need reconciliation before this source can be sent again.");
  const prior = existing[0];
  if (prior !== undefined && (prior.expectedSize !== file.size || prior.lastModified !== file.lastModified)) throw new Error(`Select the original ${prior.filename} file; its existing upload must be resolved first.`);
  const sha256 = await uploadSourceHasher.hash(file, signal === undefined ? {} : { signal });
  signal?.throwIfAborted();
  if (prior !== undefined) {
    if (prior.sha256 !== sha256) throw new Error("Selected file SHA-256 differs from the original upload. No upload was resumed.");
    return prior;
  }
  const operationId = crypto.randomUUID();
  const record: UploadRecoveryRecord = { schema: 2, ...scope, operationId, idempotencyKey: `${scope.channel === "owner" ? "web-upload" : "drop-web"}-${operationId}`, filename: file.name, expectedSize: file.size, lastModified: file.lastModified, sha256, createdAt: Date.now() };
  await saveDurableUploadRecovery(record);
  return record;
}

export async function uploadDropFile(file: File, onProgress: (progress: number) => void, options: { readonly signal?: AbortSignal; readonly channelId?: string; readonly onCreated?: (upload: DropUploadStatus) => void } = {}): Promise<DropUploadStatus> {
  options.signal?.throwIfAborted();
  const channelId = options.channelId ?? dropChannelHint() ?? (await dropApi.session()).channelId;
  const scope = { channel: "drop" as const, channelId };
  return withUploadSourceLock(uploadSourceLock(scope, file.name), async () => {
    // Bound durable backlog before hashing/reading another source. Poll the
    // authenticated original channel; never discard an unknown record for space.
    for (;;) {
      const records = await listDurableUploadRecovery();
      if (records.length < 124 || records.some(item => uploadSourceLock(item, item.filename) === uploadSourceLock(scope, file.name))) break;
      options.signal?.throwIfAborted();
      await dropApi.uploads(options.signal, channelId);
      if ((await listDurableUploadRecovery()).length < 124) break;
      await uploadRetryDelay(1_000, options.signal);
    }
    const record = await prepareUploadRecovery(file, scope, options.signal);
    return continueDropUpload(file, record, onProgress, options);
  });
}

async function continueDropUpload(file: File, record: UploadRecoveryRecord, onProgress: (progress: number) => void, options: { readonly signal?: AbortSignal; readonly onCreated?: (upload: DropUploadStatus) => void }): Promise<DropUploadStatus> {
  if (record.channel !== "drop") throw new Error("Invalid Drop recovery scope");
  const channelId = record.channelId;
  options.signal?.throwIfAborted();
  const status = () => {
    const id = record.id;
    if (id === undefined) throw new Error("Original Drop upload identity is unavailable");
    return dropRequest<DropUploadStatus>(`/uploads/${encodeURIComponent(id)}/status`, options.signal === undefined ? {} : { signal: options.signal }, true, channelId);
  };
  const admission: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": record.idempotencyKey },
    body: JSON.stringify({ filename: record.filename, expectedSize: record.expectedSize, expectedSha256: record.sha256 }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const created = record.id === undefined ? await admitUpload(() => dropRequest<DropUploadStatus>("/uploads", admission, true, channelId), options.signal) : await status();
  if (created.expectedSize !== file.size || !Number.isSafeInteger(created.receivedSize) || created.receivedSize < 0 || created.receivedSize > file.size) throw new Error("Drop recovery metadata is invalid");
  record = { ...record, id: created.id }; await saveDurableUploadRecovery(record);
  options.onCreated?.(created);
  options.signal?.throwIfAborted();
  if (["buffered", "transferring", "verifying", "stored", "completed"].includes(created.state)) {
    if (["stored", "completed"].includes(created.state)) await removeDurableUploadRecovery(record.operationId);
    onProgress(1); return created;
  }
  if (!["uploading", "reserved"].includes(created.state)) throw new Error(`Original Drop upload is ${created.state}; it was not replaced.`);
  const chunkBytes = 8 * 1024 * 1024;
  let offset = created.receivedSize;
  let failures = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkBytes));
    try {
      await dropRequest<undefined>(`/uploads/${encodeURIComponent(created.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) },
        body: chunk,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, true, record.channelId);
      offset += chunk.size;
      failures = 0;
    } catch (error) {
      options.signal?.throwIfAborted();
      failures += 1;
      if (failures > 3) throw error;
      const remote = await status();
      if (remote.state !== "uploading" || remote.expectedSize !== file.size || !Number.isSafeInteger(remote.receivedSize) || remote.receivedSize < offset || remote.receivedSize > file.size) throw error;
      offset = remote.receivedSize;
      await uploadRetryDelay(200 * failures, options.signal);
    }
    onProgress(file.size === 0 ? 1 : offset / file.size);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      const completed = await dropRequest<{ readonly upload: DropUploadStatus }>("/complete", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadId: created.id }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, true, record.channelId);
      onProgress(1);
      if (["stored", "completed"].includes(completed.upload.state)) await removeDurableUploadRecovery(record.operationId);
      return completed.upload;
    } catch (error) {
      options.signal?.throwIfAborted();
      const remote = await status().catch(() => undefined);
      options.signal?.throwIfAborted();
      if (remote !== undefined && ["buffered", "transferring", "verifying", "stored", "completed"].includes(remote.state)) {
        if (["stored", "completed"].includes(remote.state)) await removeDurableUploadRecovery(record.operationId);
        onProgress(1); return remote;
      }
      if (attempt === 2 || (error instanceof ApiError && error.status < 500)) throw error;
      await uploadRetryDelay(500 * 2 ** attempt, options.signal);
    }
  }
  throw new Error("Drop upload completion did not return a result.");
}

interface RecoverableOwnerUpload {
  readonly id: string;
  readonly filename: string;
  readonly expectedSize: number;
  readonly lastModified: number;
  readonly parentId: string;
  readonly overwriteResourceId?: string;
  readonly sha256?: string;
  readonly operationId?: string;
}

const OWNER_UPLOAD_RECOVERY_KEY = "saturnOwnerUploadsV1";
const liveOwnerUploads = new Set<string>();
const ownerUploadControllers = new Map<string, AbortController>();
let ownerTransferChannel: BroadcastChannel | undefined;
function ownerUploadChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  if (ownerTransferChannel === undefined) {
    ownerTransferChannel = new BroadcastChannel("saturn-owner-transfer-controls");
    ownerTransferChannel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (typeof value === "object" && value !== null && "action" in value && value.action === "cancel" && "id" in value && typeof value.id === "string") ownerUploadControllers.get(value.id)?.abort();
    });
  }
  return ownerTransferChannel;
}

function recoverableOwnerUploads(): readonly RecoverableOwnerUpload[] {
  try {
    const raw = window.sessionStorage.getItem(OWNER_UPLOAD_RECOVERY_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is RecoverableOwnerUpload => {
      if (typeof value !== "object" || value === null) return false;
      const item = value as Record<string, unknown>;
      return typeof item.id === "string" && typeof item.filename === "string"
        && typeof item.expectedSize === "number" && Number.isSafeInteger(item.expectedSize) && item.expectedSize >= 0
        && typeof item.lastModified === "number" && Number.isSafeInteger(item.lastModified) && item.lastModified >= 0
        && typeof item.parentId === "string"
        && (item.overwriteResourceId === undefined || typeof item.overwriteResourceId === "string");
    });
  } catch { return []; }
}

export function recoverableOwnerUpload(id: string): RecoverableOwnerUpload | undefined {
  if (liveOwnerUploads.has(id)) return undefined;
  try {
    const durable = listUploadRecovery().find(item => item.channel === "owner" && (item.id === id || item.operationId === id));
    if (durable?.channel === "owner") return { ...durable, id: durable.id ?? durable.operationId };
  } catch { return undefined; } // The recovery panel reports corrupt/unavailable metadata.
  return recoverableOwnerUploads().find((item) => item.id === id);
}

export async function forgetRecoverableOwnerUpload(id: string): Promise<void> {
  const resolved = (await listDurableUploadRecovery()).filter(record => record.channel === "owner" && (record.id === id || record.operationId === id)).map(record => record.operationId);
  await removeDurableUploadRecoveries(resolved);
  try {
    const uploads = recoverableOwnerUploads().filter((item) => item.id !== id);
    if (uploads.length === 0) window.sessionStorage.removeItem(OWNER_UPLOAD_RECOVERY_KEY);
    else window.sessionStorage.setItem(OWNER_UPLOAD_RECOVERY_KEY, JSON.stringify(uploads));
  } catch {
    // Nothing else can be cleaned up when session storage is unavailable.
  }
}

async function ownerUploadOffset(id: string, signal?: AbortSignal): Promise<{ readonly offset: number; readonly length: number; readonly status: string }> {
  const response = await fetch(`/api/v1/uploads/${encodeURIComponent(id)}`, { method: "HEAD", credentials: "same-origin", ...(signal === undefined ? {} : { signal }) });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as unknown;
    throw new ApiError(response.status, body);
  }
  const rawOffset = response.headers.get("Upload-Offset"), rawLength = response.headers.get("Upload-Length");
  if (rawOffset === null || rawLength === null || !/^\d+$/.test(rawOffset) || !/^\d+$/.test(rawLength)) throw new Error("Upload recovery metadata is missing or invalid.");
  const offset = Number(rawOffset);
  const length = Number(rawLength);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset > length) throw new Error("Upload recovery metadata is invalid.");
  return { offset, length, status: response.headers.get("Upload-Status") ?? "unknown" };
}

async function continueOwnerUpload(id: string, file: File, onProgress: (progress: number) => void, signal: AbortSignal): Promise<Resource> {
  const status = await ownerUploadOffset(id, signal);
  if (status.length !== file.size) throw new Error("Select the original file with the same size.");
  if (!["created", "uploading", "failed_retryable", "verifying", "committing", "active"].includes(status.status)) throw new Error("This upload can no longer be resumed.");
  if (["verifying", "committing", "active"].includes(status.status) && status.offset !== file.size) throw new Error("Finalizing upload offset is inconsistent.");
  const chunkBytes = 8 * 1024 * 1024;
  let offset = status.offset;
  let failures = 0;
  onProgress(file.size === 0 ? 1 : offset / file.size);
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkBytes));
    try {
      await request<undefined>(`/uploads/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) },
        body: chunk,
        signal,
      });
      offset += chunk.size;
      failures = 0;
    } catch (error) {
      signal.throwIfAborted();
      failures += 1;
      if (failures > 5) throw error;
      const remote = await ownerUploadOffset(id, signal);
      if (!["created", "uploading", "failed_retryable"].includes(remote.status)) {
        if (remote.status === "abandoned") await forgetRecoverableOwnerUpload(id);
        throw error;
      }
      if (remote.length !== file.size || remote.offset < offset || remote.offset > file.size) throw error;
      offset = remote.offset;
      await uploadRetryDelay(Math.min(2_000, 200 * 2 ** (failures - 1)), signal);
    }
    onProgress(file.size === 0 ? 1 : offset / file.size);
  }
  let completed: { readonly resource: Resource } | undefined;
  for (let attempt = 0; attempt < 3 && completed === undefined; attempt += 1) {
    try { completed = await request<{ readonly resource: Resource }>(`/uploads/${encodeURIComponent(id)}/complete`, { method: "POST", signal }); }
    catch (error) {
      signal.throwIfAborted();
      if (attempt === 2 || error instanceof ApiError && error.status < 500) throw error;
      await uploadRetryDelay(500 * 2 ** attempt, signal);
    }
  }
  if (completed === undefined) throw new Error("Upload completion did not return a result.");
  onProgress(1);
  await forgetRecoverableOwnerUpload(id);
  return completed.resource;
}

export async function resumeOwnerUpload(id: string, file: File, onProgress: (progress: number) => void, beforeTransfer?: () => Promise<void>, options: { readonly signal?: AbortSignal } = {}): Promise<Resource> {
  await hydrateUploadRecovery();
  const recovery = recoverableOwnerUpload(id);
  if (recovery === undefined) throw new Error("Upload source is not recoverable in this browser tab.");
  if (file.name !== recovery.filename || file.size !== recovery.expectedSize || file.lastModified !== recovery.lastModified) {
    throw new Error(`Select the original ${recovery.filename} file without modifications.`);
  }
  if (recovery.sha256 === undefined || recovery.operationId === undefined) throw new Error("This older upload has no saved SHA-256 fingerprint. It cannot safely resume from a reselected file.");
  return uploadOwnerSource(file, { channel: "owner", parentId: recovery.parentId, ...(recovery.overwriteResourceId === undefined ? {} : { overwriteResourceId: recovery.overwriteResourceId }) }, onProgress, options, beforeTransfer);
}

export async function uploadFile(file: File, parentId: string, overwriteResourceId: string | undefined, onProgress: (progress: number) => void, options: { readonly signal?: AbortSignal } = {}): Promise<Resource> {
  return uploadOwnerSource(file, { channel: "owner", parentId, ...(overwriteResourceId === undefined ? {} : { overwriteResourceId }) }, onProgress, options);
}

async function uploadOwnerSource(file: File, scope: Extract<UploadRecoveryScope, { channel: "owner" }>, onProgress: (progress: number) => void, options: { readonly signal?: AbortSignal }, beforeTransfer?: () => Promise<void>): Promise<Resource> {
  options.signal?.throwIfAborted();
  return withUploadSourceLock(uploadSourceLock(scope, file.name), async () => {
    const controller = new AbortController();
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
    const record = await prepareUploadRecovery(file, scope, signal);
    // Full source verification precedes unpause and any new bytes.
    await beforeTransfer?.(); signal.throwIfAborted();
    const admission: RequestInit = {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": record.idempotencyKey },
      body: JSON.stringify({ parentId: scope.parentId, filename: record.filename, expectedSize: record.expectedSize, expectedSha256: record.sha256, ...(scope.overwriteResourceId === undefined ? {} : { overwriteResourceId: scope.overwriteResourceId }) }), signal,
    };
    const created = record.id === undefined ? await admitUpload(() => request<{ readonly id: string; readonly receivedSize: number }>("/uploads", admission), signal) : { id: record.id };
    await saveDurableUploadRecovery({ ...record, id: created.id });
    liveOwnerUploads.add(created.id); ownerUploadControllers.set(created.id, controller); ownerUploadChannel();
    try { return await continueOwnerUpload(created.id, file, onProgress, signal); }
    finally { liveOwnerUploads.delete(created.id); ownerUploadControllers.delete(created.id); }
  });
}

export function downloadUrl(resourceId: string, preview = false): string {
  return `/api/v1/files/${encodeURIComponent(resourceId)}/${preview ? "preview" : `content?transferId=${crypto.randomUUID()}`}`;
}
