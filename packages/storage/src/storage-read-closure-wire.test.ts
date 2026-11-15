import { requireTestValue } from "../../contracts/src/test-support.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Server, utils, type Connection } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SftpStorageAdapter } from "./sftp-storage.adapter.js";

const key = utils.generateKeyPairSync("ed25519");
const parsed = utils.parseKey(key.private);
if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Test host key unavailable");
const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
const content = Buffer.from("byte-exact real SSH/SFTP payload");
let server: Server, storage: SftpStorageAdapter, root: string, opens = 0, holdReads = false;
let pendingClose: Array<(failed?: boolean) => void> = [];
const connections = new Set<Connection>();
const storages = new Set<SftpStorageAdapter>();
beforeEach(async () => {
  opens = 0; holdReads = false; pendingClose = [];
  root = await fs.mkdtemp(path.join(os.tmpdir(), "d04-sftp-wire-"));
  const password = randomUUID(); await fs.writeFile(path.join(root, 'password'), password, { mode: 0o600 });
  server = new Server({ hostKeys: [key.private] }, connection => {
    connections.add(connection); connection.on('error', () => undefined); connection.once('close', () => connections.delete(connection));
    connection.on('authentication', context => context.method === 'password' && context.username === 'd04' && context.password === password ? context.accept() : context.reject());
    connection.on('ready', () => connection.on('session', accept => {
      const session = accept(); session.on('sftp', acceptSftp => {
        const sftp = acceptSftp(); sftp.on('error', () => undefined);
        sftp.on('OPEN', (id) => { opens++; sftp.handle(id, Buffer.from(`handle-${String(opens)}`)); });
        sftp.on('READ', (id, _handle, offset, length) => {
          if (holdReads) return;
          const bytes = content.subarray(offset, offset + length);
          if (bytes.length) sftp.data(id, bytes); else sftp.status(id, utils.sftp.STATUS_CODE.EOF);
        });
        sftp.on('CLOSE', id => pendingClose.push(failed => sftp.status(id, failed ? utils.sftp.STATUS_CODE.FAILURE : utils.sftp.STATUS_CODE.OK)));
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test address unavailable');
  storage = new SftpStorageAdapter({ host: '127.0.0.1', port: address.port, username: 'd04', root: '/owned', hostFingerprint: fingerprint, authMode: 'password_file', passwordFile: path.join(root, 'password'), operationTimeoutMs: 1200, healthTimeoutMs: 1200, maxConnections: 1 }); storages.add(storage);
});
afterEach(async () => {
  await Promise.all([...storages].map(adapter => adapter.close())); storages.clear(); for (const connection of connections) connection.end(); connections.clear();
  await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true });
});

describe('physical read closure over real TCP/SSH/SFTP', () => {
  it.each([false, true])('holds the real connection until CLOSE ACK, full/range=%s', async range => {
    const stream = await storage.openRead('owned.bin', range ? { offset: 2, length: 7 } : {});
    expect(Buffer.concat(await stream.toArray())).toEqual(range ? content.subarray(2, 9) : content);
    await expect.poll(() => pendingClose.length).toBe(1);
    let confirmed = false; void requireTestValue(stream.storageClosed).then(() => { confirmed = true; });
    const second = storage.openRead('second.bin'); await delay(30); expect(opens).toBe(1); expect(confirmed).toBe(false);
    requireTestValue(pendingClose.shift())(); await stream.storageClosed;
    const next = await second; expect(Buffer.concat(await next.toArray())).toEqual(content);
    await expect.poll(() => pendingClose.length).toBe(1); requireTestValue(pendingClose.shift())(); await next.storageClosed;
    expect(opens).toBe(2);
  });
  it.each(['failed-close', 'disconnect', 'stalled-close'])('retains uncertain closure on real server %s', async fault => {
    const stream = await storage.openRead('owned.bin');
    const failed = expect(stream.storageClosed).rejects.toThrow();
    expect(Buffer.concat(await stream.toArray())).toEqual(content); await expect.poll(() => pendingClose.length).toBe(1);
    if (fault === 'failed-close') requireTestValue(pendingClose.shift())(true);
    if (fault === 'disconnect') for (const connection of connections) connection.end();
    await failed;
  });
  it.each(['ack', 'failed-close', 'disconnect', 'stalled-close'].flatMap(close => ['destroy', 'signal'].map(cancel => ({close,cancel}))))('cancels the body promptly, physical result follows real CLOSE $close/$cancel', async ({close,cancel}) => {
    holdReads = true; const abort = new AbortController(); const stream = await storage.openRead('owned.bin', { signal: abort.signal });
    let confirmed = false;
    const result = close === 'ack' ? requireTestValue(stream.storageClosed).then(() => { confirmed = true; }) : expect(stream.storageClosed).rejects.toThrow();
    void result.catch(() => undefined);
    if (cancel === 'signal') abort.abort(); else stream.destroy();
    expect(stream.destroyed).toBe(true); await expect.poll(() => pendingClose.length).toBe(1); expect(confirmed).toBe(false);
    if (close === 'ack') requireTestValue(pendingClose.shift())();
    if (close === 'failed-close') requireTestValue(pendingClose.shift())(true);
    if (close === 'disconnect') for (const connection of connections) connection.end();
    await result;
  });
});
