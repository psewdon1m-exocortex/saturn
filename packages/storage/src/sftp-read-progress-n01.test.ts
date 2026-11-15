import { requireTestValue } from "../../contracts/src/test-support.js";
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { SftpStorageAdapter } from './sftp-storage.adapter.js';

const fixture = vi.hoisted(() => ({ remote: {}, release: vi.fn(async () => undefined), disconnected: new AbortController() }));
vi.mock('./sftp-pool.js', async original => ({
  ...await original<object>(),
  SftpConnectionPool: class { async acquire() { return { sftp: fixture.remote, release: fixture.release, disconnected: fixture.disconnected.signal }; } },
}));
const require = createRequire(new URL('../package.json', import.meta.url));
const { SFTP } = require('ssh2/lib/protocol/SFTP.js') as { SFTP: { prototype: {
  createReadStream: (this: object, filename: string, options: object) => Readable;
} } };
type CloseCallback = (error?: Error) => void;
const config = { host: 'fixture.invalid', port: 22, username: 'saturn', root: '/fixture', hostFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', authMode: 'password_file' as const, passwordFile: '/fixture/unused', operationTimeoutMs: 1000, healthTimeoutMs: 1000, maxConnections: 1 };
const totalBytes = 2 * 1024 * 1024;
let opened: (Readable & { storageClosed?: Promise<void> }) | undefined;
let stall = false;
let holdClose = false, closeAcknowledgements: CloseCallback[] = [];
beforeEach(() => {
  stall = false; holdClose = false; closeAcknowledgements = []; opened = undefined; fixture.release.mockClear(); fixture.disconnected = new AbortController();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fixture.remote = {
    open: (_path: string, _flags: string, _mode: number, callback: (error: Error | undefined, handle?: Buffer) => void) => queueMicrotask(() => callback(undefined, Buffer.from('owned-handle'))),
    read: (_handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error: undefined, bytes: number) => void) => {
      if (stall) return;
      const count = Math.min(length, totalBytes - position);
      for (let index = 0; index < count; index++) buffer[offset + index] = (position + index) % 251;
      queueMicrotask(() => callback(undefined, count));
    },
    close: (_handle: Buffer, callback: CloseCallback) => { if (holdClose) closeAcknowledgements.push(callback); else queueMicrotask(() => callback()); },
    createReadStream(filename: string, options: object) { return SFTP.prototype.createReadStream.call(this, filename, options); },
  };
});
afterEach(async () => { opened?.destroy(); for (const callback of closeAcknowledgements.splice(0)) callback(); await tick(); await tick(); vi.useRealTimers(); });

