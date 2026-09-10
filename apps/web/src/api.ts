import type { ArchiveJobInfo, AuditEventInfo, BackupServiceInfo, DeviceInfo, DropSessionInfo, DropUploadStatus, FileVersion, GryphonBot, GryphonChallenge, GryphonStatus, KernelStatus, NeptuneAgentInfo, NeptuneAvailability, NeptuneReleaseCheck, NeptuneStatus, OperatorOverview, OwnerPreferences, RecoveryRestoreCandidate, RecoveryRestoreResult, RecoveryStatus, Resource, ShareChild, ShareInfo, StorageConnectionInput, StorageConnectionStatus, UpdateStatus } from "./types.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, body: unknown) {
    super(`Gateway request failed with status ${String(status)}`);
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

async function request<T>(relativePath: string, options: RequestInit = {}): Promise<T> {
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

async function dropRequest<T>(relativePath: string, options: RequestInit = {}, csrf = true): Promise<T> {
  const headers = new Headers(options.headers);
  const method = options.method?.toUpperCase() ?? "GET";
  const channelId = dropChannelHint();
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
  revokeSessions: () => request<{ readonly revoked: number }>("/auth/sessions", { method: "DELETE" }),
  preferences: () => request<OwnerPreferences>("/auth/preferences"),
  updatePreferences: (input: Omit<OwnerPreferences, "updatedAt">) => request<OwnerPreferences>("/auth/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }),
  overview: () => request<OperatorOverview>("/operator/overview"),
  controlTransferTask: (id: string, action: "pause" | "resume" | "cancel") => request<{ readonly id: string; readonly state: "running" | "paused" | "cancelled" }>(`/operator/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  }),
  updateStatus: () => request<UpdateStatus>("/operator/updates"),
  recoveryStatus: () => request<RecoveryStatus>("/operator/recovery"),
  neptuneStatus: () => request<NeptuneStatus>("/operator/neptune/status"),
  neptuneAvailability: () => request<NeptuneAvailability>("/operator/neptune/availability"),
  initializeNeptune: (enrollmentCode: string) => request<{ readonly id: string; readonly state: string }>("/operator/neptune/initialize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enrollment_code: enrollmentCode }) }),
  updateNeptuneSchedule: (enabled: boolean, intervalHours: number) => request<undefined>("/operator/neptune/schedule", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, interval_hours: intervalHours }) }),
  runNeptune: () => request<Record<string, unknown>>("/operator/neptune/runs", { method: "POST" }),
  updateNeptuneMirrorSchedule: (enabled: boolean, intervalMinutes: number) => request<undefined>("/operator/neptune/mirror/schedule", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, interval_minutes: intervalMinutes }) }),
  runNeptuneMirror: () => request<Record<string, unknown>>("/operator/neptune/mirror/runs", { method: "POST" }),
  checkNeptuneUpdate: () => request<NeptuneReleaseCheck>("/operator/neptune/update/check", { method: "POST" }),
  installNeptuneUpdate: (version: string) => request<{ readonly updated: boolean; readonly version: string }>("/operator/neptune/update/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version }) }),
  neptuneAgents: () => request<readonly NeptuneAgentInfo[]>("/operator/neptune/agents"),
  checkNeptuneAgentUpdate: (serviceId: string) => request<NeptuneReleaseCheck>(`/operator/neptune/agents/${encodeURIComponent(serviceId)}/update/check`, { method: "POST" }),
  updateNeptuneAgentSchedule: (serviceId: string, input: { readonly archiveEnabled: boolean; readonly archiveIntervalHours: number; readonly mirrorEnabled?: boolean; readonly mirrorIntervalMinutes?: number }) => request<NeptuneAgentInfo>(`/operator/neptune/agents/${encodeURIComponent(serviceId)}/schedule`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
  commandNeptuneAgent: (serviceId: string, input: { readonly kind: "archive.run" | "mirror.run" } | { readonly kind: "agent.update"; readonly version: string }) => request<{ readonly id: string; readonly state: string }>(`/operator/neptune/agents/${encodeURIComponent(serviceId)}/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
  gryphonStatus: () => request<GryphonStatus>("/operator/gryphon/status"),
  gryphonBots: () => request<{ readonly bots: readonly GryphonBot[] }>("/operator/gryphon/bots"),
  connectGryphon: (botId: string) => request<GryphonStatus>("/operator/gryphon/connection", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botId }) }),
  disconnectGryphon: () => request<{ readonly disconnected: boolean }>("/operator/gryphon/connection", { method: "DELETE" }),
  issueGryphonLink: () => request<GryphonChallenge>("/operator/gryphon/link-challenge", { method: "POST" }),
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
  testStorage: (input: StorageConnectionInput) => request<Omit<StorageConnectionStatus, "profileId" | "revision" | "activatedAt" | "source">>("/operator/storage/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
  switchStorage: (input: StorageConnectionInput) => request<StorageConnectionStatus>("/operator/storage/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, confirmation: "SWITCH WITHOUT MIGRATION" }) }),
  activity: (before?: number, limit = 100) => request<readonly AuditEventInfo[]>(`/activity?limit=${String(limit)}${before === undefined ? "" : `&before=${String(before)}`}`),
  createDropCode: () => request<{ readonly code: string; readonly expiresAt: string }>("/drop/codes", { method: "POST" }),
  openInternalDropSession: () => request<DropSessionInfo>("/drop/internal/session", { method: "POST" }),
  dropBuffer: () => request<{ readonly capacity?: NonNullable<DropSessionInfo["buffer"]>; readonly sessionTtlMs: number; readonly continuationTtlMs: number; readonly workers: number; readonly intervalMs: number; readonly maximumFileBytes: number }>("/drop/buffer"),
  resource: (id: string) => request<Resource>(`/resources/${encodeURIComponent(id)}`),
  resolveFolder: (rootId: string, segments: readonly string[]) => {
    const query = new URLSearchParams({ rootId, path: segments.join("/") });
    return request<readonly Resource[]>(`/folders/resolve?${query.toString()}`);
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
  revokeShare: (id: string) => request<ShareInfo>(`/shares/${encodeURIComponent(id)}`, { method: "DELETE" }),
  classifyResource: (id: string, classification: NonNullable<Resource["securityClassification"]>) => request<Resource>(`/resources/${encodeURIComponent(id)}/classification`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classification }),
  }),
  devices: () => request<readonly DeviceInfo[]>("/devices?limit=200"),
  createDevice: (input: { readonly name: string; readonly scopeIds: readonly string[]; readonly rights: DeviceInfo["rights"] }) => request<{ readonly token: string; readonly device: DeviceInfo }>("/devices", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }),
  revokeDevice: (id: string) => request<DeviceInfo>(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  backupServices: () => request<readonly BackupServiceInfo[]>("/backup-services?limit=200"),
  createBackupEnrollment: (input: { readonly namespaceSlug: string; readonly deploymentId: string; readonly name: string; readonly requireEncryption: boolean; readonly maxConcurrentRuns: number; readonly mirrorRoot?: "volt" | "mastermind" }) => request<{ readonly code: string; readonly expiresAt: string; readonly service: BackupServiceInfo }>("/backup-services/enrollments", {
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
  preparePackage: (token: string) => publicShareRequest<{ readonly state: string; readonly sizeBytes: number }>(token, "/package", { method: "POST" }),
  contentUrl: (token: string, resourceId?: string) => `/api/v1/public/shares/${encodeURIComponent(token)}/content${resourceId === undefined ? "" : `/${encodeURIComponent(resourceId)}`}`,
  packageUrl: (token: string) => `/api/v1/public/shares/${encodeURIComponent(token)}/package`,
};

export function folderDownloadUrl(id: string): string {
  return `/api/v1/folders/${encodeURIComponent(id)}/archive`;
}

export const dropApi = {
  session: () => dropRequest<DropSessionInfo>("/session"),
  redeem: (code: string) => dropRequest<DropSessionInfo>("/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  }, false),
  status: (id: string) => dropRequest<DropUploadStatus>(`/uploads/${encodeURIComponent(id)}/status`),
  uploads: () => dropRequest<readonly DropUploadStatus[]>("/uploads"),
  subscribeUploads: (onUploads: (uploads: readonly DropUploadStatus[]) => void): (() => void) | undefined => {
    if (typeof EventSource === "undefined") return undefined;
    const channelId = dropChannelHint();
    const query = channelId === undefined ? "" : `?channelId=${encodeURIComponent(channelId)}`;
    const source = new EventSource(`/api/v1/drop/events${query}`, { withCredentials: true });
    source.addEventListener("uploads", (event) => {
      try {
        const value: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (Array.isArray(value)) onUploads(value as readonly DropUploadStatus[]);
      } catch {
        // A malformed event is ignored; EventSource will continue with the next authoritative snapshot.
      }
    });
    return () => source.close();
  },
  cancel: (id: string) => dropRequest<DropUploadStatus>(`/uploads/${encodeURIComponent(id)}`, { method: "DELETE" }),
  logout: () => dropRequest<{ readonly state: string }>("/logout", { method: "POST" }),
};

export async function uploadDropFile(file: File, onProgress: (progress: number) => void): Promise<DropUploadStatus> {
  const created = await dropRequest<DropUploadStatus>("/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `drop-web-${crypto.randomUUID()}` },
    body: JSON.stringify({ filename: file.name, expectedSize: file.size }),
  });
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
      });
      offset += chunk.size;
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures > 3) throw error;
      const status = await dropApi.status(created.id);
      offset = status.receivedSize;
    }
    onProgress(file.size === 0 ? 1 : offset / file.size);
  }
  const completed = await dropRequest<{ readonly upload: DropUploadStatus }>("/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId: created.id }),
  });
  onProgress(1);
  return completed.upload;
}

