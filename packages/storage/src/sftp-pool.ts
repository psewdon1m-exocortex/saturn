import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { requireSftpStorage, type SaturnConfig, type SftpStorageConfig } from "@saturn/config";

export interface SftpLease {
  readonly sftp: SFTPWrapper;
  readonly disconnected?: AbortSignal;
  release(broken?: boolean): Promise<void>;
}

interface PooledConnection {
  readonly client: Client;
  readonly sftp: SFTPWrapper;
  healthy: boolean;
  closed: boolean;
  readonly disconnect: AbortController;
}

interface Waiter {
  readonly resolve: (lease: SftpLease) => void;
  readonly reject: (error: Error) => void;
}

const channelDisconnects = new WeakMap<SFTPWrapper,AbortSignal>();
// Mark only errors delivered by an SFTP RPC callback, preserving ssh2's original
// Error/code for callers. A numeric code on a stream/local error is insufficient.
const reusableStatusErrors = new WeakSet<Error>();
const REUSABLE_STATUS_CODES = new Set([1, 2, 3, 4, 8]);

export function canReuseSftpLeaseAfterError(error: unknown, lease: SftpLease): boolean {
  return error instanceof Error && reusableStatusErrors.has(error) && lease.disconnected?.aborted !== true;
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

function withTimeout<T>(label: string, timeoutMs: number, register: (finish: (error?: Error, value?: T) => void) => void, signal?:AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if(signal?.aborted) {reject(new Error("SFTP transport disconnected"));return;}
    let settled = false;
    const finish = (error?: Error, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort",abort);
      if (error === undefined) resolve(value as T);
      else reject(error);
    };
    const timer = setTimeout(() => finish(new Error(`${label} timed out after ${String(timeoutMs)} ms`)), timeoutMs);
    const abort=()=>finish(new Error("SFTP transport disconnected"));
    signal?.addEventListener("abort",abort,{once:true});
    try { register(finish); }
    catch (error) { finish(error instanceof Error ? error : new Error(label)); }
  });
}

async function closeConnection(connection: PooledConnection): Promise<void> {
  connection.healthy = false;
  if (connection.closed) return;
  await closeClient(connection.client);
}
async function closeClient(client:Client):Promise<void>{
  await new Promise<void>((resolve,reject) => {
    let settled = false;
    let forced:NodeJS.Timeout|undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if(forced)clearTimeout(forced);
      resolve();
    };
    const timer = setTimeout(() => {
      client.destroy();
      if(settled)return;
      forced=setTimeout(()=>{if(settled)return;settled=true;client.removeListener("close",finish);reject(new Error("SFTP connection closure unconfirmed"));},2000);
    }, 2_000);
    client.once("close", finish);
    client.end();
  });
}

export class SftpConnectionPool {
  readonly #storage: SftpStorageConfig;
  readonly #idle: PooledConnection[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #clients=new Set<Client>();
  #closing:Promise<void>|undefined;
  #total = 0;
  #closed = false;

