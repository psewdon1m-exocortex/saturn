import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { recoveryEnvironmentKeys } from "./recovery-keys.js";

const booleanText = z.enum(["true", "false"]).transform((value) => value === "true");
const commandArguments = z.string().default("[]").transform((value, context): readonly string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("expected an array");
    const result: string[] = [];
    for (const item of parsed as unknown[]) {
      if (typeof item !== "string" || item.length === 0 || containsControlCharacter(item)) {
        throw new Error("expected a JSON array of non-empty strings");
      }
      result.push(item);
    }
    return result;
  } catch {
    context.addIssue({ code: "custom", message: "must be a JSON array of non-empty command arguments" });
    return z.NEVER;
  }
});
const placeholder = /change[-_ ]?me|replace|example|vault-dev-only/i;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) return true;
  }
  return false;
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PUBLIC_ORIGIN: z.url().default("http://localhost:5173"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_TRUSTED_PROXIES: z.string().default("").transform((value, context) => {
    const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (entries.some((entry) => {
      const [host, prefix, extra] = entry.split("/");
      const version = isIP(host ?? "");
      return !version || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)));
    })) context.addIssue({ code: "custom", message: "must contain explicit proxy IP addresses or CIDRs" });
    return entries;
  }),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  WORKER_HOST: z.string().min(1).default("127.0.0.1"),
  WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
  DATABASE_URL: z.string().min(1),
  DATABASE_PASSWORD_FILE: z.string().default(""),
  OWNER_BOOTSTRAP_TOKEN_FILE: z.string().min(1),
  KERNEL_URL: z.string().default(""),
  KERNEL_TOKEN_FILE: z.string().default(""),
  KERNEL_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(3_000),
  STORAGE_HOST: z.string().min(1),
  STORAGE_PORT: z.coerce.number().int().min(1).max(65_535).default(22),
  STORAGE_USER: z.string().min(1),
  STORAGE_ROOT: z.string().min(1).default("."),
  STORAGE_HOST_FINGERPRINT: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/),
  STORAGE_AUTH_MODE: z.enum(["password_file", "private_key_file"]),
  STORAGE_PASSWORD_FILE: z.string().default(""),
  STORAGE_PRIVATE_KEY_FILE: z.string().default(""),
  STORAGE_RUNTIME_CONFIG_DIR: z.string().min(1).default("data/storage-runtime"),
  STORAGE_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(60_000),
  STORAGE_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(500).max(5_000).default(3_000),
  STORAGE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(8).default(8),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(20 * 1024 * 1024 * 1024),
  UPLOAD_CHUNK_MAX_BYTES: z.coerce.number().int().min(64 * 1024).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  UPLOAD_INCOMPLETE_TTL_MS: z.coerce.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1_000).default(24 * 60 * 60 * 1_000),
  TRASH_RETENTION_MS: z.coerce.number().int().min(24 * 60 * 60 * 1_000).max(365 * 24 * 60 * 60 * 1_000).default(30 * 24 * 60 * 60 * 1_000),
  PURGE_ENABLED: booleanText.default(true),
  READINESS_REQUIRE_STORAGE: booleanText.default(true),
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(500).max(4_500).default(3_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  WORKER_STALE_AFTER_MS: z.coerce.number().int().min(2_000).max(300_000).default(20_000),
  RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1_000).default(6 * 60 * 60 * 1_000),
  RECOVERY_SPOOL_DIR: z.string().min(1).default("spool/recovery"),
  RECOVERY_ARCHIVE_DIR: z.string().min(1).default("data/recovery"),
  RECOVERY_MAX_ARCHIVE_BYTES: z.coerce.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER).default(10 * 1024 * 1024 * 1024),
  RECOVERY_MAX_MEMBER_BYTES: z.coerce.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER).default(8 * 1024 * 1024 * 1024),
  RECOVERY_MAX_EXTRACTED_BYTES: z.coerce.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER).default(12 * 1024 * 1024 * 1024),
  RECOVERY_MAX_ENTRIES: z.coerce.number().int().min(16).max(10_000).default(512),
  RECOVERY_MAX_COMPRESSION_RATIO: z.coerce.number().min(1).max(1_000).default(200),
  RECOVERY_MAX_MANIFEST_BYTES: z.coerce.number().int().min(4_096).max(16 * 1024 * 1024).default(1024 * 1024),
  RECOVERY_BACKUP_INTERVAL_MS: z.coerce.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1_000).default(6 * 60 * 60 * 1_000),
  ARCHIVE_SPOOL_DIR: z.string().min(1).default("spool/archives"),
  ARCHIVE_7Z_BIN: z.string().min(1).default(process.platform === "win32" ? "7z" : "7zz"),
  ARCHIVE_MAX_ARCHIVE_BYTES: z.coerce.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER).default(20 * 1024 * 1024 * 1024),
  ARCHIVE_MAX_MEMBER_BYTES: z.coerce.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER).default(20 * 1024 * 1024 * 1024),
  ARCHIVE_MAX_EXTRACTED_BYTES: z.coerce.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER).default(100 * 1024 * 1024 * 1024),
  ARCHIVE_MAX_ENTRIES: z.coerce.number().int().min(1).max(100_000).default(10_000),
  ARCHIVE_MAX_COMPRESSION_RATIO: z.coerce.number().min(1).max(1_000).default(200),
  ARCHIVE_JOB_LEASE_MS: z.coerce.number().int().min(30_000).max(60 * 60 * 1_000).default(5 * 60 * 1_000),
  PG_DUMP_BIN: z.string().min(1).default("pg_dump"),
  PG_RESTORE_BIN: z.string().min(1).default("pg_restore"),
  PG_DUMP_PREFIX_ARGS: commandArguments,
  PG_RESTORE_PREFIX_ARGS: commandArguments,
  PG_COMMAND_CONNECTION_ARGS: commandArguments,
  AUTH_PEPPER_FILE: z.string().min(1),
  AUTH_SESSION_IDLE_TTL_MS: z.coerce.number().int().min(60_000).max(24 * 60 * 60 * 1_000).default(15 * 60 * 1_000),
  AUTH_SESSION_ABSOLUTE_TTL_MS: z.coerce.number().int().min(5 * 60 * 1_000).max(7 * 24 * 60 * 60 * 1_000).default(12 * 60 * 60 * 1_000),
  AUTH_REAUTH_TTL_MS: z.coerce.number().int().min(60_000).max(60 * 60 * 1_000).default(5 * 60 * 1_000),
  AUTH_FAILURE_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
  AUTH_FAILURE_WINDOW_MS: z.coerce.number().int().min(60_000).max(24 * 60 * 60 * 1_000).default(15 * 60 * 1_000),
  DROP_PEPPER_FILE: z.string().min(1),
  DROP_CODE_TTL_MS: z.coerce.number().int().min(60_000).max(60 * 60 * 1_000).default(30 * 60 * 1_000),
  DROP_SESSION_TTL_MS: z.coerce.number().int().min(60_000).max(24 * 60 * 60 * 1_000).default(30 * 60 * 1_000),
  DROP_MAX_FILES: z.coerce.number().int().min(1).max(10_000).default(1_000),
  DROP_MAX_BYTES: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(100 * 1024 * 1024 * 1024),
  DROP_BUFFER_DIRECTORY: z.string().min(1).default("data/drop-buffer"),
  DROP_BUFFER_MAX_BYTES: z.coerce.number().int().min(1024 * 1024).max(Number.MAX_SAFE_INTEGER).default(110 * 1024 * 1024 * 1024),
  DROP_BUFFER_MIN_FREE_BYTES: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(10 * 1024 * 1024 * 1024),
  DROP_BUFFER_WARNING_RATIO: z.coerce.number().min(0.1).max(0.95).default(0.7),
  DROP_BUFFER_CRITICAL_RATIO: z.coerce.number().min(0.2).max(0.98).default(0.85),
  DROP_BUFFER_REFUSAL_RATIO: z.coerce.number().min(0.3).max(0.99).default(0.92),
  DROP_DRAIN_WORKERS: z.coerce.number().int().min(1).max(4).default(2),
  DROP_DRAIN_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  DROP_CONTINUATION_TTL_MS: z.coerce.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1_000).default(24 * 60 * 60 * 1_000),
  DROP_FAILURE_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
  DROP_GLOBAL_FAILURE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(100),
  DROP_FAILURE_WINDOW_MS: z.coerce.number().int().min(60_000).max(24 * 60 * 60 * 1_000).default(15 * 60 * 1_000),
  GRYPHON_ENABLED: booleanText.default(false),
  GRYPHON_SERVICE_TOKEN_FILE: z.string().default(""),
  GRYPHON_SOCKET_PATH: z.string().min(1).default("/run/gryphon/client.sock"),
  GRYPHON_ADAPTER_URL: z.url().default("http://saturn:3000/internal/gryphon/command"),
  GRYPHON_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  SHARE_PEPPER_FILE: z.string().min(1),
  SHARE_ENABLED: booleanText.default(true),
  SHARE_DEFAULT_EXPIRY_MS: z.coerce.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1_000).default(7 * 24 * 60 * 60 * 1_000),
  SHARE_MAX_EXPIRY_MS: z.coerce.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1_000).default(365 * 24 * 60 * 60 * 1_000),
  SHARE_SESSION_TTL_MS: z.coerce.number().int().min(60_000).max(24 * 60 * 60 * 1_000).default(30 * 60 * 1_000),
  SHARE_PASSWORD_FAILURE_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
  SHARE_PASSWORD_FAILURE_WINDOW_MS: z.coerce.number().int().min(60_000).max(24 * 60 * 60 * 1_000).default(15 * 60 * 1_000),
  SHARE_PACKAGE_MAX_FILES: z.coerce.number().int().min(1).max(100_000).default(5_000),
  SHARE_PACKAGE_MAX_BYTES: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(5 * 1024 * 1024 * 1024),
  SHARE_PACKAGE_MAX_DURATION_MS: z.coerce.number().int().min(10_000).max(60 * 60 * 1_000).default(10 * 60 * 1_000),
  SHARE_STREAM_REVALIDATE_BYTES: z.coerce.number().int().min(64 * 1024).max(64 * 1024 * 1024).default(1024 * 1024),
  DEVICE_PEPPER_FILE: z.string().min(1),
  WEBDAV_ENABLED: booleanText.default(true),
  WEBDAV_PROPFIND_MAX_ITEMS: z.coerce.number().int().min(1).max(5_000).default(1_000),
  DEVICE_DELETE_MAX_ITEMS: z.coerce.number().int().min(1).max(100_000).default(1_000),
  DEVICE_DELETE_WINDOW_MS: z.coerce.number().int().min(60_000).max(24 * 60 * 60 * 1_000).default(15 * 60 * 1_000),
  BACKUP_PEPPER_FILE: z.string().min(1),
  BACKUP_INGEST_ENABLED: booleanText.default(true),
  BACKUP_TRUST_CLIENT_CERT_HEADER: booleanText.default(false),
  BACKUP_TOKEN_ROTATION_GRACE_MS: z.coerce.number().int().min(0).max(7 * 24 * 60 * 60 * 1_000).default(60 * 60 * 1_000),
  BACKUP_REQUIRE_ENCRYPTION: booleanText.default(true),
  BACKUP_MAX_RUN_BYTES: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(20 * 1024 * 1024 * 1024),
  BACKUP_DAILY_QUOTA_BYTES: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(40 * 1024 * 1024 * 1024),
  BACKUP_STORED_QUOTA_BYTES: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(500 * 1024 * 1024 * 1024),
  BACKUP_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(32).default(1),
  BACKUP_FRESHNESS_SLA_MS: z.coerce.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1_000).default(24 * 60 * 60 * 1_000),
  BACKUP_RETENTION_DAILY: z.coerce.number().int().min(0).max(366).default(7),
  BACKUP_RETENTION_WEEKLY: z.coerce.number().int().min(0).max(260).default(4),
  BACKUP_RETENTION_MONTHLY: z.coerce.number().int().min(0).max(1_200).default(12),
  BACKUP_RETENTION_YEARLY: z.coerce.number().int().min(0).max(100).default(3),
  LABORATORY_ENABLED: booleanText.default(true),
  LABORATORY_PUBLIC_ENABLED: booleanText.default(false),
  LABORATORY_PEPPER_FILE: z.string().min(1).default(".secrets/laboratory-pepper"),
  LABORATORY_TOKEN_ROTATION_GRACE_MS: z.coerce.number().int().min(0).max(7 * 24 * 60 * 60 * 1_000).default(60 * 60 * 1_000),
  LABORATORY_MAX_CONCURRENT_PUBLIC_STREAMS: z.coerce.number().int().min(1).max(10_000).default(16),
}).superRefine((value, context) => {
  const rootSegments = value.STORAGE_ROOT.replaceAll("\\", "/").split("/");
  if (value.STORAGE_ROOT.startsWith("/") || rootSegments.includes("..") || containsControlCharacter(value.STORAGE_ROOT)) {
    context.addIssue({
      code: "custom",
      path: ["STORAGE_ROOT"],
      message: "Storage root must be a safe relative path",
    });
  }
  if (value.STORAGE_AUTH_MODE === "password_file" && !value.STORAGE_PASSWORD_FILE) {
    context.addIssue({
      code: "custom",
      path: ["STORAGE_PASSWORD_FILE"],
      message: "Password-file authentication requires STORAGE_PASSWORD_FILE",
    });
  }
  if (value.STORAGE_AUTH_MODE === "private_key_file" && !value.STORAGE_PRIVATE_KEY_FILE) {
    context.addIssue({
      code: "custom",
      path: ["STORAGE_PRIVATE_KEY_FILE"],
      message: "Private-key authentication requires STORAGE_PRIVATE_KEY_FILE",
    });
  }
  if (value.WORKER_STALE_AFTER_MS <= value.WORKER_HEARTBEAT_INTERVAL_MS * 2) {
    context.addIssue({
      code: "custom",
      path: ["WORKER_STALE_AFTER_MS"],
      message: "Worker stale threshold must exceed two heartbeat intervals",
    });
  }
  if (value.STORAGE_HEALTH_TIMEOUT_MS > value.STORAGE_OPERATION_TIMEOUT_MS) {
    context.addIssue({
      code: "custom",
      path: ["STORAGE_HEALTH_TIMEOUT_MS"],
      message: "Storage health timeout cannot exceed the storage operation timeout",
    });
  }
  if (value.STORAGE_HEALTH_TIMEOUT_MS > value.READINESS_TIMEOUT_MS) {
    context.addIssue({
      code: "custom",
      path: ["STORAGE_HEALTH_TIMEOUT_MS"],
      message: "Storage health timeout cannot exceed the readiness timeout",
    });
  }
  if (value.RECOVERY_MAX_MEMBER_BYTES > value.RECOVERY_MAX_EXTRACTED_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["RECOVERY_MAX_MEMBER_BYTES"],
      message: "Recovery member limit cannot exceed the total extracted limit",
    });
  }
  if (value.ARCHIVE_MAX_MEMBER_BYTES > value.ARCHIVE_MAX_EXTRACTED_BYTES) {
    context.addIssue({ code: "custom", path: ["ARCHIVE_MAX_MEMBER_BYTES"], message: "Archive member limit cannot exceed the total extracted limit" });
  }
  if (value.AUTH_SESSION_IDLE_TTL_MS >= value.AUTH_SESSION_ABSOLUTE_TTL_MS) {
    context.addIssue({
      code: "custom",
      path: ["AUTH_SESSION_IDLE_TTL_MS"],
      message: "Session idle TTL must be shorter than the absolute TTL",
    });
  }
  if (value.DROP_GLOBAL_FAILURE_LIMIT < value.DROP_FAILURE_LIMIT) {
    context.addIssue({
      code: "custom",
      path: ["DROP_GLOBAL_FAILURE_LIMIT"],
      message: "Global Drop failure limit cannot be below the per-source limit",
    });
  }
  if (value.DROP_MAX_BYTES > value.UPLOAD_MAX_BYTES * value.DROP_MAX_FILES) {
    context.addIssue({
      code: "custom",
      path: ["DROP_MAX_BYTES"],
      message: "Drop batch limit cannot exceed the aggregate per-file upload bound",
    });
  }
  if (!(value.DROP_BUFFER_WARNING_RATIO < value.DROP_BUFFER_CRITICAL_RATIO && value.DROP_BUFFER_CRITICAL_RATIO < value.DROP_BUFFER_REFUSAL_RATIO)) {
    context.addIssue({ code: "custom", path: ["DROP_BUFFER_WARNING_RATIO"], message: "Drop buffer watermarks must increase from warning to critical to refusal" });
  }
  if (value.DROP_MAX_BYTES > value.DROP_BUFFER_MAX_BYTES) {
    context.addIssue({ code: "custom", path: ["DROP_MAX_BYTES"], message: "One Drop channel cannot reserve more than the local buffer budget" });
  }
  if (value.GRYPHON_ENABLED && !value.GRYPHON_SERVICE_TOKEN_FILE) {
    context.addIssue({ code: "custom", path: ["GRYPHON_ENABLED"], message: "Enabled Gryphon integration requires a service-token file" });
  }
  if (value.SHARE_DEFAULT_EXPIRY_MS > value.SHARE_MAX_EXPIRY_MS) {
    context.addIssue({ code: "custom", path: ["SHARE_DEFAULT_EXPIRY_MS"], message: "Default share expiry cannot exceed its maximum" });
  }
  if (value.BACKUP_MAX_RUN_BYTES > value.UPLOAD_MAX_BYTES) {
    context.addIssue({ code: "custom", path: ["BACKUP_MAX_RUN_BYTES"], message: "Backup run limit cannot exceed the global upload limit" });
  }
  if (value.BACKUP_DAILY_QUOTA_BYTES < value.BACKUP_MAX_RUN_BYTES || value.BACKUP_STORED_QUOTA_BYTES < value.BACKUP_MAX_RUN_BYTES) {
    context.addIssue({ code: "custom", path: ["BACKUP_MAX_RUN_BYTES"], message: "Backup quotas cannot be below the per-run limit" });
  }
  if (value.NODE_ENV === "production") {
    const publicUrl = new URL(value.PUBLIC_ORIGIN);
    if (publicUrl.protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["PUBLIC_ORIGIN"], message: "Production origin must use HTTPS" });
    }
    if (value.STORAGE_AUTH_MODE !== "private_key_file") {
      context.addIssue({
        code: "custom",
        path: ["STORAGE_AUTH_MODE"],
        message: "Production Storage Box access requires a private key file",
      });
    }
    const databaseUrl = new URL(value.DATABASE_URL);
    if (!value.DATABASE_PASSWORD_FILE) {
      context.addIssue({ code: "custom", path: ["DATABASE_PASSWORD_FILE"], message: "Production database access requires a password file" });
    }
    if (databaseUrl.password) {
      context.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "Production database URL must not contain a password" });
    }
    for (const [field, candidate] of [
      ["PUBLIC_ORIGIN", value.PUBLIC_ORIGIN],
      ["DATABASE_URL", value.DATABASE_URL],
      ["DATABASE_PASSWORD_FILE", value.DATABASE_PASSWORD_FILE],
      ["OWNER_BOOTSTRAP_TOKEN_FILE", value.OWNER_BOOTSTRAP_TOKEN_FILE],
      ...(value.KERNEL_URL === "" ? [] : [["KERNEL_URL", value.KERNEL_URL]] as const),
      ...(value.KERNEL_TOKEN_FILE === "" ? [] : [["KERNEL_TOKEN_FILE", value.KERNEL_TOKEN_FILE]] as const),
      ["AUTH_PEPPER_FILE", value.AUTH_PEPPER_FILE],
      ["DROP_PEPPER_FILE", value.DROP_PEPPER_FILE],
      ["SHARE_PEPPER_FILE", value.SHARE_PEPPER_FILE],
      ["DEVICE_PEPPER_FILE", value.DEVICE_PEPPER_FILE],
      ["BACKUP_PEPPER_FILE", value.BACKUP_PEPPER_FILE],
      ["LABORATORY_PEPPER_FILE", value.LABORATORY_PEPPER_FILE],
      ["STORAGE_HOST_FINGERPRINT", value.STORAGE_HOST_FINGERPRINT],
      ["STORAGE_PRIVATE_KEY_FILE", value.STORAGE_PRIVATE_KEY_FILE],
      ...(value.GRYPHON_ENABLED ? [["GRYPHON_SERVICE_TOKEN_FILE", value.GRYPHON_SERVICE_TOKEN_FILE]] as const : []),
    ] as const) {
      if (placeholder.test(candidate)) {
        context.addIssue({ code: "custom", path: [field], message: "Production value contains a placeholder" });
      }
    }
    if (value.KERNEL_URL !== "" && new URL(value.KERNEL_URL).protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["KERNEL_URL"], message: "Production Kernel URL must use HTTPS" });
    }
  }
});