interface RecoverableOwnerUpload {
  readonly id: string;
  readonly filename: string;
  readonly expectedSize: number;
  readonly lastModified: number;
  readonly parentId: string;
  readonly overwriteResourceId?: string;
}

const OWNER_UPLOAD_RECOVERY_KEY = "saturnOwnerUploadsV1";
const liveOwnerUploads = new Set<string>();

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

function storeRecoverableOwnerUpload(value: RecoverableOwnerUpload): void {
  try {
    const uploads = recoverableOwnerUploads().filter((item) => item.id !== value.id);
    window.sessionStorage.setItem(OWNER_UPLOAD_RECOVERY_KEY, JSON.stringify([...uploads, value]));
  } catch {
    // The resumable protocol still works in the current page when session storage is unavailable.
  }
}

export function recoverableOwnerUpload(id: string): RecoverableOwnerUpload | undefined {
  if (liveOwnerUploads.has(id)) return undefined;
  return recoverableOwnerUploads().find((item) => item.id === id);
}

export function forgetRecoverableOwnerUpload(id: string): void {
  try {
    const uploads = recoverableOwnerUploads().filter((item) => item.id !== id);
    if (uploads.length === 0) window.sessionStorage.removeItem(OWNER_UPLOAD_RECOVERY_KEY);
    else window.sessionStorage.setItem(OWNER_UPLOAD_RECOVERY_KEY, JSON.stringify(uploads));
  } catch {
    // Nothing else can be cleaned up when session storage is unavailable.
  }
}