describe('candidate08 SFTP read timeout versus progressing slow recipient', () => {
  it.each([[1000, 65536], [1000, 8192], [30000, 512]])('timeout%i preserves every byte while recipient reads %i bytes every100ms', async (timeout, amount) => {
    opened = await new SftpStorageAdapter({ ...config, operationTimeoutMs: timeout }).openRead('owned');
    let streamError: Error | undefined;
    opened.on('error', error => { streamError = error; });
    let verified = 0;
    for (let step = 0; verified < totalBytes && step < 5000; step++) {
      await tick();
      const chunk = opened.read(Math.min(amount, totalBytes - verified)) as Buffer | null;
      if (chunk) {
        for (let index = 0; index < chunk.length; index++) {
          if (chunk[index] !== (verified + index) % 251) throw new Error('Received byte differs from physical source');
        }
        verified += chunk.length;
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(streamError, `recipient verified${String(verified)}bytes; virtual elapsed${String((step + 1) * 100)}ms`).toBeUndefined();
    }
    expect(verified).toBe(totalBytes);
    opened.resume(); await tick(); await opened.storageClosed;
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('still times out a physical READ which makes no progress', async () => {
    stall = true;
    opened = await new SftpStorageAdapter(config).openRead('owned');
    const failure = expect(opened.storageClosed).rejects.toThrow('SFTP read idle timeout');
    opened.resume(); await tick(); await vi.advanceTimersByTimeAsync(1001); await failure;
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('still bounds a recipient which never consumes its buffered bytes', async () => {
    opened = await new SftpStorageAdapter(config).openRead('owned');
    const failure = expect(opened.storageClosed).rejects.toThrow('SFTP read idle timeout');
    await tick(); await vi.advanceTimersByTimeAsync(1001); await failure;
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('does not prolong physical CLOSE timeout while recipient drains buffered bytes', async () => {
    holdClose = true;
    opened = await new SftpStorageAdapter(config).openRead('owned', { length: 65536 });
    const failure = expect(opened.storageClosed).rejects.toThrow('SFTP read close timeout');
    await tick(); await tick(); expect(closeAcknowledgements).toHaveLength(1);
    for (let step = 0; step < 10; step++) {
      expect((opened.read(512) as Buffer | null)?.length).toBe(512);
      await vi.advanceTimersByTimeAsync(100);
    }
    await failure;
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('does not restart idle timeout after physical CLOSE success while buffered tail drains slowly', async () => {
    opened = await new SftpStorageAdapter(config).openRead('owned', { length: 65536 });
    let streamError: Error | undefined; opened.on('error', error => { streamError = error; });
    await tick(); await tick(); await opened.storageClosed;
    for (let step = 0; step < 128; step++) {
      expect((opened.read(512) as Buffer | null)?.length).toBe(512);
      await vi.advanceTimersByTimeAsync(100);
      expect(streamError).toBeUndefined();
    }
    opened.resume(); await tick();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each(['null', 'zero'])('does not count %s polling as byte progress', async mode => {
    stall = mode === 'null';
    opened = await new SftpStorageAdapter(config).openRead('owned');
    const failure = expect(opened.storageClosed).rejects.toThrow('SFTP read idle timeout');
    await tick();
    for (let step = 0; step < 10; step++) {
      expect(opened.read(mode === 'zero' ? 0 : 512)).toBeNull();
      await vi.advanceTimersByTimeAsync(100);
    }
    await failure;
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('rejects failed physical CLOSE after remote EOF', async () => {
    holdClose = true;
    opened = await new SftpStorageAdapter(config).openRead('owned', { length: 65536 });
    const failure = expect(opened.storageClosed).rejects.toThrow('remote CLOSE failed');
    await tick(); await tick(); expect(closeAcknowledgements).toHaveLength(1);
    requireTestValue(closeAcknowledgements.shift())(new Error('remote CLOSE failed')); await failure; await tick();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['destroy', 'signal'])('propagates %s under backpressure and retains lease until CLOSE acknowledgement', async mode => {
    holdClose = true; const signal = new AbortController();
    opened = await new SftpStorageAdapter(config).openRead('owned', { signal: signal.signal });
    await tick(); await tick(); expect(opened.readableLength).toBeGreaterThan(0);
    if (mode === 'signal') signal.abort(); else opened.destroy();
    await tick(); expect(opened.destroyed).toBe(true); expect(closeAcknowledgements).toHaveLength(1); expect(fixture.release).not.toHaveBeenCalled();
    requireTestValue(closeAcknowledgements.shift())(); await opened.storageClosed; await tick();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(false);
  });
});

it('preserves a slow buffered tail after CLOSE with multiple high-water marks',async()=>{
 const length=768*1024;
 opened=await new SftpStorageAdapter(config).openRead('owned',{length});
 let closed=false,streamError:Error|undefined,verified=0;
 void requireTestValue(opened.storageClosed).then(()=>{closed=true;});opened.on('error',error=>{streamError=error;});
 const expected=Buffer.allocUnsafe(length);for(let i=0;i<length;i++)expected[i]=i%251; const consume=(amount:number)=>{const chunk=requireTestValue(opened).read(Math.min(amount,length-verified)) as Buffer|null;if(chunk){expect(chunk.equals(expected.subarray(verified,verified+chunk.length))).toBe(true);verified+=chunk.length;}};
 const isClosed=():boolean=>closed;
 for(let n=0;!isClosed()&&n<100;n++){await tick();consume(65536);await vi.advanceTimersByTimeAsync(100);expect(streamError).toBeUndefined();}
 expect(closed).toBe(true);expect(verified).toBeLessThan(length);
 for(let n=0;verified<length&&n<2000;n++){await tick();consume(512);await vi.advanceTimersByTimeAsync(100);expect(streamError).toBeUndefined();}
 expect(verified).toBe(length);opened.resume();await tick();expect(fixture.release).toHaveBeenCalledExactlyOnceWith(false);
});


