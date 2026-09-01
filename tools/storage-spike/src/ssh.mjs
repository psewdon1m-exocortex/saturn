import { createHash, timingSafeEqual } from "node:crypto";
import { Client } from "ssh2";

export function fingerprintForKey(key) {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function createHostVerifier(expectedFingerprint) {
  const expected = Buffer.from(expectedFingerprint, "utf8");
  return (key) => {
    const actual = Buffer.from(fingerprintForKey(key), "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

export async function connectSftp(config) {
  const client = new Client();
  const ready = new Promise((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
    client.once("end", () => reject(new Error("SSH connection ended before ready")));
  });

  client.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    hostVerifier: createHostVerifier(config.hostFingerprint),
    readyTimeout: 20_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    algorithms: {
      serverHostKey: ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
    },
  });

  await ready;
  const sftp = await new Promise((resolve, reject) => {
    client.sftp((error, channel) => (error ? reject(error) : resolve(channel)));
  });

  return {
    client,
    sftp,
    close: () => new Promise((resolve) => {
      if (client._sock?.destroyed) {
        resolve();
        return;
      }
      client.once("close", resolve);
      client.end();
    }),
  };
}

export function callSftpWithTimeout(sftp, method, timeoutMs, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error(`SFTP ${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    try {
      sftp[method](...args, finish);
    } catch (error) {
      finish(error);
    }
  });
}

export function callSftp(sftp, method, ...args) {
  return callSftpWithTimeout(sftp, method, 60_000, ...args);
}
