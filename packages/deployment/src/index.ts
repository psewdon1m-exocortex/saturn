import { createHash, sign, verify } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { loadEnvironment, type SaturnConfig } from "@saturn/config";
import { parse } from "dotenv";

const digest = /^sha256:[a-f0-9]{64}$/;
const immutableImage = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const placeholder = /change[-_ ]?me|replace|example|invalid|vault-dev-only/i;
const secretFields = [
  "DATABASE_PASSWORD_FILE", "OWNER_BOOTSTRAP_TOKEN_FILE", "AUTH_PEPPER_FILE", "DROP_PEPPER_FILE",
  "SHARE_PEPPER_FILE", "DEVICE_PEPPER_FILE", "BACKUP_PEPPER_FILE", "LABORATORY_PEPPER_FILE",
  "STORAGE_PRIVATE_KEY_FILE",
] as const;

export interface ProductionValidationResult {
  readonly state: "valid";
  readonly releaseVersion: string;
  readonly domain: string;
  readonly storageIdentity: string;
  readonly laboratoryExposure: "private" | "public_approved";
  readonly rpoSeconds: number;
  readonly rtoSeconds: number;
  readonly secretFiles: number;
  readonly immutableImages: 2;
  readonly config: SaturnConfig;
}

export interface ReleasePayload {
  readonly schema: "vault.release-manifest.v1";
  readonly componentRole: "vault-gateway";
  readonly version: string;
  readonly sourceRevision: string;
  readonly createdAt: string;
  readonly databaseSchemaGeneration: number;
  readonly minimumInstallerVersion: string;
  readonly bundle: { readonly url: string; readonly sha256: string; readonly bytes: number };
  readonly sbom: { readonly sha256: string; readonly format: "pnpm-licenses-json" };
  readonly images: { readonly app: string; readonly web: string };
}

export interface SignedReleaseManifest {
  readonly payload: ReleasePayload;
  readonly signature: { readonly algorithm: "Ed25519"; readonly value: string };
}

export function parseEnvironmentFile(source: string): Record<string, string> {
  return parse(source);
}

function required(input: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = input[name]?.trim();
  if (!value || placeholder.test(value)) throw new Error(`${name} is missing or contains a placeholder`);
  return value;
}