  constructor(storage: SaturnConfig["storage"]) {
    this.#storage = requireSftpStorage(storage);
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

  async #connectOnce(deadline: number): Promise<PooledConnection> {
    const client = new Client();
    const authentication = await this.#authentication();
    this.#assertOpen();
    this.#clients.add(client);
    client.once("close",()=>this.#clients.delete(client));
    const remaining = Math.max(1,deadline-Date.now());
    try {
    await withTimeout<undefined>("SSH ready", remaining, (finish) => {
      client.once("ready", () => finish(undefined));
      // ssh2 can emit another transport error while destroying a failed
      // handshake. Keep a listener for that client's entire lifetime.
      client.on("error", (error) => finish(error));
      client.once("end", () => finish(new Error("SSH connection ended before ready")));
      client.once("close", () => finish(new Error("SSH connection closed before ready")));
      client.connect({
        host: this.#storage.host,
        port: this.#storage.port,
        username: this.#storage.username,
        ...authentication,
        hostVerifier: hostVerifier(this.#storage.hostFingerprint),
        readyTimeout: Math.min(remaining, 20_000),
        keepaliveInterval: 10_000,
        // Do not discard a still-pending mutation before its configured RPC
        // deadline. A short outage can otherwise turn a delayed original ACK
        // into an irrecoverable UNKNOWN despite an intact TCP connection.
        keepaliveCountMax: Math.max(3, Math.ceil(this.#storage.operationTimeoutMs / 10_000) + 1),
        algorithms: { serverHostKey: ["ssh-ed25519", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] },
      });
    });
    // SFTP request/response traffic otherwise pays delayed-ACK latency for
    // small final packets, even on the same host.
    client.setNoDelay(true);
    const sftp = await withTimeout<SFTPWrapper>("SFTP channel", Math.max(1, deadline-Date.now()), (finish) => {
      client.sftp((error, channel) => finish(error ?? undefined, channel));
    });
    const connection: PooledConnection = { client, sftp, healthy: true, closed: false, disconnect: new AbortController() };
    channelDisconnects.set(sftp,connection.disconnect.signal);
    const disconnected = () => { connection.healthy = false; connection.disconnect.abort(); };
    client.on("error", disconnected);
    client.on("end", disconnected);
    client.on("close", () => { disconnected(); connection.closed = true; });
    sftp.on("close", disconnected);
    if (this.#closed) { await closeConnection(connection); throw new Error("SFTP pool is closed"); }
    return connection;
    } catch (error) { client.destroy(); throw error; }
  }

  async #connect(): Promise<PooledConnection> {
    const deadline = Date.now()+this.#storage.operationTimeoutMs;
    for (let attempt=0;;attempt++) {
      try { return await this.#connectOnce(deadline); }
      catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "";
        const transient = ["ETIMEDOUT","ECONNRESET","ECONNREFUSED","EPIPE","EAI_AGAIN"].includes(code)
          || (error instanceof Error && /^(Timed out while waiting for handshake|SSH connection ended before ready|SSH ready timed out)/.test(error.message));
        // Retry transport establishment only. No file operation or trust/auth
        // failure is replayed, and both attempts share one original deadline.
        if (!transient || attempt>=1 || this.#closed || Date.now()+100>=deadline) throw error;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
  }

  #lease(connection: PooledConnection): SftpLease {
    let released = false;
    return {
      sftp: connection.sftp,
      disconnected: connection.disconnect.signal,
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

  #assertOpen(): void {
    if (this.#closed) throw new Error("SFTP pool is closed");
  }

  async acquire(signal?: AbortSignal): Promise<SftpLease> {
    if (signal?.aborted) throw new Error("SFTP acquisition was cancelled");
    this.#assertOpen();
    for (let idle = this.#idle.pop(); idle !== undefined; idle = this.#idle.pop()) {
      if (idle.healthy) return this.#lease(idle);
      await closeConnection(idle);
      this.#total -= 1;
      this.#wakeWaiter();
    }
    this.#assertOpen();
    if (this.#total < this.#storage.maxConnections) {
      this.#total += 1;
      try {
        const lease=this.#lease(await this.#connect());
        if(signal?.aborted) {await lease.release(true);throw new Error("SFTP acquisition was cancelled");}
        return lease;
      }
      catch (error) {
        // release above already returned a cancelled connection's capacity.
        if (!(error instanceof Error && error.message === "SFTP acquisition was cancelled")) {this.#total -= 1;this.#wakeWaiter();}
        throw error;
      }
    }
    if (this.#waiters.length >= this.#storage.maxConnections * 16) throw new Error("SFTP waiting queue is full");
    return new Promise((resolve, reject) => {
      let settled = false;
      const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true; clean();
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(error);
      };
      const waiter: Waiter = {
        resolve: lease => { if (settled) { void lease.release().catch(()=>undefined); return; } settled = true; clean(); resolve(lease); },
        reject: fail,
      };
      const abort = () => fail(new Error("SFTP acquisition was cancelled"));
      const timer = setTimeout(() => fail(new Error("SFTP queue wait timed out")), this.#storage.operationTimeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    if(this.#closing)return this.#closing;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error("SFTP pool is closed"));
    this.#idle.splice(0);
    // Includes leased streams and handshakes; idle-only shutdown cannot prove
    // that a fenced writer's old sockets stopped issuing requests.
    this.#closing=(async()=>{
      const outcomes=await Promise.allSettled([...this.#clients].map(closeClient));
      const errors=outcomes.filter((v):v is PromiseRejectedResult=>v.status==='rejected');
      if(errors.length)throw new AggregateError(errors.map(v=>v.reason as unknown),'SFTP shutdown unconfirmed');
    })();
    return this.#closing;
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
    callable.call(sftp, ...args, (error?: Error, value?: T) => {
      if (error instanceof Error && "code" in error && typeof error.code === "number" && REUSABLE_STATUS_CODES.has(error.code)
        && channelDisconnects.get(sftp)?.aborted !== true) reusableStatusErrors.add(error);
      finish(error, value);
    });
  },channelDisconnects.get(sftp));
}
