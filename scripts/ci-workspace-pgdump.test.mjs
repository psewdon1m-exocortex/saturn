import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const helper=fileURLToPath(new URL('./ci-workspace-pgdump.mjs',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('scoped dump rejects changed authority and foreign database requests before Docker',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'saturn-ci-dump-guards-'));
  try{
    const fixtureFile=path.join(root,'fixture.json'),bindingFile=path.join(root,'binding.json');
    const database='stage3_'+'a'.repeat(32);
    await fs.mkdir(path.join(root,database));
    const bytes=JSON.stringify({databaseUrl:'postgresql://postgres:local-fixture-only@127.0.0.1:54321/postgres',fixtureDirectory:root});
    await fs.writeFile(fixtureFile,bytes);
    const binding=JSON.stringify({fixtureFile,fixtureSha256:hash(bytes)});await fs.writeFile(bindingFile,binding);
    const safe='postgresql://postgres@127.0.0.1:54321/'+database;
    const cases=[
      {sha:'0'.repeat(64),url:safe,expected:/PGdump binding changed/},
      {fixture:path.join(root,'foreign.json'),url:safe,expected:/AssertionError/},
      {url:safe.replace('127.0.0.1','localhost'),expected:/AssertionError/},
      {url:safe.replace(':54321',':54322'),expected:/AssertionError/},
      {url:safe.replace('postgres@','postgres:password@'),expected:/AssertionError/},
      {url:safe.replace(database,'saturn_ci'),expected:/AssertionError/},
      {url:safe+'?sslmode=disable',expected:/AssertionError/},
    ];
    for(const row of cases){
      const result=spawnSync(process.execPath,[helper,bindingFile,row.sha??hash(binding),'--format=custom','--no-owner','--dbname',row.url],{
        encoding:'utf8',windowsHide:true,env:{...process.env,STAGE3_CHAT_A_FIXTURE:row.fixture??fixtureFile,DOCKER_BIN:path.join(root,'MUST_NOT_BE_STARTED')},
      });
      assert.equal(result.status,1);assert.match(result.stderr,row.expected);assert(!result.stderr.includes('Owned PG identity read failed'));
    }
    await fs.appendFile(fixtureFile,' ');
    const changed=spawnSync(process.execPath,[helper,bindingFile,hash(binding),'--format=custom','--no-owner','--dbname',safe],{
      encoding:'utf8',windowsHide:true,env:{...process.env,STAGE3_CHAT_A_FIXTURE:fixtureFile,DOCKER_BIN:path.join(root,'MUST_NOT_BE_STARTED')},
    });
    assert.equal(changed.status,1);assert.match(changed.stderr,/AssertionError/);assert(!changed.stderr.includes('Owned PG identity read failed'));
  }finally{await fs.rm(root,{recursive:true});}
});