function positiveInteger(input: Readonly<Record<string, string | undefined>>, name: string, maximum: number): number {
  const value = Number(required(input, name));
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} is outside its accepted range`);
  return value;
}

function hostSecretPath(containerPath: string, secretRoot: string): string {
  const normalized = containerPath.replaceAll("\\", "/");
  if (!normalized.startsWith("/run/secrets/") || normalized.slice("/run/secrets/".length).includes("/")) {
    throw new Error("Production secret paths must be direct children of /run/secrets");
  }
  return path.join(secretRoot, path.posix.basename(normalized));
}

function inspectSecret(file: string, privateKey: boolean): string {
  const attributes = fs.lstatSync(file);
  if (!attributes.isFile() || attributes.isSymbolicLink()) throw new Error("Production secret must be a regular non-symlink file");
  if (process.platform !== "win32" && (attributes.mode & 0o077) !== 0) throw new Error("Production secret file is readable by group or others");
  const value = fs.readFileSync(file, "utf8").replace(/[\r\n]+$/, "");
  if (privateKey) {
    if (!value.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----") || !value.includes("-----END OPENSSH PRIVATE KEY-----")) {
      throw new Error("Storage private key file is not an OpenSSH private key");
    }
  } else if (value.length < 32 || /[\r\n]/.test(value)) throw new Error("Production secret is too short or malformed");
  return createHash("sha256").update(value).digest("hex");
}

export function validateProductionDeployment(
  input: Readonly<Record<string, string | undefined>>,
  baseDirectory = process.cwd(),
): ProductionValidationResult {
  if (input.NODE_ENV !== "production") throw new Error("NODE_ENV must be production");
  if (required(input, "VAULT_DEPLOYMENT_ENVIRONMENT") !== "production") throw new Error("Deployment environment must be production");
  if (required(input, "VAULT_STORAGE_ENVIRONMENT") !== "production") throw new Error("Storage environment must be production");
  const profile = input.VAULT_VALIDATION_PROFILE === "verification" ? "verification" : "production";
  const secretRoot = path.resolve(required(input, "VAULT_SECRET_ROOT"));
  if (!path.isAbsolute(secretRoot)) throw new Error("VAULT_SECRET_ROOT must be absolute");
  if (profile === "production" && (secretRoot === baseDirectory || secretRoot.startsWith(`${path.resolve(baseDirectory)}${path.sep}`))) {
    throw new Error("Production secrets must live outside the application/release directory");
  }
  const mapped: Record<string, string | undefined> = { ...input };
  const hashes = new Set<string>();
  for (const field of secretFields) {
    const containerPath = required(input, field);
    const file = hostSecretPath(containerPath, secretRoot);
    mapped[field] = file;
    const valueHash = inspectSecret(file, field === "STORAGE_PRIVATE_KEY_FILE");
    if (hashes.has(valueHash)) throw new Error("Production secret files must contain distinct values");
    hashes.add(valueHash);
  }
  if (input.TELEGRAM_ENABLED === "true") {
    for (const field of ["TELEGRAM_BOT_TOKEN_FILE", "TELEGRAM_WEBHOOK_SECRET_FILE"] as const) {
      const file = hostSecretPath(required(input, field), secretRoot); mapped[field] = file;
      const valueHash = inspectSecret(file, false); if (hashes.has(valueHash)) throw new Error("Production secret files must contain distinct values"); hashes.add(valueHash);
    }
  }
  const config = loadEnvironment(mapped, baseDirectory);
  const origin = new URL(config.publicOrigin); const domain = required(input, "VAULT_DOMAIN").toLowerCase();
  if (origin.protocol !== "https:" || origin.hostname.toLowerCase() !== domain || origin.port) throw new Error("PUBLIC_ORIGIN must be canonical HTTPS for VAULT_DOMAIN");
  if (profile === "production" && (domain === "localhost" || net.isIP(domain) !== 0 || domain.endsWith(".invalid") || domain.endsWith(".test"))) throw new Error("Production domain is not publicly valid");
  const releaseVersion = required(input, "VAULT_RELEASE_VERSION"); if (!semanticVersion.test(releaseVersion)) throw new Error("VAULT_RELEASE_VERSION must be stable semantic versioning");
  for (const field of ["VAULT_APP_IMAGE", "VAULT_WEB_IMAGE"] as const) if (!immutableImage.test(required(input, field))) throw new Error(`${field} must be an immutable image reference`);
  const storageIdentity = `${config.storage.username}@${config.storage.host}#${config.storage.hostFingerprint}`;
  if (config.storage.username === required(input, "VAULT_DEV_STORAGE_USER") || config.storage.hostFingerprint === required(input, "VAULT_DEV_STORAGE_FINGERPRINT")) throw new Error("Production reuses the declared DEV storage identity");
  const secondCopy = required(input, "VAULT_SECOND_COPY_ID"); if (secondCopy === storageIdentity || secondCopy === config.storage.host) throw new Error("Second copy must be independent from primary storage");
  const laboratoryExposure = required(input, "VAULT_PUBLIC_LABORATORY_DECISION");
  if (laboratoryExposure !== "private" && laboratoryExposure !== "public_approved") throw new Error("Laboratory exposure decision must be explicit");
  if ((laboratoryExposure === "public_approved") !== config.laboratory.publicEnabled) throw new Error("Laboratory decision and LABORATORY_PUBLIC_ENABLED do not match");
  return { state: "valid", releaseVersion, domain, storageIdentity, laboratoryExposure,
    rpoSeconds: positiveInteger(input, "VAULT_RPO_SECONDS", 31_536_000), rtoSeconds: positiveInteger(input, "VAULT_RTO_SECONDS", 31_536_000),
    secretFiles: hashes.size, immutableImages: 2, config };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function validateReleasePayload(value: unknown): asserts value is ReleasePayload {
  if (typeof value !== "object" || value === null) throw new Error("Release manifest payload is invalid");
  const payload = value as Partial<ReleasePayload>;
  if (payload.schema !== "vault.release-manifest.v1" || payload.componentRole !== "vault-gateway") throw new Error("Release manifest identity is invalid");
  if (typeof payload.version !== "string" || typeof payload.minimumInstallerVersion !== "string" || !semanticVersion.test(payload.version) || !semanticVersion.test(payload.minimumInstallerVersion)) throw new Error("Release manifest version is invalid");
  if (typeof payload.sourceRevision !== "string" || !/^[a-f0-9]{40,64}$/.test(payload.sourceRevision) || !Number.isSafeInteger(payload.databaseSchemaGeneration) || (payload.databaseSchemaGeneration ?? 0) < 1) throw new Error("Release provenance is invalid");
  if (payload.bundle === undefined || payload.sbom === undefined || payload.images === undefined) throw new Error("Release artifact contract is incomplete");
  if (typeof payload.bundle.sha256 !== "string" || typeof payload.bundle.bytes !== "number" || typeof payload.sbom.sha256 !== "string" || !digest.test(payload.bundle.sha256) || payload.bundle.bytes < 1 || !digest.test(payload.sbom.sha256)) throw new Error("Release artifact digest is invalid");
  if ((payload.sbom as { readonly format?: unknown }).format !== "pnpm-licenses-json") throw new Error("Release SBOM format is invalid");
  if (typeof payload.bundle.url !== "string") throw new Error("Release bundle URL is invalid");
  const bundleUrl = new URL(payload.bundle.url); if (bundleUrl.protocol !== "https:") throw new Error("Release bundle URL must use HTTPS");
  if (typeof payload.images.app !== "string" || typeof payload.images.web !== "string" || !immutableImage.test(payload.images.app) || !immutableImage.test(payload.images.web)) throw new Error("Release image reference is not immutable");
  if (typeof payload.createdAt !== "string" || !Number.isFinite(Date.parse(payload.createdAt))) throw new Error("Release creation time is invalid");
}

export function signReleaseManifest(payload: ReleasePayload, privateKeyPem: string): SignedReleaseManifest {
  validateReleasePayload(payload);
  const signature = sign(null, Buffer.from(canonical(payload)), privateKeyPem).toString("base64");
  return { payload, signature: { algorithm: "Ed25519", value: signature } };
}

export function verifyReleaseManifest(value: unknown, publicKeyPem: string): ReleasePayload {
  if (typeof value !== "object" || value === null) throw new Error("Signed release manifest is invalid");
  const manifest = value as { readonly payload?: unknown; readonly signature?: { readonly algorithm?: unknown; readonly value?: unknown } };
  validateReleasePayload(manifest.payload);
  if (manifest.signature?.algorithm !== "Ed25519" || typeof manifest.signature.value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.signature.value)) throw new Error("Release signature encoding is invalid");
  if (!verify(null, Buffer.from(canonical(manifest.payload)), publicKeyPem, Buffer.from(manifest.signature.value, "base64"))) throw new Error("Release manifest signature is invalid");
  return manifest.payload;
}
