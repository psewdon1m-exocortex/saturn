import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeOwnerAccessKey} from '../packages/config/dist/index.js';

test('provisions opaque dotenv text as data without executing it or losing whitespace',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'saturn-owner-key-'));
  try {
    const source=path.join(directory,'config'),target=path.join(directory,'owner_access_key');
    for(const value of ['a','  '," x\nключ!? $(never-execute) `literal` # ! ",'x'.repeat(2048)]) {
      await fs.writeFile(source,"OWNER_ACCESS_KEY='"+value+"'\n");
      execFileSync(process.execPath,['scripts/provision-owner-access-key.mjs',source,target],{stdio:['ignore','pipe','pipe']});
      assert.equal(decodeOwnerAccessKey(await fs.readFile(target,'utf8')),value);
      if(process.platform!=='win32') assert.equal((await fs.stat(target)).mode&0o777,0o600);
    }
    await fs.writeFile(source,'OWNER_ACCESS_KEY=\n');
    assert.throws(()=>execFileSync(process.execPath,['scripts/provision-owner-access-key.mjs',source,target],{stdio:['ignore','pipe','pipe']}));
    assert.equal(decodeOwnerAccessKey(await fs.readFile(target,'utf8')),'x'.repeat(2048));
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
