import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

const source=fs.readFileSync(new URL('./install.sh',import.meta.url),'utf8');
const body=source.match(/install_release\(\) \{\n([\s\S]*?)\n\}\n\nstatus\(\)/)?.[1];
assert.ok(body,'actual install_release body');
for(const scenario of ['fresh','existing','stop-fails','writers-remain','migration-fails']) {
 test('installation writer/migration order: '+scenario,()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'saturn-install-order-'));
  try {
   const log=path.join(dir,'calls');
   fs.writeFileSync(path.join(dir,'config'),'fixture');
   fs.mkdirSync(path.join(dir,'updater'));
   fs.writeFileSync(path.join(dir,'updater','install.sh'),'#!/bin/sh\nexit 0\n',{mode:0o700});
   const script=`set -eu
CONFIG_FILE="$FIXTURE/config"
COMPOSE_FILE="$FIXTURE/compose"
UPDATER_BUNDLE="$FIXTURE/updater"
INSTALL_ROOT="$FIXTURE"
id() { printf '0\\n'; }
die() { printf '%s\\n' "$1" >&2; exit 1; }
verify_updater_bundle() { :; }
prepare_agent_mounts() { :; }
validate() { :; }
get_config() { printf 'fixture\\n'; }
refresh_runtime_secrets() { :; }
bounded_logs() { :; }
updater() { :; }
docker() {
 printf '%s\\n' "$*" >> "$CALLS"
 case "$*" in
  *' stop --timeout 60 web api worker') [ "$SCENARIO" != stop-fails ] || return 1 ;;
  *' ps --status running -q api worker') [ "$SCENARIO" != writers-remain ] || printf 'old-writer-id\\n' ;;
  *' run --rm migrate') [ "$SCENARIO" != migration-fails ] || return 1 ;;
 esac
 return 0
}
install_release() {
${body}
}
install_release
`;
   const file=path.join(dir,'run.sh');fs.writeFileSync(file,script);
   const result=spawnSync('sh',[file],{encoding:'utf8',env:{...process.env,FIXTURE:dir,CALLS:log,SCENARIO:scenario}});
   assert.ifError(result.error);const calls=fs.readFileSync(log,'utf8').trim().split('\n');
   const stop=calls.findIndex(c=>c.includes(' stop --timeout 60 web api worker'));
   const verify=calls.findIndex(c=>c.includes(' ps --status running -q api worker'));
   const migrate=calls.findIndex(c=>c.includes(' run --rm migrate'));
   const start=calls.findIndex(c=>c.includes(' up -d worker api web'));
   assert.ok(stop>=0);
   if(['stop-fails','writers-remain'].includes(scenario)) { assert.notEqual(result.status,0);assert.equal(migrate,-1);assert.equal(start,-1); }
   else { assert.ok(stop<verify&&verify<migrate);if(scenario==='migration-fails'){assert.notEqual(result.status,0);assert.equal(start,-1);}else{assert.equal(result.status,0,result.stderr);assert.ok(start>migrate);} }
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
 });
}
