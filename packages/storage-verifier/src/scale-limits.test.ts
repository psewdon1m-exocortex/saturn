import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {expect,it} from 'vitest';
import {parseHostConfig} from './authority.js';
import {parseStorageVerifyRequest} from '../../contracts/src/storage-verifier.js';

it('large verification keeps explicit size, timeout and active-reader bounds',()=>{
  const rootId=randomUUID(),maximumBytes=String(64*1024**3);
  const config={schema:'saturn.storage-verifier-host.v1',listenHost:'127.0.0.1',port:9443,secretFile:path.resolve('test-private/secret'),registryDirectory:path.resolve('test-private/registry'),maximumActive:4,maximumBytes,roots:[{rootId,backendIdentity:'fixture',directory:path.resolve('test-private/content'),prefixes:['incoming']}]};
  expect(parseHostConfig(config).maximumBytes).toBe(maximumBytes);
  const request={schema:'saturn.storage-verify.v1',requestId:randomUUID(),rootId,backendIdentity:'fixture',backendGeneration:randomUUID(),ownerId:randomUUID(),fencingToken:randomUUID(),operationId:randomUUID(),intentSha256:'a'.repeat(64),contentVersionId:randomUUID(),relativePath:'incoming/large',sizeBytes:maximumBytes,maximumBytes,sha256:'b'.repeat(64),timeoutMs:8192000,requireDurability:'readback'};
  expect(parseStorageVerifyRequest(request).sizeBytes).toBe(maximumBytes);
  for(const invalid of [{...request,maximumBytes:'1073741824'},{...request,timeoutMs:86400001},{...request,sizeBytes:'9007199254740992',maximumBytes:'9007199254740992'}])expect(()=>parseStorageVerifyRequest(invalid)).toThrow('invalid_input');
  expect(()=>parseHostConfig({...config,maximumActive:5})).toThrow('invalid_input');
  expect(()=>parseHostConfig({...config,maximumBytes:'9007199254740992'})).toThrow('invalid_input');
});
