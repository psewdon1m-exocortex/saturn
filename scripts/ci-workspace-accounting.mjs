import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const states=new Set(['passed','failed','pending','skipped','todo']);
export function accountVitest(report,source){
  assert(report&&Array.isArray(report.testResults),'Missing Vitest result inventory');
  const cases=[],collectionErrors=[],files=new Set();
  for(const file of report.testResults){
    assert(Array.isArray(file.assertionResults),'Missing assertion inventory');
    if(file.status==='failed'&&file.assertionResults.length===0)collectionErrors.push(file.name);
    const origin=source(file.name);
    assert(!files.has(origin.file),'Duplicate test-file collection');files.add(origin.file);
    const occurrences=new Map();
    for(const assertion of file.assertionResults){
      assert(states.has(assertion.status),'Unrecognized assertion status');
      assert(typeof assertion.fullName==='string'&&assertion.fullName.length>0,'Missing case name');
      const status=['skipped','todo'].includes(assertion.status)?'pending':assertion.status;
      // Parameterized tests can legitimately render identical titles (e.g. -1
      // as a number and as a string). Preserve every invocation and its status.
      const occurrence=occurrences.get(assertion.fullName)??0;occurrences.set(assertion.fullName,occurrence+1);
      cases.push({id:digest(origin.file+'\n'+assertion.fullName+'\n'+occurrence),file:origin.file,name:assertion.fullName,occurrence,status,sourceSha256:origin.sha256,
        ...(status==='pending'?{execution:'NOT_RUN',pass:false,inputHints:origin.inputHints,platformConditional:origin.platformConditional}:{}),
        ...(status==='failed'?{failureMessages:assertion.failureMessages??[]}:{}),
      });
    }
  }
  const count=status=>cases.filter(row=>row.status===status).length;
  const counts={passed:count('passed'),failed:count('failed'),pending:count('pending'),total:cases.length};
  assert.equal(counts.total,report.numTotalTests,'Test inventory total mismatch');
  assert.equal(counts.passed,report.numPassedTests,'PASS count mismatch');
  assert.equal(counts.failed,report.numFailedTests,'FAIL count mismatch');
  assert.equal(counts.pending,(report.numPendingTests??0)+(report.numTodoTests??0),'NOT_RUN count mismatch');
  const ordinaryAccepted=report.success===true&&counts.failed===0&&collectionErrors.length===0;
  return {ordinaryAccepted,fullQualificationAccepted:ordinaryAccepted&&counts.pending===0,counts,cases,collectionErrors};
}

export function redactEvidence(value,secrets=[]){
  let text=typeof value==='string'?value:JSON.stringify(value);
  for(const secret of secrets.filter(x=>typeof x==='string'&&x.length>=8).sort((a,b)=>b.length-a.length))text=text.replaceAll(secret,'<redacted>');
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'<redacted-private-key>')
    .replace(/\b(?:Basic|Bearer) [A-Za-z0-9+/_=.~-]+/g,'<redacted-authorization>')
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/g,'<redacted-database-url>');
}

export function collectWorkspaceAccounting(root,reportKey){
  assert(/^[a-zA-Z0-9_-]{1,100}$/.test(reportKey),'Unsafe report key');
  const canonical=fs.realpathSync(root),packages=[],cases=[],collectionErrors=[];
  const source=file=>{
    const absolute=path.resolve(file),relative=path.relative(canonical,absolute);
    assert(relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative),'Foreign test result source');
    const bytes=fs.readFileSync(absolute),text=bytes.toString('utf8');
    return {file:relative.replaceAll(path.sep,'/'),sha256:digest(bytes),
      inputHints:[...new Set([...text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map(match=>match[1]))].sort(),
      platformConditional:/process\.(?:platform|arch)|os\.platform\(/.test(text)};
  };
  for(const parent of ['packages','apps'])for(const entry of fs.readdirSync(path.join(canonical,parent),{withFileTypes:true}).filter(x=>x.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))){
    const directory=path.join(canonical,parent,entry.name),manifest=path.join(directory,'package.json');
    if(!fs.existsSync(manifest))continue;
    const pkg=JSON.parse(fs.readFileSync(manifest,'utf8'));
    if(!pkg.scripts?.test){packages.push({name:pkg.name,status:'NO_TEST_SCRIPT_NOT_A_TEST_PASS'});continue;}
    assert(/\bvitest\s+run\b/.test(pkg.scripts.test),'Review accounting for new test runner: '+pkg.name);
    const report=path.join(directory,'.tmp',reportKey+'.json'),bytes=fs.readFileSync(report);
    const result=accountVitest(JSON.parse(bytes),source);
    packages.push({name:pkg.name,status:result.ordinaryAccepted?'COMMAND_CASES_ACCEPTED':'FAIL',reportSha256:digest(bytes),counts:result.counts});
    cases.push(...result.cases);collectionErrors.push(...result.collectionErrors);
  }
  assert(packages.some(p=>p.counts),'No workspace tests accounted');
  const unique=new Set();for(const row of cases){assert(!unique.has(row.id),'Duplicate case accounting');unique.add(row.id);}
  const ordinaryAccepted=packages.every(p=>p.status!=='FAIL')&&collectionErrors.length===0;
  return {schema:'saturn.workspace-ci-accounting.v1',at:new Date().toISOString(),reportKey,ordinaryAccepted,
    fullQualificationAccepted:ordinaryAccepted&&cases.every(row=>row.status==='passed'),
    counts:{passed:cases.filter(row=>row.status==='passed').length,failed:cases.filter(row=>row.status==='failed').length,pending:cases.filter(row=>row.status==='pending').length,total:cases.length},
    packages,cases,collectionErrors,scope:'Current ordinary CI. NOT_RUN is never PASS; separate source-bound qualification/owner dispositions remain required.'};
}

export function requireFullStage13(report){
  assert.equal(report.schema,'vault.stage-verification.v1');assert.equal(report.stage,13);assert.equal(report.executionScope,'FULL');
  assert.equal(report.fullCiAccepted,true,'Conditional qualification remains open; ordinary CI cannot authorize a release');
  assert.equal(report.quality?.accounting?.fullQualificationAccepted,true,'Missing complete workspace qualification accounting');
  assert.equal(report.runtimeChecksPassed,true);assert.equal(report.closure?.status,'CLOSED');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  assert.equal(process.argv[2],'--require-full');assert.equal(process.argv.length,4);
  requireFullStage13(JSON.parse(fs.readFileSync(process.argv[3],'utf8')));console.log('Complete Stage13 qualification verified');
}