export interface SaturnConfig {
  readonly environment: "development" | "test" | "production";
  readonly publicOrigin: string;
  readonly api: { readonly host: string; readonly port: number };
  readonly trustedProxies: readonly string[];
  readonly worker: {
    readonly host: string;
    readonly port: number;
    readonly heartbeatIntervalMs: number;
    readonly staleAfterMs: number;
    readonly reconciliationIntervalMs: number;
  };
  readonly databaseUrl: string;
  readonly databasePasswordFile?: string;
  readonly ownerBootstrapTokenFile: string;
  readonly kernel: {
    readonly urlSeed?: string;
    readonly tokenFile?: string;
    readonly timeoutMs: number;
  };
  readonly auth: {
    readonly pepperFile: string;
    readonly sessionIdleTtlMs: number;
    readonly sessionAbsoluteTtlMs: number;
    readonly reauthTtlMs: number;
    readonly failureLimit: number;
    readonly failureWindowMs: number;
  };
  readonly drop: {
    readonly pepperFile: string;
    readonly codeTtlMs: number;
    readonly sessionTtlMs: number;
    readonly maxFiles: number;
    readonly maxBytes: number;
    readonly bufferDirectory: string;
    readonly bufferMaxBytes: number;
    readonly bufferMinFreeBytes: number;
    readonly bufferWarningRatio: number;
    readonly bufferCriticalRatio: number;
    readonly bufferRefusalRatio: number;
    readonly drainWorkers: number;
    readonly drainIntervalMs: number;
    readonly continuationTtlMs: number;
    readonly failureLimit: number;
    readonly globalFailureLimit: number;
    readonly failureWindowMs: number;
  };
  readonly gryphon: {
    readonly enabled: boolean;
    readonly serviceTokenFile?: string;
    readonly socketPath: string;
    readonly adapterUrl: string;
    readonly timeoutMs: number;
  };
  readonly share: {
    readonly enabled: boolean;
    readonly pepperFile: string;
    readonly defaultExpiryMs: number;
    readonly maxExpiryMs: number;
    readonly sessionTtlMs: number;
    readonly passwordFailureLimit: number;
    readonly passwordFailureWindowMs: number;
    readonly packageMaxFiles: number;
    readonly packageMaxBytes: number;
    readonly packageMaxDurationMs: number;
    readonly streamRevalidateBytes: number;
  };
  readonly device: {
    readonly enabled: boolean;
    readonly pepperFile: string;
    readonly propfindMaxItems: number;
    readonly deleteMaxItems: number;
    readonly deleteWindowMs: number;
  };
  readonly backupIngest: {
    readonly enabled: boolean;
    readonly pepperFile: string;
    readonly trustClientCertificateHeader: boolean;
    readonly tokenRotationGraceMs: number;
    readonly requireEncryption: boolean;
    readonly maxRunBytes: number;
    readonly dailyQuotaBytes: number;
    readonly storedQuotaBytes: number;
    readonly maxConcurrentRuns: number;
    readonly freshnessSlaMs: number;
    readonly retention: { readonly daily: number; readonly weekly: number; readonly monthly: number; readonly yearly: number };
  };
  readonly laboratory: {
    readonly enabled: boolean;
    readonly publicEnabled: boolean;
    readonly pepperFile: string;
    readonly tokenRotationGraceMs: number;
    readonly maxConcurrentPublicStreams: number;
  };
  readonly storage: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly root: string;
    readonly hostFingerprint: string;
    readonly authMode: "password_file" | "private_key_file";
    readonly passwordFile?: string;
    readonly privateKeyFile?: string;
    readonly operationTimeoutMs: number;
    readonly healthTimeoutMs: number;
    readonly maxConnections: number;
  };
  readonly storageRuntimeConfigDirectory: string;
  readonly readinessRequireStorage: boolean;
  readonly readinessTimeoutMs: number;
  readonly limits: {
    readonly uploadMaxBytes: number;
    readonly uploadChunkMaxBytes: number;
    readonly uploadIncompleteTtlMs: number;
    readonly trashRetentionMs: number;
  };
  readonly protection: { readonly purgeEnabled: boolean };
  readonly recovery: {
    readonly spoolDirectory: string;
    readonly archiveDirectory: string;
    readonly pgDumpExecutable: string;
    readonly pgRestoreExecutable: string;
    readonly pgDumpPrefixArgs: readonly string[];
    readonly pgRestorePrefixArgs: readonly string[];
    readonly pgCommandConnectionArgs: readonly string[];
    readonly backupIntervalMs: number;
    readonly limits: {
      readonly maxArchiveBytes: number;
      readonly maxMemberBytes: number;
      readonly maxExtractedBytes: number;
      readonly maxEntries: number;
      readonly maxCompressionRatio: number;
      readonly maxManifestBytes: number;
    };
  };
  readonly archive: {
    readonly spoolDirectory: string;
    readonly sevenZipExecutable: string;
    readonly limits: {
      readonly maxArchiveBytes: number;
      readonly maxMemberBytes: number;
      readonly maxExtractedBytes: number;
      readonly maxEntries: number;
      readonly maxCompressionRatio: number;
      readonly uploadChunkBytes: number;
      readonly leaseMs: number;
    };
  };
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

