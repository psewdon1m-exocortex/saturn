import path from "node:path";

export function normalizeStorageName(input: string): string {
  const value = input.normalize("NFC").trim();
  if (!value || value === "." || value === "..") throw new Error("Storage name is empty or reserved");
  if (/[\\/]/.test(value)) throw new Error("Storage name must not contain a path separator");
  if (value.length > 255) throw new Error("Storage name exceeds 255 characters");
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127) {
      throw new Error("Storage name contains a control character");
    }
  }
  return value;
}

export function normalizeStoragePath(input: string, allowEmpty = true): string {
  const candidate = input.normalize("NFC").replaceAll("\\", "/");
  if (candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate) || candidate.includes("\0")) {
    throw new Error("Storage path must be relative");
  }
  const segments = candidate.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw new Error("Storage path traversal is forbidden");
  const normalized = segments.map(normalizeStorageName).join("/");
  if (!allowEmpty && !normalized) throw new Error("Storage path must not be empty");
  if (normalized.length > 4_096) throw new Error("Storage path exceeds 4096 characters");
  return normalized;
}

export function joinStoragePath(...parts: readonly string[]): string {
  return normalizeStoragePath(parts.filter(Boolean).join("/"));
}

export function storageBasename(storagePath: string): string {
  const normalized = normalizeStoragePath(storagePath, false);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function resolveLocalPath(root: string, storagePath: string): string {
  const resolvedRoot = path.resolve(root);
  const normalized = normalizeStoragePath(storagePath);
  const resolved = path.resolve(resolvedRoot, ...normalized.split("/").filter(Boolean));
  const prefix = `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) throw new Error("Resolved path escaped storage root");
  return resolved;
}