async function ownerUploadOffset(id: string): Promise<{ readonly offset: number; readonly length: number; readonly status: string }> {
  const response = await fetch(`/api/v1/uploads/${encodeURIComponent(id)}`, { method: "HEAD", credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as unknown;
    throw new ApiError(response.status, body);
  }
  const offset = Number(response.headers.get("Upload-Offset"));
  const length = Number(response.headers.get("Upload-Length"));
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset > length) throw new Error("Upload recovery metadata is invalid.");
  return { offset, length, status: response.headers.get("Upload-Status") ?? "unknown" };
}

async function continueOwnerUpload(id: string, file: File, onProgress: (progress: number) => void): Promise<Resource> {
  const status = await ownerUploadOffset(id);
  if (status.length !== file.size) throw new Error("Select the original file with the same size.");
  if (!["created", "uploading", "failed_retryable"].includes(status.status)) throw new Error("This upload can no longer be resumed.");
  const chunkBytes = 8 * 1024 * 1024;
  let offset = status.offset;
  onProgress(file.size === 0 ? 1 : offset / file.size);
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkBytes));
    await request<undefined>(`/uploads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) },
      body: chunk,
    });
    offset += chunk.size;
    onProgress(file.size === 0 ? 1 : offset / file.size);
  }
  const completed = await request<{ readonly resource: Resource }>(`/uploads/${encodeURIComponent(id)}/complete`, { method: "POST" });
  onProgress(1);
  forgetRecoverableOwnerUpload(id);
  return completed.resource;
}

export async function resumeOwnerUpload(id: string, file: File, onProgress: (progress: number) => void): Promise<Resource> {
  const recovery = recoverableOwnerUpload(id);
  if (recovery === undefined) throw new Error("Upload source is not recoverable in this browser tab.");
  if (file.name !== recovery.filename || file.size !== recovery.expectedSize || file.lastModified !== recovery.lastModified) {
    throw new Error(`Select the original ${recovery.filename} file without modifications.`);
  }
  liveOwnerUploads.add(id);
  try { return await continueOwnerUpload(id, file, onProgress); }
  finally { liveOwnerUploads.delete(id); }
}

export async function uploadFile(file: File, parentId: string, overwriteResourceId: string | undefined, onProgress: (progress: number) => void): Promise<Resource> {
  const created = await request<{ readonly id: string; readonly receivedSize: number }>("/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `web-upload-${crypto.randomUUID()}` },
    body: JSON.stringify({
      parentId,
      filename: file.name,
      expectedSize: file.size,
      ...(overwriteResourceId === undefined ? {} : { overwriteResourceId }),
    }),
  });
  storeRecoverableOwnerUpload({ id: created.id, filename: file.name, expectedSize: file.size, lastModified: file.lastModified, parentId, ...(overwriteResourceId === undefined ? {} : { overwriteResourceId }) });
  liveOwnerUploads.add(created.id);
  try { return await continueOwnerUpload(created.id, file, onProgress); }
  finally { liveOwnerUploads.delete(created.id); }
}

export function downloadUrl(resourceId: string, preview = false): string {
  return `/api/v1/files/${encodeURIComponent(resourceId)}/${preview ? "preview" : "content"}`;
}
