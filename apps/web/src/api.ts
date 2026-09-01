import type { AuditEvent, BackupServiceInfo, DeviceInfo, DropSessionInfo, DropUploadStatus, FileVersion, LaboratoryAssetInfo, LaboratoryClientInfo, OwnerPreferences, Resource, ShareChild, ShareInfo, TelegramStatus } from "./types.js";

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
  revokeSessions: () => request<{ readonly revoked: number }>("/auth/sessions", { method: "DELETE" }),
  preferences: () => request<OwnerPreferences>("/auth/preferences"),
  updatePreferences: (input: Omit<OwnerPreferences, "updatedAt">) => request<OwnerPreferences>("/auth/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }),
  telegramStatus: () => request<TelegramStatus>("/telegram/status"),
  createTelegramLinkChallenge: () => request<{ readonly code: string; readonly expiresAt: string }>("/telegram/link-challenges", { method: "POST" }),
  unlinkTelegram: () => request<{ readonly sessions: number; readonly challenges: number }>("/telegram/binding", { method: "DELETE" }),
  resource: (id: string) => request<Resource>(`/resources/${encodeURIComponent(id)}`),
  children: async (id: string) => {
    const children: Resource[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await request<readonly Resource[]>(`/folders/${encodeURIComponent(id)}/children?offset=${String(offset)}&limit=500`);
      children.push(...page);
      if (page.length < 500) return children;
    }
  },
  trash: () => request<readonly Resource[]>("/trash?limit=500"),
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
  versions: (id: string) => request<readonly FileVersion[]>(`/files/${encodeURIComponent(id)}/versions?limit=100`),
  restoreVersion: (id: string, versionId: string) => request<Resource>(`/files/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`, {
    method: "POST",
    headers: { "Idempotency-Key": `web-version-restore-${crypto.randomUUID()}` },
  }),
  activity: () => request<readonly AuditEvent[]>("/activity?limit=200"),
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
  createBackupService: (input: { readonly slug: string; readonly name: string }) => request<{ readonly token: string; readonly service: BackupServiceInfo }>("/backup-services", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }),
  rotateBackupService: (id: string) => request<{ readonly token: string; readonly service: BackupServiceInfo }>(`/backup-services/${encodeURIComponent(id)}/rotate-token`, { method: "POST" }),
  revokeBackupService: (id: string) => request<BackupServiceInfo>(`/backup-services/${encodeURIComponent(id)}`, { method: "DELETE" }),
  laboratoryClients: () => request<readonly LaboratoryClientInfo[]>("/laboratory/clients?limit=200"),
  createLaboratoryClient: (name: string) => request<{ readonly client: LaboratoryClientInfo; readonly token: string }>("/laboratory/clients", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }),
  rotateLaboratoryClient: (id: string) => request<{ readonly client: LaboratoryClientInfo; readonly token: string }>(`/laboratory/clients/${encodeURIComponent(id)}/rotate-token`, { method: "POST" }),
  revokeLaboratoryClient: (id: string) => request<LaboratoryClientInfo>(`/laboratory/clients/${encodeURIComponent(id)}`, { method: "DELETE" }),
  laboratoryAssets: () => request<readonly LaboratoryAssetInfo[]>("/laboratory/assets?limit=200"),
  createLaboratoryAsset: (input: { readonly resourceId: string; readonly mode: LaboratoryAssetInfo["mode"]; readonly label?: string; readonly disposition?: LaboratoryAssetInfo["disposition"] }) => request<LaboratoryAssetInfo>("/laboratory/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
  updateLaboratoryAsset: (id: string, input: { readonly mode?: LaboratoryAssetInfo["mode"]; readonly label?: string; readonly disposition?: LaboratoryAssetInfo["disposition"] }) => request<LaboratoryAssetInfo>(`/laboratory/assets/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
  disableLaboratoryAsset: (id: string) => request<LaboratoryAssetInfo>(`/laboratory/assets/${encodeURIComponent(id)}`, { method: "DELETE" }),
  laboratoryFragment: (id: string) => request<{ readonly url: string; readonly fragment: string; readonly format: string }>(`/laboratory/assets/${encodeURIComponent(id)}/fragment`),
};

export const publicShareApi = {
  metadata: (token: string) => publicShareRequest<ShareInfo>(token),
  unlock: (token: string, password: string) => publicShareRequest<ShareInfo>(token, "/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }),
  children: (token: string, parentId?: string) => publicShareRequest<readonly ShareChild[]>(token, `/children${parentId === undefined ? "" : `?parentId=${encodeURIComponent(parentId)}`}`),
  preparePackage: (token: string) => publicShareRequest<{ readonly state: string }>(token, "/package", { method: "POST" }),
  contentUrl: (token: string) => `/api/v1/public/shares/${encodeURIComponent(token)}/content`,
  packageUrl: (token: string) => `/api/v1/public/shares/${encodeURIComponent(token)}/package`,
};

export const dropApi = {
  session: () => dropRequest<DropSessionInfo>("/session"),
  redeem: (code: string) => dropRequest<DropSessionInfo>("/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  }, false),
  status: (id: string) => dropRequest<DropUploadStatus>(`/uploads/${encodeURIComponent(id)}/status`),
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
  const chunkBytes = 8 * 1024 * 1024;
  let offset = created.receivedSize;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkBytes));
    await request<undefined>(`/uploads/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) },
      body: chunk,
    });
    offset += chunk.size;
    onProgress(file.size === 0 ? 1 : offset / file.size);
  }
  const completed = await request<{ readonly resource: Resource }>(`/uploads/${encodeURIComponent(created.id)}/complete`, { method: "POST" });
  onProgress(1);
  return completed.resource;
}

export function downloadUrl(resourceId: string, preview = false): string {
  return `/api/v1/files/${encodeURIComponent(resourceId)}/${preview ? "preview" : "content"}`;
}
