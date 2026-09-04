import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import type { SaturnConfig } from "@saturn/config";
import type { HealthCheckResult } from "@saturn/contracts";
import type { StorageAdapter } from "@saturn/storage";

export function fingerprintForKey(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function createHostVerifier(expectedFingerprint: string): (key: Buffer) => boolean {
  const expected = Buffer.from(expectedFingerprint, "utf8");
  return (key) => {
    const actual = Buffer.from(fingerprintForKey(key), "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

function withTimeout<T>(label: string, timeoutMs: number, action: (done: (error?: Error, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve(value as T);
      else reject(error);
    };
    const timer = setTimeout(() => finish(new Error(`${label} timed out`)), timeoutMs);
    try {
      action(finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(label));
    }
  });
}

async function closeClient(client: Client, timeoutMs = 250): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.destroy();
      finish();
    }, timeoutMs);
    client.once("close", finish);
    client.end();
  });
}

async function loadAuthentication(storage: SaturnConfig["storage"]): Promise<Pick<ConnectConfig, "password" | "privateKey">> {
  if (storage.authMode === "password_file") {
    if (storage.passwordFile === undefined) throw new Error("Storage password file is not configured");
    const password = (await fs.readFile(storage.passwordFile, "utf8")).replace(/[\r\n]+$/, "");
    if (!password || /[\r\n]/.test(password)) throw new Error("Storage password file is invalid");
    return { password };
  }
  if (storage.privateKeyFile === undefined) throw new Error("Storage private key file is not configured");
  return { privateKey: await fs.readFile(storage.privateKeyFile) };
}

export class SftpHealthProbe {
  readonly #storage: SaturnConfig["storage"];

  constructor(storage: SaturnConfig["storage"]) {
    this.#storage = storage;
  }

  async check(): Promise<HealthCheckResult> {
    const started = performance.now();
    const deadline = started + this.#storage.healthTimeoutMs;
    const remaining = (): number => Math.max(1, Math.ceil(deadline - performance.now()));
    const client = new Client();
    try {
      const authentication = await loadAuthentication(this.#storage);
      await withTimeout<undefined>("SSH ready", remaining(), (done) => {
        client.once("ready", () => done(undefined));
        client.on("error", (error) => done(error));
        client.once("end", () => done(new Error("SSH connection ended before ready")));
        client.connect({
          host: this.#storage.host,
          port: this.#storage.port,
          username: this.#storage.username,
          ...authentication,
          hostVerifier: createHostVerifier(this.#storage.hostFingerprint),
          readyTimeout: Math.min(remaining(), 20_000),
          keepaliveInterval: 10_000,
          keepaliveCountMax: 3,
          algorithms: { serverHostKey: ["ssh-ed25519", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] },
        });
      });
      const sftp = await withTimeout<SFTPWrapper>("SFTP channel", remaining(), (done) => {
        client.sftp((error, channel) => done(error ?? undefined, channel));
      });
      await withTimeout<string>("SFTP realpath", remaining(), (done) => {
        sftp.realpath(this.#storage.root, (error, resolved) => done(error ?? undefined, resolved));
      });
      return { state: "pass", latencyMs: performance.now() - started };
    } catch {
      return { state: "fail", latencyMs: performance.now() - started, detail: "storage_unavailable" };
    } finally {
      await closeClient(client);
    }
  }
}

export class AdapterStorageHealthProbe {
  readonly #storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.#storage = storage;
  }

  async check(): Promise<HealthCheckResult> {
    const started = performance.now();
    try {
      const root = await this.#storage.stat("");
      if (root.type !== "directory") throw new Error("storage_root_not_directory");
      return { state: "pass", latencyMs: performance.now() - started };
    } catch {
      return { state: "fail", latencyMs: performance.now() - started, detail: "storage_unavailable" };
    }
  }
}
