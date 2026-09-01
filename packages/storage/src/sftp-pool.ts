import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import type { SaturnConfig } from "@saturn/config";

export interface SftpLease {
  readonly sftp: SFTPWrapper;
  release(broken?: boolean): Promise<void>;
}

interface PooledConnection {
  readonly client: Client;
  readonly sftp: SFTPWrapper;
  healthy: boolean;
}

interface Waiter {
  readonly resolve: (lease: SftpLease) => void;
  readonly reject: (error: Error) => void;
}

function fingerprintForKey(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function hostVerifier(expectedFingerprint: string): (key: Buffer) => boolean {
  const expected = Buffer.from(expectedFingerprint, "utf8");
  return (key) => {
    const actual = Buffer.from(fingerprintForKey(key), "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

function withTimeout<T>(label: string, timeoutMs: number, register: (finish: (error?: Error, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve(value as T);
      else reject(error);
    };
    const timer = setTimeout(() => finish(new Error(`${label} timed out after ${String(timeoutMs)} ms`)), timeoutMs);
    try { register(finish); }
    catch (error) { finish(error instanceof Error ? error : new Error(label)); }
  });
}

async function closeConnection(connection: PooledConnection): Promise<void> {
  connection.healthy = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => { connection.client.destroy(); finish(); }, 2_000);
    connection.client.once("close", finish);
    connection.client.end();
  });
}

export class SftpConnectionPool {
  readonly #storage: SaturnConfig["storage"];
  readonly #idle: PooledConnection[] = [];
  readonly #waiters: Waiter[] = [];
  #total = 0;
  #closed = false;

  constructor(storage: SaturnConfig["storage"]) {
    this.#storage = storage;
  }

  async #authentication(): Promise<Pick<ConnectConfig, "password" | "privateKey">> {
    if (this.#storage.authMode === "password_file") {
      if (this.#storage.passwordFile === undefined) throw new Error("SFTP password file is not configured");
      const password = (await fs.readFile(this.#storage.passwordFile, "utf8")).replace(/[\r\n]+$/, "");
      if (!password || /[\r\n]/.test(password)) throw new Error("SFTP password file is invalid");
      return { password };
    }
    if (this.#storage.privateKeyFile === undefined) throw new Error("SFTP private key file is not configured");
    return { privateKey: await fs.readFile(this.#storage.privateKeyFile) };
  }

  async #connect(): Promise<PooledConnection> {
    const client = new Client();
    const authentication = await this.#authentication();
    await withTimeout<undefined>("SSH ready", this.#storage.operationTimeoutMs, (finish) => {
      client.once("ready", () => finish(undefined));
      client.once("error", (error) => finish(error));
      client.once("end", () => finish(new Error("SSH connection ended before ready")));
      client.connect({
        host: this.#storage.host,
        port: this.#storage.port,
        username: this.#storage.username,
        ...authentication,
        hostVerifier: hostVerifier(this.#storage.hostFingerprint),
        readyTimeout: Math.min(this.#storage.operationTimeoutMs, 20_000),
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        algorithms: { serverHostKey: ["ssh-ed25519", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] },
      });
    });
    const sftp = await withTimeout<SFTPWrapper>("SFTP channel", this.#storage.operationTimeoutMs, (finish) => {
      client.sftp((error, channel) => finish(error ?? undefined, channel));
    });
    const connection: PooledConnection = { client, sftp, healthy: true };
    client.on("error", () => { connection.healthy = false; });
    client.on("end", () => { connection.healthy = false; });
    return connection;
  }

  #lease(connection: PooledConnection): SftpLease {
    let released = false;
    return {
      sftp: connection.sftp,
      release: async (broken = false) => {
        if (released) return;
        released = true;
        if (this.#closed || broken || !connection.healthy) {
          await closeConnection(connection);
          this.#total -= 1;
          this.#wakeWaiter();
          return;
        }
        const waiter = this.#waiters.shift();
        if (waiter === undefined) this.#idle.push(connection);
        else waiter.resolve(this.#lease(connection));
      },
    };
  }

  #wakeWaiter(): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined || this.#closed) return;
    this.#total += 1;
    void this.#connect()
      .then((connection) => waiter.resolve(this.#lease(connection)))
      .catch((error: unknown) => {
        this.#total -= 1;
        waiter.reject(error instanceof Error ? error : new Error("SFTP connection failed"));
        this.#wakeWaiter();
      });
  }

  async acquire(): Promise<SftpLease> {
    if (this.#closed) throw new Error("SFTP pool is closed");
    const idle = this.#idle.pop();
    if (idle !== undefined) return this.#lease(idle);
    if (this.#total < this.#storage.maxConnections) {
      this.#total += 1;
      try { return this.#lease(await this.#connect()); }
      catch (error) { this.#total -= 1; throw error; }
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error("SFTP pool is closed"));
    const idle = this.#idle.splice(0);
    await Promise.allSettled(idle.map(closeConnection));
    this.#total -= idle.length;
  }
}

export function callSftp<T>(
  sftp: SFTPWrapper,
  method: string,
  timeoutMs: number,
  ...args: readonly unknown[]
): Promise<T> {
  return withTimeout<T>(`SFTP ${method}`, timeoutMs, (finish) => {
    const target = sftp as unknown as Record<string, (...parameters: unknown[]) => void>;
    const callable = target[method];
    if (callable === undefined) {
      finish(new Error(`SFTP method is unavailable: ${method}`));
      return;
    }
    callable.call(sftp, ...args, (error?: Error, value?: T) => finish(error, value));
  });
}