function optionalResolved(value: string, baseDirectory: string): string | undefined {
  return value ? path.resolve(baseDirectory, value) : undefined;
}

function databaseUrlWithPassword(value: string, passwordFile: string | undefined): string {
  if (passwordFile === undefined) return value;
  const secret = fs.readFileSync(passwordFile, "utf8").replace(/[\r\n]+$/, "");
  if (secret.length < 16 || containsControlCharacter(secret)) throw new Error("Invalid Saturn configuration: database password file is invalid");
  const url = new URL(value);
  url.password = secret;
  return url.toString();
}

export function loadEnvironment(
  input: Readonly<Record<string, string | undefined>> = process.env,
  baseDirectory = process.cwd(),
  applyRecovery = true,
): SaturnConfig {
  const parsed = environmentSchema.safeParse(input);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Saturn configuration: ${summary}`);
  }
  const value = parsed.data;
  const passwordFile = optionalResolved(value.STORAGE_PASSWORD_FILE, baseDirectory);
  const privateKeyFile = optionalResolved(value.STORAGE_PRIVATE_KEY_FILE, baseDirectory);
  const databasePasswordFile = optionalResolved(value.DATABASE_PASSWORD_FILE, baseDirectory);
  const gryphonServiceTokenFile = optionalResolved(value.GRYPHON_SERVICE_TOKEN_FILE, baseDirectory);
  const kernelTokenFile = optionalResolved(value.KERNEL_TOKEN_FILE, baseDirectory);
  const config: SaturnConfig = {
    environment: value.NODE_ENV,
    publicOrigin: value.PUBLIC_ORIGIN,
    api: { host: value.API_HOST, port: value.API_PORT },
    trustedProxies: value.API_TRUSTED_PROXIES,
    worker: {
      host: value.WORKER_HOST,
      port: value.WORKER_PORT,
      heartbeatIntervalMs: value.WORKER_HEARTBEAT_INTERVAL_MS,
      staleAfterMs: value.WORKER_STALE_AFTER_MS,
      reconciliationIntervalMs: value.RECONCILIATION_INTERVAL_MS,
    },
    databaseUrl: databaseUrlWithPassword(value.DATABASE_URL, databasePasswordFile),
    ...(databasePasswordFile === undefined ? {} : { databasePasswordFile }),
    ownerBootstrapTokenFile: path.resolve(baseDirectory, value.OWNER_BOOTSTRAP_TOKEN_FILE),
    kernel: {
      ...(value.KERNEL_URL === "" ? {} : { urlSeed: new URL(value.KERNEL_URL).toString() }),
      ...(kernelTokenFile === undefined ? {} : { tokenFile: kernelTokenFile }),
      timeoutMs: value.KERNEL_TIMEOUT_MS,
    },
    auth: {
      pepperFile: path.resolve(baseDirectory, value.AUTH_PEPPER_FILE),
      sessionIdleTtlMs: value.AUTH_SESSION_IDLE_TTL_MS,
      sessionAbsoluteTtlMs: value.AUTH_SESSION_ABSOLUTE_TTL_MS,
      reauthTtlMs: value.AUTH_REAUTH_TTL_MS,
      failureLimit: value.AUTH_FAILURE_LIMIT,
      failureWindowMs: value.AUTH_FAILURE_WINDOW_MS,
    },
    drop: {
      pepperFile: path.resolve(baseDirectory, value.DROP_PEPPER_FILE),
      codeTtlMs: value.DROP_CODE_TTL_MS,
      sessionTtlMs: value.DROP_SESSION_TTL_MS,
      maxFiles: value.DROP_MAX_FILES,
      maxBytes: value.DROP_MAX_BYTES,
      bufferDirectory: path.resolve(baseDirectory, value.DROP_BUFFER_DIRECTORY),
      bufferMaxBytes: value.DROP_BUFFER_MAX_BYTES,
      bufferMinFreeBytes: value.DROP_BUFFER_MIN_FREE_BYTES,
      bufferWarningRatio: value.DROP_BUFFER_WARNING_RATIO,
      bufferCriticalRatio: value.DROP_BUFFER_CRITICAL_RATIO,
      bufferRefusalRatio: value.DROP_BUFFER_REFUSAL_RATIO,
      drainWorkers: value.DROP_DRAIN_WORKERS,
      drainIntervalMs: value.DROP_DRAIN_INTERVAL_MS,
      continuationTtlMs: value.DROP_CONTINUATION_TTL_MS,
      failureLimit: value.DROP_FAILURE_LIMIT,
      globalFailureLimit: value.DROP_GLOBAL_FAILURE_LIMIT,
      failureWindowMs: value.DROP_FAILURE_WINDOW_MS,
    },
    gryphon: {
      enabled: value.GRYPHON_ENABLED,
      ...(gryphonServiceTokenFile === undefined ? {} : { serviceTokenFile: gryphonServiceTokenFile }),
      socketPath: path.resolve(value.GRYPHON_SOCKET_PATH),
      adapterUrl: value.GRYPHON_ADAPTER_URL,
      timeoutMs: value.GRYPHON_TIMEOUT_MS,
    },
    share: {
      enabled: value.SHARE_ENABLED,
      pepperFile: path.resolve(baseDirectory, value.SHARE_PEPPER_FILE),
      defaultExpiryMs: value.SHARE_DEFAULT_EXPIRY_MS,
      maxExpiryMs: value.SHARE_MAX_EXPIRY_MS,
      sessionTtlMs: value.SHARE_SESSION_TTL_MS,
      passwordFailureLimit: value.SHARE_PASSWORD_FAILURE_LIMIT,
      passwordFailureWindowMs: value.SHARE_PASSWORD_FAILURE_WINDOW_MS,
      packageMaxFiles: value.SHARE_PACKAGE_MAX_FILES,
      packageMaxBytes: value.SHARE_PACKAGE_MAX_BYTES,
      packageMaxDurationMs: value.SHARE_PACKAGE_MAX_DURATION_MS,
      streamRevalidateBytes: value.SHARE_STREAM_REVALIDATE_BYTES,
    },
    device: {
      enabled: value.WEBDAV_ENABLED,
      pepperFile: path.resolve(baseDirectory, value.DEVICE_PEPPER_FILE),
      propfindMaxItems: value.WEBDAV_PROPFIND_MAX_ITEMS,
      deleteMaxItems: value.DEVICE_DELETE_MAX_ITEMS,
      deleteWindowMs: value.DEVICE_DELETE_WINDOW_MS,
    },
    backupIngest: {
      enabled: value.BACKUP_INGEST_ENABLED,
      pepperFile: path.resolve(baseDirectory, value.BACKUP_PEPPER_FILE),
      trustClientCertificateHeader: value.BACKUP_TRUST_CLIENT_CERT_HEADER,
      tokenRotationGraceMs: value.BACKUP_TOKEN_ROTATION_GRACE_MS,
      requireEncryption: value.BACKUP_REQUIRE_ENCRYPTION,
      maxRunBytes: value.BACKUP_MAX_RUN_BYTES,
      dailyQuotaBytes: value.BACKUP_DAILY_QUOTA_BYTES,
      storedQuotaBytes: value.BACKUP_STORED_QUOTA_BYTES,
      maxConcurrentRuns: value.BACKUP_MAX_CONCURRENT_RUNS,
      freshnessSlaMs: value.BACKUP_FRESHNESS_SLA_MS,
      retention: { daily: value.BACKUP_RETENTION_DAILY, weekly: value.BACKUP_RETENTION_WEEKLY, monthly: value.BACKUP_RETENTION_MONTHLY, yearly: value.BACKUP_RETENTION_YEARLY },
    },
    laboratory: {
      enabled: value.LABORATORY_ENABLED,
      publicEnabled: value.LABORATORY_PUBLIC_ENABLED,
      pepperFile: path.resolve(baseDirectory, value.LABORATORY_PEPPER_FILE),
      tokenRotationGraceMs: value.LABORATORY_TOKEN_ROTATION_GRACE_MS,
      maxConcurrentPublicStreams: value.LABORATORY_MAX_CONCURRENT_PUBLIC_STREAMS,
    },
    storage: {
      host: value.STORAGE_HOST,
      port: value.STORAGE_PORT,
      username: value.STORAGE_USER,
      root: value.STORAGE_ROOT.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""),
      hostFingerprint: value.STORAGE_HOST_FINGERPRINT,
      authMode: value.STORAGE_AUTH_MODE,
      ...(passwordFile === undefined ? {} : { passwordFile }),
      ...(privateKeyFile === undefined ? {} : { privateKeyFile }),
      operationTimeoutMs: value.STORAGE_OPERATION_TIMEOUT_MS,
      healthTimeoutMs: value.STORAGE_HEALTH_TIMEOUT_MS,
      maxConnections: value.STORAGE_MAX_CONNECTIONS,
    },
    storageRuntimeConfigDirectory: path.resolve(baseDirectory, value.STORAGE_RUNTIME_CONFIG_DIR),
    limits: {
      uploadMaxBytes: value.UPLOAD_MAX_BYTES,
      uploadChunkMaxBytes: value.UPLOAD_CHUNK_MAX_BYTES,
      uploadIncompleteTtlMs: value.UPLOAD_INCOMPLETE_TTL_MS,
      trashRetentionMs: value.TRASH_RETENTION_MS,
    },
    protection: { purgeEnabled: value.PURGE_ENABLED },
    recovery: {
      spoolDirectory: path.resolve(baseDirectory, value.RECOVERY_SPOOL_DIR),
      archiveDirectory: path.resolve(baseDirectory, value.RECOVERY_ARCHIVE_DIR),
      pgDumpExecutable: value.PG_DUMP_BIN,
      pgRestoreExecutable: value.PG_RESTORE_BIN,
      pgDumpPrefixArgs: value.PG_DUMP_PREFIX_ARGS,
      pgRestorePrefixArgs: value.PG_RESTORE_PREFIX_ARGS,
      pgCommandConnectionArgs: value.PG_COMMAND_CONNECTION_ARGS,
      backupIntervalMs: value.RECOVERY_BACKUP_INTERVAL_MS,
      limits: {
        maxArchiveBytes: value.RECOVERY_MAX_ARCHIVE_BYTES,
        maxMemberBytes: value.RECOVERY_MAX_MEMBER_BYTES,
        maxExtractedBytes: value.RECOVERY_MAX_EXTRACTED_BYTES,
        maxEntries: value.RECOVERY_MAX_ENTRIES,
        maxCompressionRatio: value.RECOVERY_MAX_COMPRESSION_RATIO,
        maxManifestBytes: value.RECOVERY_MAX_MANIFEST_BYTES,
      },
    },
    archive: {
      spoolDirectory: path.resolve(baseDirectory, value.ARCHIVE_SPOOL_DIR),
      sevenZipExecutable: value.ARCHIVE_7Z_BIN,
      limits: {
        maxArchiveBytes: value.ARCHIVE_MAX_ARCHIVE_BYTES,
        maxMemberBytes: value.ARCHIVE_MAX_MEMBER_BYTES,
        maxExtractedBytes: value.ARCHIVE_MAX_EXTRACTED_BYTES,
        maxEntries: value.ARCHIVE_MAX_ENTRIES,
        maxCompressionRatio: value.ARCHIVE_MAX_COMPRESSION_RATIO,
        uploadChunkBytes: value.UPLOAD_CHUNK_MAX_BYTES,
        leaseMs: value.ARCHIVE_JOB_LEASE_MS,
      },
    },
    readinessRequireStorage: value.READINESS_REQUIRE_STORAGE,
    readinessTimeoutMs: value.READINESS_TIMEOUT_MS,
    logLevel: value.LOG_LEVEL,
  };
  if (applyRecovery) {
    const filename = recoveryConfigurationPath(config);
    if (fs.existsSync(filename)) {
      if (fs.statSync(filename).size > 65_536) throw new Error("Recovered configuration exceeds the size limit");
      const recovered: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
      return loadEnvironment({ ...input, ...recoveredConfigurationEnvironment(recovered, config) }, baseDirectory, false);
    }
  }
  return config;
}

export function recoveryConfigurationPath(config: SaturnConfig): string {
  return path.join(config.storageRuntimeConfigDirectory, "public-recovery.json");
}

/** Local credentials, executable paths, bind addresses and deployment mode stay on the target host. */
export function recoveredConfigurationEnvironment(value: unknown, config: SaturnConfig): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (source: unknown, expected: unknown, segments: string[]): void => {
    const key = segments.join(".");
    if (typeof expected === "object" && expected !== null) {
      if (typeof source !== "object" || source === null || Array.isArray(source)) throw new Error(`Invalid recovery configuration: ${key}`);
      const record = source as Record<string, unknown>;
      const template = expected as Record<string, unknown>;
      for (const name of Object.keys(record)) if (!Object.hasOwn(template, name)) throw new Error(`Unknown recovery configuration: ${key}.${name}`);
      for (const [name, item] of Object.entries(template)) visit(record[name], item, [...segments, name]);
      return;
    }
    if (typeof source !== typeof expected || (typeof source === "number" && !Number.isFinite(source)) || (typeof source === "string" && source.length > 2048))
      throw new Error(`Invalid recovery configuration: ${key}`);
    if (["environment", "api.host", "api.port", "worker.host", "worker.port"].includes(key)) return;
    const environmentKey = recoveryEnvironmentKeys[key];
    if (environmentKey === undefined) throw new Error(`Unsupported recovery configuration: ${key}`);
    result[environmentKey] = String(source);
  };
  visit(value, publicConfig(config), []);
  return result;
}

export function validateRecoveredConfiguration(value: unknown, config: SaturnConfig, input: Readonly<Record<string, string | undefined>> = process.env): SaturnConfig {
  return loadEnvironment({ ...input, ...recoveredConfigurationEnvironment(value, config) }, process.cwd(), false);
}

export function writeRecoveredConfiguration(value: unknown, config: SaturnConfig): void {
  recoveredConfigurationEnvironment(value, config);
  const filename = recoveryConfigurationPath(config);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Both supervised production processes restart after a committed configuration restore. */
export function watchRecoveredConfiguration(config: SaturnConfig, restart: () => Promise<void>): () => void {
  if (config.environment !== "production") return () => undefined;
  const filename = recoveryConfigurationPath(config);
  const initial = fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : null;
  let restarting = false;
  const listener = (): void => {
    const current = fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : null;
    if (!restarting && current !== initial) {
      restarting = true;
      fs.unwatchFile(filename, listener);
      void restart().catch(() => { process.exitCode = 1; });
    }
  };
  fs.watchFile(filename, { persistent: false, interval: 2000 }, listener);
  return () => fs.unwatchFile(filename, listener);
}

export function publicConfig(config: SaturnConfig): Record<string, unknown> {
  return {
    environment: config.environment,
    publicOrigin: config.publicOrigin,
    api: config.api,
    auth: {
      sessionIdleTtlMs: config.auth.sessionIdleTtlMs,
      sessionAbsoluteTtlMs: config.auth.sessionAbsoluteTtlMs,
      reauthTtlMs: config.auth.reauthTtlMs,
      failureLimit: config.auth.failureLimit,
      failureWindowMs: config.auth.failureWindowMs,
    },
    drop: {
      codeTtlMs: config.drop.codeTtlMs,
      sessionTtlMs: config.drop.sessionTtlMs,
      maxFiles: config.drop.maxFiles,
      maxBytes: config.drop.maxBytes,
      bufferMaxBytes: config.drop.bufferMaxBytes,
      bufferMinFreeBytes: config.drop.bufferMinFreeBytes,
      bufferWarningRatio: config.drop.bufferWarningRatio,
      bufferCriticalRatio: config.drop.bufferCriticalRatio,
      bufferRefusalRatio: config.drop.bufferRefusalRatio,
      drainWorkers: config.drop.drainWorkers,
      drainIntervalMs: config.drop.drainIntervalMs,
      continuationTtlMs: config.drop.continuationTtlMs,
      failureLimit: config.drop.failureLimit,
      globalFailureLimit: config.drop.globalFailureLimit,
      failureWindowMs: config.drop.failureWindowMs,
    },
    gryphon: { enabled: config.gryphon.enabled, timeoutMs: config.gryphon.timeoutMs },
    share: {
      enabled: config.share.enabled,
      defaultExpiryMs: config.share.defaultExpiryMs,
      maxExpiryMs: config.share.maxExpiryMs,
      sessionTtlMs: config.share.sessionTtlMs,
      passwordFailureLimit: config.share.passwordFailureLimit,
      passwordFailureWindowMs: config.share.passwordFailureWindowMs,
      packageMaxFiles: config.share.packageMaxFiles,
      packageMaxBytes: config.share.packageMaxBytes,
      packageMaxDurationMs: config.share.packageMaxDurationMs,
      streamRevalidateBytes: config.share.streamRevalidateBytes,
    },
    device: {
      enabled: config.device.enabled,
      propfindMaxItems: config.device.propfindMaxItems,
      deleteMaxItems: config.device.deleteMaxItems,
      deleteWindowMs: config.device.deleteWindowMs,
    },
    backupIngest: {
      enabled: config.backupIngest.enabled,
      trustClientCertificateHeader: config.backupIngest.trustClientCertificateHeader,
      tokenRotationGraceMs: config.backupIngest.tokenRotationGraceMs,
      requireEncryption: config.backupIngest.requireEncryption,
      maxRunBytes: config.backupIngest.maxRunBytes,
      dailyQuotaBytes: config.backupIngest.dailyQuotaBytes,
      storedQuotaBytes: config.backupIngest.storedQuotaBytes,
      maxConcurrentRuns: config.backupIngest.maxConcurrentRuns,
      freshnessSlaMs: config.backupIngest.freshnessSlaMs,
      retention: config.backupIngest.retention,
    },
    laboratory: {
      enabled: config.laboratory.enabled,
      publicEnabled: config.laboratory.publicEnabled,
      tokenRotationGraceMs: config.laboratory.tokenRotationGraceMs,
      maxConcurrentPublicStreams: config.laboratory.maxConcurrentPublicStreams,
    },
    worker: config.worker,
    storage: {
      host: config.storage.host,
      port: config.storage.port,
      username: config.storage.username,
      root: config.storage.root,
      hostFingerprint: config.storage.hostFingerprint,
      authMode: config.storage.authMode,
      operationTimeoutMs: config.storage.operationTimeoutMs,
      healthTimeoutMs: config.storage.healthTimeoutMs,
      maxConnections: config.storage.maxConnections,
    },
    limits: config.limits,
    protection: config.protection,
    recovery: {
      backupIntervalMs: config.recovery.backupIntervalMs,
      limits: config.recovery.limits,
    },
    archive: { limits: config.archive.limits },
    readinessRequireStorage: config.readinessRequireStorage,
    readinessTimeoutMs: config.readinessTimeoutMs,
    logLevel: config.logLevel,
  };
}
